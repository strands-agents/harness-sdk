"""Summarize strategy — replaces oversized content with LLM-generated summaries."""

from __future__ import annotations

import functools
import logging
from typing import TYPE_CHECKING

from ....agent.conversation_manager.compression.pin_message import is_pinned
from ....event_loop.streaming import _record_usage
from ....models._summarize import SummarizeResult
from ....models.model import Model
from ....types.content import ContentBlock, Message, Messages, Role, _ensure_tracking_id
from ....types.tools import ToolResult, ToolResultContent
from ...methods.summarize import _SUMMARIZED_PREFIX, SummarizeConfig, _format_summarized
from ...stash import _format_stash_refs
from ...types import ContextState, is_tool_result_block, is_tool_use_block
from .base import (
    BaseOffloadStrategy,
    OffloadConditions,
    OffloadTarget,
    _build_conditions,
    _collect_removable_with_pair,
    _prepend_content,
    _repair_alternation,
    _resolve_preserve_count,
)

if TYPE_CHECKING:
    from ....agent.agent import Agent
    from ....agent.invocation_context import InvocationContext

logger = logging.getLogger(__name__)


def _compaction_split_index(messages: Messages, preserved_messages: int | float) -> int:
    """Return the index of the first message a ``Model.summarize()`` call keeps verbatim.

    The cut never separates a ``toolUse`` from its ``toolResult``: it moves forward to summarize the pair together,
    or back when the ``toolResult`` is the last message, which the next model call responds to and which is never
    summarized. A one-message prefix is not cut: after a pass it is that pass's summary, and re-summarizing it
    alone frees nothing.

    Args:
        messages: Full conversation history.
        preserved_messages: Count or ratio (between 0 and 1 exclusive) of trailing messages to keep; the last
            message is always kept, so 0 and 1 cut at the same place.

    Returns:
        The split index; messages before it may be summarized. 0 when nothing should be.
    """
    kept = _resolve_preserve_count(len(messages), preserved_messages)
    split = min(len(messages) - kept, len(messages) - 1)
    if split > 0 and _splits_tool_pair(messages, split):
        split = split + 1 if split < len(messages) - 1 else split - 1
    return split if split > 1 else 0


def _recency_split(messages: Messages, preserved_messages: int | float) -> int:
    """Return the cut of a recency-only pass: the compaction cut, moved off the last message."""
    split = _compaction_split_index(messages, preserved_messages)
    if not 0 < split == len(messages) - 1:
        return split
    # Placed on the last message, the summary would end the history, so one message stays.
    return split - (2 if _splits_tool_pair(messages, split - 1) else 1)


def _splits_tool_pair(messages: Messages, index: int) -> bool:
    """Whether a cut before ``messages[index]`` separates a tool result from the tool use before it."""
    has_tool_result = any(is_tool_result_block(block) for block in messages[index]["content"])
    return has_tool_result and any(is_tool_use_block(block) for block in messages[index - 1]["content"])


def _with_tool_pairs(messages: Messages, selected: Messages) -> list[int]:
    """Return the indices of the messages in ``selected`` and their tool-pair partners, in history order."""
    index_map = {id(message): index for index, message in enumerate(messages)}
    pairs = (_collect_removable_with_pair(messages, index_map[id(message)]) for message in selected)
    return sorted({index_map[id(removable)] for pair in pairs for removable in pair})


def _summary_plan(messages: Messages, indices: list[int]) -> tuple[list[int], tuple[int, Role]] | None:
    """Return the indices to summarize and where their summary goes, so no pinned message gains content, or None.

    A summary inside a pinned message would never be summarized again, so each pass would grow that message. The
    summary goes at the first run of selected messages whose kept neighbors leave it a role: joining an unpinned
    neighbor of that role, or standing alone between neighbors of the other role. Every other run is removed only
    when its kept neighbors alternate, so no two kept messages merge; the rest stay in the history. A tool result
    whose tool use is pinned counts as pinned, as ``is_pinned`` defines it.
    """
    runs = _runs(indices)
    slot = _first_slot(messages, runs)
    if slot is None:
        return None
    slot_run, role = slot
    kept = [index for run in runs if run is slot_run or _removable(messages, run) for index in run]
    return kept, (slot_run[0], role)


def _plan_after_message_zero(
    messages: Messages, indices: list[int], compacts: bool
) -> tuple[list[int], tuple[int, Role]] | None:
    """Return ``_summary_plan`` for ``indices``, or for ``indices`` without message 0 when that plan cannot take it.

    Only a server-side compaction of the conversation's start takes message 0: a plan for a model that ``compacts``
    and that is ``_is_compaction_prefix``. Any other summary keeps it verbatim, and a summary that finds no slot
    otherwise can follow it, before a pinned message of the summary's role. A tool result paired with message 0 is
    kept with it. None when no plan finds a slot, when the one message left after message 0 holds an earlier
    summary, or when the plan would summarize only an earlier summary.
    """
    starts_at_zero = indices[:1] == [0]
    plan = _summary_plan(messages, indices) if compacts or not starts_at_zero else None
    takes_message_zero = compacts and plan is not None and _is_compaction_prefix(messages, plan[0])
    if starts_at_zero and not takes_message_zero:
        kept_head = 2 if len(messages) > 1 and _splits_tool_pair(messages, 1) else 1
        rest = [index for index in indices if index >= kept_head]
        # After a pass behind a pinned message, the one message left after message 0 holds that pass's summary.
        lone_summary = len(rest) == 1 and _holds_summary(messages[rest[0]])
        plan = None if not rest or lone_summary else _summary_plan(messages, rest)
    return None if plan is None or _is_lone_summary(messages, plan[0]) else plan


def _is_compaction_prefix(messages: Messages, indices: list[int]) -> bool:
    """Whether ``indices`` is the conversation's start, opening with a user turn and alternating."""
    selected = [messages[index] for index in indices]
    return indices == list(range(len(indices))) and messages[0]["role"] == "user" and _alternates(selected)


def _runs(indices: list[int]) -> list[list[int]]:
    """Split sorted ``indices`` into runs of consecutive indices."""
    runs: list[list[int]] = []
    for index in indices:
        if runs and runs[-1][-1] == index - 1:
            runs[-1].append(index)
        else:
            runs.append([index])
    return runs


def _first_slot(messages: Messages, runs: list[list[int]]) -> tuple[list[int], Role] | None:
    """Return the first run a summary can take the place of, and the summary's role there, or None."""
    for run in runs:
        role = _slot_role(messages, run)
        if role is not None:
            return run, role
    return None


def _removable(messages: Messages, run: list[int]) -> bool:
    """Whether removing ``run`` leaves its kept neighbors alternating, so no two kept messages merge."""
    start, end = run[0], run[-1] + 1
    if end >= len(messages):
        return False
    before_role = messages[start - 1]["role"] if start > 0 else "assistant"
    return before_role != messages[end]["role"]


_OTHER_ROLE: dict[Role, Role] = {"user": "assistant", "assistant": "user"}


def _alternates(messages: Messages) -> bool:
    """Whether no two consecutive ``messages`` share a role."""
    return all(earlier["role"] != later["role"] for earlier, later in zip(messages, messages[1:], strict=False))


def _is_summary(message: Message) -> bool:
    """Whether ``message`` holds only ``[Summarized: ...]`` markers."""
    return all(block.get("text", "").startswith(_SUMMARIZED_PREFIX) for block in message["content"])


def _holds_summary(message: Message) -> bool:
    """Whether ``message`` holds a ``[Summarized: ...]`` marker, alone or joined to its own content."""
    return any(block.get("text", "").startswith(_SUMMARIZED_PREFIX) for block in message["content"])


def _is_lone_summary(messages: Messages, indices: list[int]) -> bool:
    """Whether ``indices`` is one earlier summary, which re-summarizing frees nothing from."""
    return len(indices) == 1 and _is_summary(messages[indices[0]])


def _slot_role(messages: Messages, run: list[int]) -> Role | None:
    """Return the role of a summary in place of ``run``, preferring to follow the message before it, if any fits.

    A role fits when no locked neighbor has it. Between two neighbors of one role only the other role fits, so the
    summary stands alone instead of joining the two neighbors into one message.
    """
    start, end = run[0], run[-1] + 1
    locked = _locked_roles(messages, start, end)
    before: Role | None = messages[start - 1]["role"] if start > 0 else None
    after: Role | None = messages[end]["role"] if end < len(messages) else None
    roles: tuple[Role, ...] = ("user",)
    if before:
        roles = (_OTHER_ROLE[before],) if after == before else (before, _OTHER_ROLE[before])
    return next((role for role in roles if role not in locked), None)


def _locked_roles(messages: Messages, start: int, end: int) -> set[Role]:
    """Return the roles of the locked neighbors of ``messages[start:end]``.

    A neighbor is locked when it is pinned, or when it is message 0 and the run starts at 1.
    """
    locked = [index for index in (start - 1, end) if 0 <= index < len(messages) and is_pinned(messages, index)]
    if start == 1:
        locked.append(0)
    return {messages[index]["role"] for index in locked}


def _place_summary(messages: Messages, indices: list[int], slot: tuple[int, Role], summary: Message) -> bool:
    """Replace the messages at ``indices`` with ``summary`` at ``slot``, or leave ``messages`` unchanged.

    A text summary takes the slot's role. When a kept neighbor has that role, the summary joins it, keeping that
    message's tracking id and metadata, and stash refs to its blocks resolve; otherwise it stands alone.

    A summary holding other content, such as an override's provider-native compaction block, is placed verbatim:
    its own message with its own role, never joined with another. It fits only between kept neighbors of the other
    role, so it must take the role of the last message it summarizes when the kept messages alternate; the provider
    that returned it decides whether it may open the history. When it does not fit, ``messages`` is left unchanged.

    Returns:
        Whether the summary was placed.
    """
    start, role = slot
    removed = set(indices)
    kept = [message for index, message in enumerate(messages) if index not in removed]
    position = start - sum(1 for index in indices if index < start)
    if _is_text(summary):
        _join_or_insert(kept, position, role, summary)
    elif _alternates_at(kept, position, summary["role"]):
        placed = summary.copy()
        _ensure_tracking_id(placed)
        kept.insert(position, placed)
    else:
        return False
    _repair_alternation(kept)
    messages[:] = kept
    return True


def _is_text(summary: Message) -> bool:
    """Whether ``summary`` holds only text blocks."""
    return all("text" in block for block in summary["content"])


def _alternates_at(messages: Messages, position: int, role: Role) -> bool:
    """Whether a message of ``role`` inserted at ``position`` differs in role from both its neighbors."""
    neighbors = messages[max(position - 1, 0) : position + 1]
    return all(neighbor["role"] != role for neighbor in neighbors)


def _join_or_insert(messages: Messages, position: int, role: Role, summary: Message) -> None:
    """Join ``summary``'s content to the kept neighbor of ``role`` at ``position``, or insert it there alone.

    The summary covers the history before ``position``, so it ends the neighbor before it and opens a user message
    after it. An assistant message after it gets the summary at its end, so a leading reasoning block stays first; a
    user message opening with a tool result does too, since tool results come first.
    """
    carrier = _carrier(messages, position, role)
    if carrier is None:
        placed = Message(role=role, content=list(summary["content"]))
        _ensure_tracking_id(placed)
        messages.insert(position, placed)
        return
    if carrier == position and role == "user" and not _opens_with_tool_result(messages[carrier]):
        messages[carrier] = _prepend_content(Message(role=role, content=list(summary["content"])), messages[carrier])
        return
    joined = messages[carrier].copy()
    joined["content"] = [*joined["content"], *summary["content"]]
    messages[carrier] = joined


async def _with_summarized_marker(summary: Message, summarized: Messages, model: Model) -> Message:
    """Return a text summary as one block under a ``[Summarized: ...]`` header for the ``summarized`` messages.

    A summary holding other content, such as an override's provider-native compaction block, is returned unchanged:
    the provider needs it back as it sent it.
    """
    if not _is_text(summary):
        return summary
    tokens = await model.count_tokens(summarized)
    text = "\n".join(block["text"] for block in summary["content"])
    marker = _format_summarized(f"{len(summarized)} messages", tokens, text)
    return Message(role=summary["role"], content=[ContentBlock(text=marker)])


def _carrier(messages: Messages, position: int, role: Role) -> int | None:
    """Return the index of the kept neighbor of ``role`` the summary joins, or None when it stands alone.

    Message 0 is never a carrier unless the summary takes the place of the messages before it.
    """
    if position > 1 and messages[position - 1]["role"] == role:
        return position - 1
    if position < len(messages) and messages[position]["role"] == role:
        return position
    return None


def _overrides_summarize(model: Model) -> bool:
    """Whether ``model`` replaces the base ``Model.summarize()``, as a server-side compaction does."""
    return getattr(model.summarize, "__func__", None) is not Model.summarize


def _opens_with_tool_result(message: Message) -> bool:
    """Whether ``message``'s first block is a tool result."""
    return bool(message["content"]) and is_tool_result_block(message["content"][0])


def _record_summary_usage(invocation_context: InvocationContext | None, result: SummarizeResult) -> None:
    """Add a ``Model.summarize()`` call's usage, if it reported any, to the request it ran in."""
    if result.usage:
        _record_usage(invocation_context, result.usage)


def _tool_use_for(messages: Messages, tool_use_id: str) -> ContentBlock | None:
    """Return the ``toolUse`` block with ``tool_use_id`` in ``messages``, if any."""
    blocks = (block for message in messages for block in message["content"] if "toolUse" in block)
    return next((block for block in blocks if block["toolUse"]["toolUseId"] == tool_use_id), None)


def _block_request(block: ContentBlock, message: Message, messages: Messages) -> Messages:
    """Return the ``Model.summarize()`` input for one block of ``message``.

    The block goes in a message of ``message``'s role. A tool result follows the tool use it answers, when the
    history holds it, so the summarizer sees which tool produced it.
    """
    request = [Message(role=message["role"], content=[block])]
    tool_use = _tool_use_for(messages, block["toolResult"]["toolUseId"]) if "toolResult" in block else None
    return [Message(role="assistant", content=[tool_use]), *request] if tool_use else request


class SummarizeStrategy(BaseOffloadStrategy):
    """Summarize strategy — replaces oversized content with LLM-generated summaries."""

    @property
    def name(self) -> str:
        """Strategy name."""
        return "offload:summarize"

    def __init__(
        self,
        target: OffloadTarget | None = None,
        config: SummarizeConfig | None = None,
        conditions: OffloadConditions | None = None,
    ) -> None:
        super().__init__(target, conditions)
        self._config: SummarizeConfig = config or {}

    def when(
        self,
        *,
        threshold: int | None = None,
        utilization: float | None = None,
        preserve_recent: int | float = 0,
    ) -> SummarizeStrategy:
        """Return a new instance with the given conditions applied."""
        return SummarizeStrategy(
            self._target,
            self._config,
            _build_conditions(threshold=threshold, utilization=utilization, preserve_recent=preserve_recent),
        )

    async def apply(self, context: ContextState) -> bool:
        """Apply summarization. Returns False if no model is available."""
        if not self._resolve_model(context.agent):
            logger.warning("strategy=<%s> | no model available for summarization", self.name)
            return False
        return await super().apply(context)

    async def _select(self, context: ContextState) -> list[int]:
        """Return the indices of the messages this pass summarizes, in history order, leaving out pinned ones.

        A recency-only pass takes the messages before the compaction cut, message 0 included, which planning keeps
        unless a server-side compaction replaces it; a target or threshold pass takes the eligible messages and their
        tool pairs.
        """
        messages = context.messages
        if self._target not in (None, "*") or self._threshold is not None:
            indices = _with_tool_pairs(messages, await self._get_eligible_messages(context))
            return [] if _is_lone_summary(messages, indices) else indices
        split = _recency_split(messages, self._preserve_recent)
        selected = [index for index in range(split) if not is_pinned(messages, index)]
        # After a pass behind a pinned message, the only unpinned message before the cut is that pass's summary.
        return selected if len(selected) > 1 else []

    async def _apply_per_message(self, context: ContextState) -> bool:
        """Replace the selected messages with ``model.summarize()``'s summary of them."""
        model = self._resolve_model(context.agent)
        if not model:
            return False
        indices = await self._select(context)
        if not indices:
            return False
        messages = context.messages
        plan = _plan_after_message_zero(messages, indices, _overrides_summarize(model))
        if plan is None:
            logger.debug("summarized=<%s> | no place for a summary that frees context", len(indices))
            return False
        indices, slot = plan
        agent = context.agent
        selected = [messages[index] for index in indices]

        # Planning leaves message 0 in only for a provider override's server-side compaction of the conversation's
        # start; any other selection gets the base summary.
        summarize = model.summarize if indices[0] == 0 else functools.partial(Model.summarize, model)
        result = await summarize(
            selected,
            # A server-side compaction must carry the live system prompt and tools, or the provider
            # treats it as a different conversation.
            tool_specs=agent.tool_registry.get_all_tool_specs(),
            system_prompt=agent.system_prompt,
            system_prompt_content=agent.system_prompt_content,
            instructions=self._config.get("system_prompt"),
            cancel_signal=agent.cancel_signal,
        )
        _record_summary_usage(context.invocation_context, result)
        if not result.summary["content"]:
            logger.warning(
                "summarized=<%s> | model summarize returned no summary | leaving history unchanged", len(indices)
            )
            return False

        summary = await _with_summarized_marker(result.summary, selected, model)
        if not _place_summary(messages, indices, slot, summary):
            logger.warning(
                "summarized=<%s>, role=<%s> | summary does not alternate with the kept messages | "
                "leaving history unchanged",
                len(indices),
                summary["role"],
            )
            return False
        logger.debug("summarized=<%s> | compacted messages", len(indices))
        return True

    async def _replace_block(
        self,
        block: ContentBlock,
        tokens: int,
        message: Message,
        agent: Agent,
        stash_refs: list[str],
        invocation_context: InvocationContext | None = None,
    ) -> ContentBlock | None:
        model = self._resolve_model(agent)
        if not model:
            return None

        refs = _format_stash_refs(stash_refs)

        if "toolResult" in block:
            tool_result = block["toolResult"]
            summary = await self._try_summarize(block, model, message, agent, invocation_context)
            if not summary:
                return None

            logger.debug("tool_use_id=<%s>, tokens=<%s> | summarized tool result", tool_result["toolUseId"], tokens)
            marker = _format_summarized("tool result", tokens, summary) + refs
            summarized_content: list[ToolResultContent] = [{"text": marker}]
            return ContentBlock(
                toolResult=ToolResult(
                    toolUseId=tool_result["toolUseId"],
                    status=tool_result["status"],
                    content=summarized_content,
                )
            )

        if "text" in block:
            summary = await self._try_summarize(
                ContentBlock(text=block["text"]), model, message, agent, invocation_context
            )
            if not summary:
                return None

            logger.debug("tracking_id=<%s>, tokens=<%s> | summarized text block", message.get("tracking_id"), tokens)
            marker = _format_summarized("text block", tokens, summary) + refs
            return ContentBlock(text=marker)

        media = "image" in block or "document" in block
        summary = await self._try_summarize(block, model, message, agent, invocation_context) if media else None
        if summary:
            logger.debug("tracking_id=<%s>, tokens=<%s> | summarized media block", message.get("tracking_id"), tokens)
            marker = _format_summarized("media block", tokens, summary) + refs
            return ContentBlock(text=marker)

        logger.debug("tracking_id=<%s>, tokens=<%s> | offloaded media block", message.get("tracking_id"), tokens)
        return ContentBlock(text=f"[Offloaded: ~{tokens} tokens]{refs}")

    async def _try_summarize(
        self,
        block: ContentBlock,
        model: Model,
        message: Message,
        agent: Agent,
        invocation_context: InvocationContext | None = None,
    ) -> str | None:
        """Summarize one block; a failure is logged and leaves the block unsummarized so the pass continues."""
        try:
            # A lone block is not the conversation's start, so it gets the base summary.
            result = await Model.summarize(
                model,
                _block_request(block, message, agent.messages),
                instructions=self._config.get("system_prompt"),
                cancel_signal=agent.cancel_signal,
            )
        except Exception as error:
            logger.warning(
                "tracking_id=<%s>, error=<%s> | block summarization failed", message.get("tracking_id"), error
            )
            return None
        _record_summary_usage(invocation_context, result)
        summary = result.summary["content"]
        return summary[0]["text"] if summary else None

    def _resolve_model(self, agent: Agent) -> Model | None:
        return self._config.get("model") or agent.aux_model

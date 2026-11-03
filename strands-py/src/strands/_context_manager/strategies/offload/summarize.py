"""Summarize strategy — replaces oversized content with LLM-generated summaries."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from typing_extensions import TypedDict

from ....agent.conversation_manager.compression.pin_message import _get_tool_use_ids, _has_pinned_flag
from ....event_loop.streaming import _record_usage
from ....models._summarize import SummarizeResult, _summarize_with_stream
from ....types.content import ContentBlock, Message, Messages
from ....types.tools import ToolResult, ToolResultContent
from ...stash import MERGED_MESSAGES_KEY, _format_stash_refs
from ...types import ContextState
from .base import (
    BaseOffloadStrategy,
    OffloadConditions,
    OffloadTarget,
    _build_conditions,
    _collect_removable_with_pair,
    _insert_marker,
    _repair_alternation,
)

if TYPE_CHECKING:
    from ....agent.agent import Agent
    from ....agent.invocation_context import InvocationContext
    from ....models.model import Model

logger = logging.getLogger(__name__)

_SUMMARIZED_PREFIX = "[Summarized:"


class SummarizeConfig(TypedDict, total=False):
    """Configuration for the summarize method.

    Attributes:
        model: Model used for summarization. Resolution order: this ``model`` > ``agent.aux_model``
            > ``agent.model``.
        system_prompt: Custom system prompt for the summarization model.
    """

    model: Model
    system_prompt: str


def _format_summarized(description: str, tokens: int, summary: str | None = None) -> str:
    """Format a ``[Summarized: ...]`` marker with an optional summary body."""
    header = f"{_SUMMARIZED_PREFIX} {description}, ~{tokens:,} tokens]"
    return f"{header}\n\n{summary}" if summary else header


def _compacts_server_side(model: Model) -> bool:
    """Whether ``model`` declares server-side compaction, so its ``summarize()`` may cover the opening messages."""
    return model.model_info.capabilities.server_side_compaction is True


def _runs(messages: Messages, selected: list[Message]) -> list[list[Message]]:
    """Split ``selected`` and their tool pairs into runs of messages adjacent in ``messages``, in history order."""
    index_of = {id(message): index for index, message in enumerate(messages)}
    indices = sorted(
        {
            index_of[id(removable)]
            for message in selected
            if id(message) in index_of
            for removable in _collect_removable_with_pair(messages, index_of[id(message)])
        }
    )
    runs: list[list[Message]] = []
    for position, index in enumerate(indices):
        if position == 0 or index != indices[position - 1] + 1:
            runs.append([])
        runs[-1].append(messages[index])
    return runs


def _opening_run(messages: Messages, runs: list[list[Message]]) -> list[Message] | None:
    """Return the run right after message 0 that server-side compaction may cover together with message 0.

    The covered messages start with a user message and alternate roles.
    """
    if not runs or runs[0][0] is not messages[1]:
        return None
    roles = [message["role"] for message in messages[: len(runs[0]) + 1]]
    alternates = roles == ["user" if index % 2 == 0 else "assistant" for index in range(len(roles))]
    return runs[0] if alternates else None


def _pieces(message: Message) -> list[Message]:
    """Split ``message`` into the messages merged into it when one of those is pinned, or return it whole."""
    parts = message.get("metadata", {}).get("custom", {}).get(MERGED_MESSAGES_KEY)
    if not parts or not any(_has_pinned_flag(part) for part in parts):
        return [message]
    content = message["content"]
    ends = [part["offset"] for part in parts[1:]] + [len(content)]
    pieces: list[Message] = []
    for part, end in zip(parts, ends, strict=True):
        piece = Message(role=message["role"], content=content[part["offset"] : end])
        if "tracking_id" in part:
            piece["tracking_id"] = part["tracking_id"]
        if part.get("metadata"):
            piece["metadata"] = part["metadata"]
        pieces.append(piece)
    return pieces


def _split_pinned(run: list[Message]) -> tuple[list[Message], list[Message]]:
    """Split ``run`` into its pinned messages, with their tool-pair partners, and the rest, both in history order.

    A merged message is split into the messages it combines, so only its pinned ones are kept.
    """
    pieces = [piece for message in run for piece in _pieces(message) if piece["content"]]
    pinned_ids = {tool_id for piece in pieces if _has_pinned_flag(piece) for tool_id in _get_tool_use_ids(piece)}
    kept = [piece for piece in pieces if _has_pinned_flag(piece) or pinned_ids & _get_tool_use_ids(piece)]
    kept_ids = {id(piece) for piece in kept}
    return kept, [piece for piece in pieces if id(piece) not in kept_ids]


def _holds_only_summaries(run: list[Message]) -> bool:
    """Whether every block of ``run`` is an earlier summary, so summarizing it would only restate that summary."""
    return all(
        "text" in block and block["text"].startswith(_SUMMARIZED_PREFIX)
        for message in run
        for block in message["content"]
    )


def _summary_text(result: SummarizeResult | None) -> str:
    """Return the summary's text blocks, one per line, or ``""`` without a result."""
    if result is None:
        return ""
    return "\n".join(block["text"] for block in result.content if "text" in block).strip()


def _block_request(block: ContentBlock, message: Message, messages: Messages) -> Messages:
    """Return the ``Model.summarize()`` input for one block of ``message``.

    The block goes in a message of ``message``'s role. A tool result follows the tool use it answers, when the
    history holds it, so the summarizer sees which tool produced it.
    """
    request = [Message(role=message["role"], content=[block])]
    if "toolResult" not in block:
        return request
    tool_use_id = block["toolResult"]["toolUseId"]
    uses = (candidate for turn in messages for candidate in turn["content"] if "toolUse" in candidate)
    tool_use = next((use for use in uses if use["toolUse"]["toolUseId"] == tool_use_id), None)
    return [Message(role="assistant", content=[tool_use]), *request] if tool_use else request


class SummarizeStrategy(BaseOffloadStrategy):
    """Summarize strategy — replaces oversized content with LLM-generated summaries."""

    # Pinned messages join a run and are kept after its summary, so the opening run still starts at message 1.
    _skips_pinned = False

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

    async def _apply_per_message(self, context: ContextState) -> bool:
        """Summarize each contiguous run of eligible messages into its own summary.

        For a model with server-side compaction, the run right after message 0 is compacted together with message 0
        into a message of its own.
        """
        model = self._resolve_model(context.agent)
        if not model:
            return False
        messages = context.messages
        runs = _runs(messages, await self._get_eligible_messages(context))
        opening = _opening_run(messages, runs) if _compacts_server_side(model) else None
        acted = False
        # Last run first, so replacing a run leaves the earlier runs' positions unchanged.
        for run in reversed(runs):
            # An opening run compaction left in place gets the base summary instead.
            compacted = run is opening and await self._compact_opening(context, model, run)
            acted = compacted or await self._summarize_run(context, model, run) or acted
        if acted:
            _repair_alternation(messages)
        return acted

    async def _summarize_run(self, context: ContextState, model: Model, run: list[Message]) -> bool:
        """Replace ``run`` with a summary marker, ahead of the run's pinned messages; a failure keeps the run."""
        kept, summarized = _split_pinned(run)
        if not summarized or _holds_only_summaries(summarized):
            return False
        summary = _summary_text(await self._try_summarize(run, model, context.agent, context.invocation_context))
        if not summary:
            return False
        messages = context.messages
        total_tokens = await model.count_tokens(summarized)
        start = next(index for index, message in enumerate(messages) if message is run[0])
        marker = _format_summarized(f"{len(summarized)} messages", total_tokens, summary)
        messages[start : start + len(run)] = kept
        if kept:
            messages.insert(start, Message(role="assistant", content=[ContentBlock(text=marker)]))
        else:
            _insert_marker(messages, start, marker)
        logger.debug("summarized=<%s>, tokens=<%s> | summarized message run", len(summarized), total_tokens)
        return True

    async def _compact_opening(self, context: ContextState, model: Model, run: list[Message]) -> bool:
        """Compact message 0 and the run after it server-side, keeping message 0 in place.

        The summary takes the run's place as an assistant message, followed by the run's pinned messages and ahead of
        any assistant content that follows.
        """
        kept, summarized = _split_pinned(run)
        if not summarized or _holds_only_summaries(summarized):
            return False
        messages = context.messages
        request = [messages[0], *run]
        result = await self._try_summarize(request, model, context.agent, context.invocation_context, opening=True)
        summary = _summary_text(result)
        if not result or not summary:
            return False
        total_tokens = await model.count_tokens(summarized)
        marker = ContentBlock(text=_format_summarized(f"{len(summarized)} messages", total_tokens, summary))
        messages[1 : 1 + len(run)] = [Message(role="assistant", content=[marker]), *kept]
        logger.debug("summarized=<%s>, tokens=<%s> | compacted opening messages", len(summarized), total_tokens)
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
        summarizable = "toolResult" in block or "text" in block or "image" in block or "document" in block
        request = _block_request(block, message, agent.messages) if summarizable else None
        summary = _summary_text(await self._try_summarize(request, model, agent, invocation_context)) if request else ""

        if "toolResult" in block:
            if not summary:
                return None
            tool_result = block["toolResult"]
            logger.debug("tool_use_id=<%s>, tokens=<%s> | summarized tool result", tool_result["toolUseId"], tokens)
            summarized_content: list[ToolResultContent] = [
                {"text": _format_summarized("tool result", tokens, summary) + refs}
            ]
            return ContentBlock(
                toolResult=ToolResult(
                    toolUseId=tool_result["toolUseId"], status=tool_result["status"], content=summarized_content
                )
            )

        if "text" in block:
            if not summary:
                return None
            logger.debug("tracking_id=<%s>, tokens=<%s> | summarized text block", message.get("tracking_id"), tokens)
            return ContentBlock(text=_format_summarized("text block", tokens, summary) + refs)

        if summary:
            logger.debug("tracking_id=<%s>, tokens=<%s> | summarized media block", message.get("tracking_id"), tokens)
            return ContentBlock(text=_format_summarized("media block", tokens, summary) + refs)

        logger.debug("tracking_id=<%s>, tokens=<%s> | offloaded media block", message.get("tracking_id"), tokens)
        return ContentBlock(text=f"[Offloaded: ~{tokens} tokens]{refs}")

    async def _try_summarize(
        self,
        messages: Messages,
        model: Model,
        agent: Agent,
        invocation_context: InvocationContext | None,
        *,
        opening: bool = False,
    ) -> SummarizeResult | None:
        """Summarize ``messages`` and record the call's usage; a failure is logged and returns ``None``.

        A model with server-side compaction is called through its ``summarize()`` only for ``opening`` messages; its
        other summaries use the base implementation.
        """
        instructions = self._config.get("system_prompt")
        try:
            if opening or not _compacts_server_side(model):
                result = await model.summarize(
                    messages,
                    tool_specs=agent.tool_registry.get_all_tool_specs(),
                    system_prompt=agent.system_prompt,
                    system_prompt_content=agent.system_prompt_content,
                    instructions=instructions,
                    cancel_signal=agent.cancel_signal,
                )
            else:
                result = await _summarize_with_stream(
                    model, messages, instructions=instructions, cancel_signal=agent.cancel_signal
                )
        except Exception as error:
            logger.warning("messages=<%s>, error=<%s> | summarization failed", len(messages), error)
            return None
        if result.usage:
            _record_usage(invocation_context, result.usage)
        return result

    def _resolve_model(self, agent: Agent) -> Model | None:
        return self._config.get("model") or agent.aux_model

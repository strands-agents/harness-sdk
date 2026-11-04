"""Summarize strategy — replaces oversized content with LLM-generated summaries."""

from __future__ import annotations

import logging
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

from typing_extensions import TypedDict

from ....agent.conversation_manager.compression.pin_message import _has_pinned_flag, is_pinned
from ....event_loop.streaming import _record_usage
from ....models._summarize import _SUMMARIZED_PREFIX, SummarizeResult, _format_summarized, _summarize_with_stream
from ....types.content import ContentBlock, Message, Messages
from ....types.tools import ToolResult, ToolResultContent
from ...stash import _format_stash_refs
from ...types import ContextState
from .base import (
    BaseOffloadStrategy,
    OffloadConditions,
    OffloadTarget,
    _build_conditions,
    _collect_removable_with_pair,
    _insert_marker,
    _repair_alternation,
    _splice_with_pairs,
)

if TYPE_CHECKING:
    from ....agent.agent import Agent
    from ....agent.invocation_context import InvocationContext
    from ....models.model import Model
    from ...types import ContextStrategy

logger = logging.getLogger(__name__)


class SummarizeConfig(TypedDict, total=False):
    """Configuration for the summarize method.

    Attributes:
        model: Model used for summarization. Resolution order: this ``model`` > ``agent.aux_model``
            > ``agent.model``.
        system_prompt: Custom system prompt for the summarization model.
    """

    model: Model
    system_prompt: str


_LIMIT_STATEMENTS = {
    "pinned messages": "pinned messages are kept after a server-side summary"
    " | thinking in the messages kept after the summary will be dropped",
    "per-block summarization": "per-block summarization with preserve_recent rewrites blocks the model has already seen"
    " | thinking from earlier turns will be dropped on the next turns",
}


def _server_side_summary_limits(agent: Agent, strategies: Sequence[ContextStrategy]) -> list[str]:
    """Return the features in use that a server-side summary doesn't support, for an agent whose model has it.

    Per-block summarization with ``preserve_recent`` rewrites blocks the model has already seen, and pinned messages
    kept after a server-side summary sit between its block and the messages it keeps. Without ``preserve_recent``, a
    block is rewritten before the model sees it.
    """
    if agent.model.model_info.capabilities.server_side_summary is not True:
        return []
    summarizers = [strategy for strategy in strategies if isinstance(strategy, SummarizeStrategy)]
    features = []
    if any(strategy._summarizes_server_side(agent) for strategy in summarizers) and any(
        _has_pinned_flag(message) for message in agent.messages
    ):
        features.append("pinned messages")
    if any(not strategy._is_message_level and strategy._preserve_recent > 0 for strategy in summarizers):
        features.append("per-block summarization")
    return features


def _warn_on_server_side_summary_limits(agent: Agent, strategies: Sequence[ContextStrategy]) -> None:
    """Log a warning describing how a server-side summary treats the features in use, if any."""
    features = _server_side_summary_limits(agent, strategies)
    if not features:
        return
    config: Any = agent.model.get_config()
    model_id = config.get("model_id") if isinstance(config, dict) else None
    statements = [_LIMIT_STATEMENTS[feature] for feature in features]
    logger.warning("model_id=<%s> | %s", model_id, " | ".join(statements))


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
    """Return the run right after message 0 that a server-side summary may cover together with message 0.

    The covered messages start with a user message and alternate roles.
    """
    if not runs or runs[0][0] is not messages[1]:
        return None
    roles = [message["role"] for message in messages[: len(runs[0]) + 1]]
    alternates = roles == ["user" if index % 2 == 0 else "assistant" for index in range(len(roles))]
    return runs[0] if alternates else None


def _holds_only_summaries(run: list[Message]) -> bool:
    """Whether every block of ``run`` is an earlier summary, so summarizing it would only restate that summary."""
    return all(
        "text" in block and block["text"].startswith(_SUMMARIZED_PREFIX)
        for message in run
        for block in message["content"]
    )


def _without_summaries(message: Message) -> Message | None:
    """Return ``message`` without the earlier summaries merged into it, or None when nothing else is left."""
    content = [
        block for block in message["content"] if not ("text" in block and block["text"].startswith(_SUMMARIZED_PREFIX))
    ]
    if len(content) == len(message["content"]):
        return message
    return {**message, "content": content} if content else None


def _summary_text(result: SummarizeResult | None) -> str:
    """Return the summary's text blocks, one per line, or ``""`` without a result."""
    if result is None:
        return ""
    return "\n".join(block["text"] for block in result.content if "text" in block).strip()


def _server_side_summary_of(result: SummarizeResult | None) -> ContentBlock | None:
    """Return the first text block of ``result`` that its provider wrote server-side, or None."""
    content = result.content if result else []
    return next(
        (block for block in content if "text" in block and "serverSideSummary" in block.get("metadata", {})), None
    )


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
        """Summarize the eligible messages other than pinned ones into one summary, leaving pinned messages in place.

        When both the summarizer and the agent's model have server-side summaries, the run right after message 0,
        pinned messages included, is summarized server-side together with message 0 first, and its pinned messages
        are kept after the summary.
        """
        model = self._resolve_model(context.agent)
        if not model:
            return False
        messages = context.messages
        unpinned = await self._get_eligible_messages(context)
        acted = False
        if self._summarizes_server_side(context.agent):
            selected = await self._get_eligible_messages(context, skip_pinned=False)
            opening = _opening_run(messages, _runs(messages, selected))
            if opening and await self._summarize_opening_server_side(context, model, opening):
                covered = {id(message) for message in opening}
                unpinned = [message for message in unpinned if id(message) not in covered]
                acted = True
        acted = await self._summarize_client_side(context, model, unpinned) or acted
        if acted:
            _repair_alternation(messages)
        return acted

    async def _summarize_client_side(self, context: ContextState, model: Model, selected: list[Message]) -> bool:
        """Replace ``selected`` and their tool pairs with one summary marker; a failure is logged and keeps them.

        The marker joins the assistant message before the earliest removed message, or becomes its own message there,
        which leads any assistant content after it once alternation is repaired.
        """
        messages = context.messages
        index_of = {id(message): index for index, message in enumerate(messages)}
        removable = {
            id(partner)
            for message in selected
            if id(message) in index_of
            for partner in _collect_removable_with_pair(messages, index_of[id(message)])
        }
        summarized = [message for message in messages if id(message) in removable]
        if not summarized or _holds_only_summaries(summarized):
            return False
        result = await self._try_summarize(summarized, model, context.agent, context.invocation_context)
        summary = _summary_text(result)
        if not summary:
            return False
        total_tokens = await model.count_tokens(summarized)
        removed, start = _splice_with_pairs(messages, summarized)
        marker = _format_summarized(f"{removed} messages", total_tokens, summary)
        if start > 1 and messages[start - 1]["role"] == "assistant":
            _insert_marker(messages, start, marker)
        else:
            messages.insert(start, Message(role="assistant", content=[ContentBlock(text=marker)]))
        logger.debug("summarized=<%s>, tokens=<%s> | summarized messages", removed, total_tokens)
        return True

    async def _summarize_opening_server_side(self, context: ContextState, model: Model, run: list[Message]) -> bool:
        """Summarize message 0 and ``run``, pinned messages included, server-side, keeping message 0 in place.

        The summary takes the run's place as an assistant message, followed by the run's pinned messages and their
        tool-pair partners, without earlier summaries merged into them. The provider sends its block, which covers
        message 0, in place of the text; a server-side summary is kept verbatim, since the provider reads it back
        from the marker. Pinned messages kept after the block invalidate the thinking in the messages after them.
        """
        messages = context.messages
        start = next(index for index, message in enumerate(messages) if message is run[0])
        pinned_ids = {id(message) for offset, message in enumerate(run) if is_pinned(messages, start + offset)}
        replaced = [message for message in run if id(message) not in pinned_ids]
        if not replaced or _holds_only_summaries(replaced):
            return False
        request = [messages[0], *run]
        result = await self._try_summarize(request, model, context.agent, context.invocation_context, opening=True)
        server_side = _server_side_summary_of(result)
        summary = server_side["text"] if server_side else _summary_text(result)
        if not result or not summary:
            return False
        total_tokens = await model.count_tokens(replaced)
        marker = ContentBlock(text=_format_summarized(f"{len(replaced)} messages", total_tokens, summary))
        if server_side:
            marker["metadata"] = {"serverSideSummary": server_side["metadata"]["serverSideSummary"]}
        kept = [kept for message in run if id(message) in pinned_ids and (kept := _without_summaries(message))]
        messages[1 : 1 + len(run)] = [Message(role="assistant", content=[marker]), *kept]
        logger.debug(
            "summarized=<%s>, kept=<%s>, tokens=<%s> | summarized opening messages server-side",
            len(replaced),
            len(kept),
            total_tokens,
        )
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

        A model with server-side summaries is called through its ``summarize()`` only for ``opening`` messages; its
        other summaries use the base implementation.
        """
        instructions = self._config.get("system_prompt")
        try:
            if opening or model.model_info.capabilities.server_side_summary is not True:
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

    def _summarizes_server_side(self, agent: Agent) -> bool:
        """Whether this strategy summarizes message runs and its summarizer and the agent's model do so server-side."""
        model = self._resolve_model(agent)
        return (
            self._is_message_level
            and model is not None
            and model.model_info.capabilities.server_side_summary is True
            and agent.model.model_info.capabilities.server_side_summary is True
        )

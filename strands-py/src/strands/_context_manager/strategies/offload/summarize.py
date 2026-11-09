"""Summarize strategy — replaces oversized content with LLM-generated summaries."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from typing_extensions import TypedDict

from ....agent.conversation_manager.compression.pin_message import is_pinned
from ....models._summarize import _summarize_with_stream
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

logger = logging.getLogger(__name__)


class SummarizeConfig(TypedDict, total=False):
    """Configuration for the summarize strategy.

    Attributes:
        model: Model used for summarization. Resolution order: this ``model`` > ``agent.aux_model``
            > ``agent.model``.
        system_prompt: Custom system prompt for the summarization model.
    """

    model: Model
    system_prompt: str


def _format_summarized(description: str, tokens: int, summary: str | None = None) -> str:
    """Format a ``[Summarized: ...]`` marker with an optional summary body."""
    header = f"[Summarized: {description}, ~{tokens:,} tokens]"
    if summary:
        return f"{header}\n\n{summary}"
    return header


def _warn_client_side_fallback(model: Model, reason: str, *, exc_info: bool = False) -> None:
    logger.warning(
        "model=<%s>, reason=<%s> | server-side summary failed, falling back to client-side summary"
        " | the client-side summary rewrites history, so thinking blocks kept after it will be dropped",
        type(model).__name__,
        reason,
        exc_info=exc_info,
    )


def _pinned_before(messages: list[Message], end: int) -> list[Message]:
    return [message for index, message in enumerate(messages[1:end], start=1) if is_pinned(messages, index)]


def _block_request(block: ContentBlock, message: Message, messages: Messages) -> Messages:
    """Return the summarizer input for one block of ``message``.

    The block goes in a message of ``message``'s role. A tool result follows the name of the tool that produced it,
    when the history holds its tool use; the tool's input is left out, since it can be far larger than the result.
    """
    request = [Message(role=message["role"], content=[block])]
    if "toolResult" not in block:
        return request
    tool_use_id = block["toolResult"]["toolUseId"]
    uses = (candidate["toolUse"] for turn in messages for candidate in turn["content"] if "toolUse" in candidate)
    name = next((use["name"] for use in uses if use["toolUseId"] == tool_use_id), None)
    if name is None:
        return request
    return [Message(role="assistant", content=[ContentBlock(text=f"[tool call: {name}]")]), *request]


async def _place_text_summary(messages: list[Message], end: int, summary: str, model: Model) -> None:
    """Replace ``messages[1:end]`` with a client-side summary marker holding ``summary``."""
    tokens = await model.count_tokens(messages[1:end])
    del messages[1:end]
    _insert_marker(messages, 1, _format_summarized(f"{end - 1} messages", tokens, summary))
    logger.debug("summarized=<%s>, tokens=<%s> | placed a text summary of the opening messages", end - 1, tokens)


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
        """Summarize oldest eligible messages into a single summary message."""
        model = self._resolve_model(context.agent)
        if not model:
            return False

        messages = context.messages
        if len(messages) <= 1:
            return False

        eligible = await self._get_eligible_messages(context)
        if not eligible:
            return False

        identity_map = {id(msg): index for index, msg in enumerate(messages)}
        safe_ids: set[int] = set()
        for message in eligible:
            index = identity_map.get(id(message))
            if index is None:
                continue
            for removable in _collect_removable_with_pair(messages, index):
                safe_ids.add(id(removable))
        safe = [msg for msg in messages if id(msg) in safe_ids]
        if not safe:
            return False

        # The agent's model replays the summary block, so both it and the summarizer must support it.
        server_side = (
            model.model_info.capabilities.server_side_summary is True
            and context.agent.model.model_info.capabilities.server_side_summary is True
        )
        if server_side and await self._summarize_server_side(context, model, safe):
            return True

        try:
            summary = await self._summarize_client_side(model, context.agent, safe, context.invocation_context)
        except Exception as error:
            logger.warning("messages=<%d>, error=<%s> | summarization failed", len(safe), error, exc_info=True)
            return False
        if not summary:
            return False

        total_tokens = await model.count_tokens(safe)

        removed, lowest_index = _splice_with_pairs(messages, safe)
        if removed == 0:
            return False

        _insert_marker(messages, lowest_index, _format_summarized(f"{removed} messages", total_tokens, summary))

        _repair_alternation(messages)
        logger.debug("summarized=<%s>, tokens=<%s> | batched summarization complete", removed, total_tokens)
        return True

    async def _summarize_server_side(self, context: ContextState, model: Model, safe: list[Message]) -> bool:
        """Summarize message 0 through the last of ``safe`` server-side, keeping message 0 in place.

        A server-side summary can only stand in for the conversation's exact start, so every message up to the last
        of ``safe`` is sent, even ones ``safe`` leaves out. The summary becomes an assistant message at index 1 and
        leads any assistant content after it once alternation is repaired. A text block, which the base
        :meth:`Model.summarize` returns, is placed as a client-side summary marker instead. Pinned messages are not
        supported on this path, so a pin among the summarized messages hands the pass to the client-side summary.

        Returns:
            False when the server-side summary was skipped or failed, so the caller summarizes client-side instead.
        """
        messages = context.messages
        safe_ids = {id(message) for message in safe}
        end = max(index for index, message in enumerate(messages) if id(message) in safe_ids) + 1
        if end <= 1:
            return False
        pinned = _pinned_before(messages, end)
        if pinned:
            logger.warning(
                "model=<%s>, pinned=<%d> | server-side summary does not support pinned messages"
                " | falling back to client-side summary",
                type(model).__name__,
                len(pinned),
            )
            return False
        replaced = end - 1
        if replaced > len(safe):
            logger.warning(
                "covered=<%d>, eligible=<%d> | a server-side summary covers the conversation's start"
                " | summarizing messages that were not eligible too",
                replaced,
                len(safe),
            )
        summary = await self._request_server_side_summary(model, context, messages[:end])
        if summary is None:
            return False
        if "text" in summary:
            await _place_text_summary(messages, end, summary["text"], model)
        else:
            messages[1:end] = [Message(role="assistant", content=[summary])]
            logger.debug("summarized=<%s> | summarized opening messages server-side", replaced)
        _repair_alternation(messages)
        return True

    async def _request_server_side_summary(
        self, model: Model, context: ContextState, messages: list[Message]
    ) -> ContentBlock | None:
        """Return the model's server-side summary of ``messages``, or None after warning that client-side takes over."""
        agent = context.agent
        try:
            summary = await model.summarize(
                messages,
                tool_specs=agent.tool_registry.get_all_tool_specs(),
                system_prompt=agent.system_prompt,
                system_prompt_content=agent.system_prompt_content,
                instructions=self._config.get("system_prompt"),
                invocation_context=context.invocation_context,
            )
        except Exception as error:
            _warn_client_side_fallback(model, repr(error), exc_info=not isinstance(error, NotImplementedError))
            return None
        return summary

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
            summary = await self._try_summarize(block, model, message, agent, invocation_context)
            if not summary:
                return None

            logger.debug("tracking_id=<%s>, tokens=<%s> | summarized text block", message.get("tracking_id"), tokens)
            marker = _format_summarized("text block", tokens, summary) + refs
            return ContentBlock(text=marker)

        if "image" in block or "document" in block:
            summary = await self._try_summarize(block, model, message, agent, invocation_context)
            if summary:
                logger.debug(
                    "tracking_id=<%s>, tokens=<%s> | summarized media block", message.get("tracking_id"), tokens
                )
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
        invocation_context: InvocationContext | None,
    ) -> str:
        """Summarize one block; a failure is logged and leaves the block unsummarized so the pass continues."""
        try:
            request = _block_request(block, message, agent.messages)
            return await self._summarize_client_side(model, agent, request, invocation_context)
        except Exception as error:
            logger.warning(
                "tracking_id=<%s>, error=<%s> | block summarization failed", message.get("tracking_id"), error
            )
            return ""

    async def _summarize_client_side(
        self, model: Model, agent: Agent, messages: Messages, invocation_context: InvocationContext | None
    ) -> str:
        """Return the model's client-side summary of ``messages``.

        A model with server-side summaries summarizes only the conversation's opening messages through its own
        ``summarize()``, so its other summaries use the base implementation, as do those of an override that raises
        ``NotImplementedError``.
        """
        instructions = self._config.get("system_prompt")
        if model.model_info.capabilities.server_side_summary is True:
            summary = await _summarize_with_stream(model, messages, instructions, invocation_context)
        else:
            summary = await self._summarize_with_override(model, agent, messages, instructions, invocation_context)
        if "text" not in summary:
            logger.warning(
                "model=<%s> | summarize returned no text summary | leaving the content unsummarized",
                type(model).__name__,
            )
            return ""
        return summary["text"]

    async def _summarize_with_override(
        self,
        model: Model,
        agent: Agent,
        messages: Messages,
        instructions: str | None,
        invocation_context: InvocationContext | None,
    ) -> ContentBlock:
        try:
            return await model.summarize(
                messages,
                tool_specs=agent.tool_registry.get_all_tool_specs(),
                system_prompt=agent.system_prompt,
                system_prompt_content=agent.system_prompt_content,
                instructions=instructions,
                invocation_context=invocation_context,
            )
        except NotImplementedError:
            return await _summarize_with_stream(model, messages, instructions, invocation_context)

    def _resolve_model(self, agent: Agent) -> Model | None:
        return self._config.get("model") or agent.aux_model

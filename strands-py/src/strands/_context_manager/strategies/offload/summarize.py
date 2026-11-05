"""Summarize strategy — replaces oversized content with LLM-generated summaries."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from ....agent.conversation_manager.compression.pin_message import is_pinned
from ....types.content import ContentBlock, Message
from ....types.tools import ToolResult, ToolResultContent
from ...methods.summarize import (
    SummarizeConfig,
    _flatten_messages_to_content,
    _format_summarized,
    _summarize_content,
    _tool_result_to_content_blocks,
)
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


def _warn_client_side_fallback(model: Model, reason: str, *, exc_info: bool = False) -> None:
    logger.warning(
        "model=<%s>, reason=<%s> | server-side summary failed, falling back to client-side summary"
        " | the client-side summary rewrites history, so thinking blocks kept after it will be dropped",
        type(model).__name__,
        reason,
        exc_info=exc_info,
    )


def _warn_kept_pins(model: Model, kept: int) -> None:
    logger.warning(
        "model=<%s>, kept=<%d> | pinned messages are kept after a server-side summary"
        " | thinking in the messages kept after the summary will be dropped",
        type(model).__name__,
        kept,
    )


def _is_summary(block: ContentBlock) -> bool:
    return "summary" in block or ("text" in block and block["text"].startswith("[Summarized:"))


def _without_summaries(message: Message) -> Message | None:
    """Return ``message`` without the earlier summaries merged into it, or None when nothing else is left."""
    content = [block for block in message["content"] if not _is_summary(block)]
    if len(content) == len(message["content"]):
        return message
    return {**message, "content": content} if content else None


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

        content_blocks = _flatten_messages_to_content(safe)
        summary = await _summarize_content(content_blocks, model, self._config, context.invocation_context)
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
        of ``safe`` is sent, even ones ``safe`` leaves out. The summary becomes an assistant message at index 1,
        followed by the pinned messages it covered, without earlier summaries merged into them; it leads any
        assistant content after it once alternation is repaired. Pinned messages kept after the summary invalidate
        the thinking in the messages after them.

        Returns:
            False when the server-side summary failed, so the caller summarizes client-side instead.
        """
        messages = context.messages
        safe_ids = {id(message) for message in safe}
        end = max(index for index, message in enumerate(messages) if id(message) in safe_ids) + 1
        pinned = [message for index, message in enumerate(messages[1:end], start=1) if is_pinned(messages, index)]
        replaced = end - 1 - len(pinned)
        if replaced > len(safe):
            logger.warning(
                "covered=<%d>, eligible=<%d> | a server-side summary covers the conversation's start"
                " | summarizing messages that were not eligible too",
                replaced,
                len(safe),
            )
        agent = context.agent
        summary = await self._request_server_side_summary(model, agent, messages[:end])
        if summary is None:
            return False
        kept = [kept for message in pinned if (kept := _without_summaries(message))]
        messages[1:end] = [Message(role="assistant", content=[summary]), *kept]
        if kept:
            _warn_kept_pins(model, len(kept))
        _repair_alternation(messages)
        logger.debug("summarized=<%s>, kept=<%s> | summarized opening messages server-side", replaced, len(kept))
        return True

    async def _request_server_side_summary(
        self, model: Model, agent: Agent, messages: list[Message]
    ) -> ContentBlock | None:
        """Return the model's server-side summary of ``messages``, or None after warning that client-side takes over."""
        try:
            summary = await model.summarize(
                messages,
                tool_specs=agent.tool_registry.get_all_tool_specs(),
                system_prompt=agent.system_prompt,
                system_prompt_content=agent.system_prompt_content,
                instructions=self._config.get("system_prompt"),
            )
        except Exception as error:
            _warn_client_side_fallback(model, repr(error), exc_info=True)
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
            content_blocks = _tool_result_to_content_blocks(tool_result["content"])
            summary = await self._try_summarize(content_blocks, model, message, invocation_context)
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
            summary = await self._try_summarize([ContentBlock(text=block["text"])], model, message, invocation_context)
            if not summary:
                return None

            logger.debug("tracking_id=<%s>, tokens=<%s> | summarized text block", message.get("tracking_id"), tokens)
            marker = _format_summarized("text block", tokens, summary) + refs
            return ContentBlock(text=marker)

        if "image" in block or "document" in block:
            summary = await self._try_summarize([block], model, message, invocation_context)
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
        content: list[ContentBlock],
        model: Model,
        message: Message,
        invocation_context: InvocationContext | None = None,
    ) -> str | None:
        """Summarize one block; a failure is logged and leaves the block unsummarized so the pass continues."""
        try:
            return await _summarize_content(content, model, self._config, invocation_context)
        except Exception as error:
            logger.warning(
                "tracking_id=<%s>, error=<%s> | block summarization failed", message.get("tracking_id"), error
            )
            return None

    def _resolve_model(self, agent: Agent) -> Model | None:
        return self._config.get("model") or agent.aux_model

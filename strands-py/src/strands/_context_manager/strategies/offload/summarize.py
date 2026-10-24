"""Summarize strategy — replaces oversized content with LLM-generated summaries."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from ....types.content import ContentBlock, Message
from ....types.tools import ToolResult, ToolResultContent
from ...methods.summarize import (
    SummarizeConfig,
    _format_summarized,
    _summarize_content,
    _summarize_messages,
    _tool_result_to_content_blocks,
)
from ...stash import _format_stash_refs
from ...types import ContextState
from .base import BaseOffloadStrategy, OffloadConditions, OffloadTarget, _build_conditions

if TYPE_CHECKING:
    from ....agent.agent import Agent
    from ....agent.invocation_context import InvocationContext
    from ....models.model import Model

logger = logging.getLogger(__name__)


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

    @property
    def _selects_by_recency_only(self) -> bool:
        """Whether ``preserve_recent``, the only selection ``Model.compact()`` receives, decides what is summarized."""
        return self._target in (None, "*") and self._threshold is None

    async def _compact(self, context: ContextState, model: Model, preserved_messages: int | float) -> bool:
        """Replace the history with ``model.compact()``'s result, keeping ``preserved_messages`` trailing messages."""
        agent = context.agent
        compacted = await model.compact(
            context.messages,
            preserved_messages=preserved_messages,
            # A server-side compaction must carry the live system prompt and tools, or the provider
            # treats it as a different conversation.
            tool_specs=agent.tool_registry.get_all_tool_specs(),
            system_prompt=agent.system_prompt,
            system_prompt_content=agent.system_prompt_content,
            instructions=self._config.get("system_prompt"),
            invocation_context=context.invocation_context,
        )
        if compacted is None:
            return False

        context.messages[:] = compacted
        return True

    async def _apply_per_message(self, context: ContextState) -> bool:
        """Summarize oldest eligible messages into a single summary message."""
        model = self._resolve_model(context.agent)
        if not model:
            return False
        if self._selects_by_recency_only:
            return await self._compact(context, model, self._preserve_recent)

        messages = context.messages
        if len(messages) <= 1:
            return False

        eligible = await self._get_eligible_messages(context)
        if not eligible:
            return False

        return await _summarize_messages(messages, eligible, model, self._config, context.invocation_context)

    async def _apply_per_block(self, context: ContextState) -> bool:
        """Summarize eligible blocks, or compact the history when the model compacts server-side.

        A retroactive per-block summary invalidates later thinking on a model that compacts server-side, so it
        compacts the history instead, but only when a block it targets is eligible.
        """
        model = self._resolve_model(context.agent)
        if not model or not self._is_retroactive or model.server_compaction is not True:
            return await super()._apply_per_block(context)

        messages = context.messages
        eligible = await self._get_eligible_messages(context)
        if not eligible:
            return False
        # ``preserve_recent`` counts only matching messages, so the cut is set just after the newest eligible one.
        newest_eligible = next(index for index in reversed(range(len(messages))) if messages[index] is eligible[-1])
        return await self._compact(context, model, len(messages) - newest_eligible - 1)

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

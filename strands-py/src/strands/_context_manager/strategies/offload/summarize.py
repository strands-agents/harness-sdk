"""Summarize strategy — replaces oversized content with LLM-generated summaries."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

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
    _repair_alternation,
    _splice_with_pairs,
)

if TYPE_CHECKING:
    from ....agent.agent import Agent
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
        preserve_recent: int = 0,
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

        summarize_count = max(1, int(len(eligible) * self._removal_ratio))
        to_summarize = eligible[:summarize_count]

        identity_map = {id(msg): index for index, msg in enumerate(messages)}
        safe_ids: set[int] = set()
        for message in to_summarize:
            index = identity_map.get(id(message))
            if index is None:
                continue
            for removable in _collect_removable_with_pair(messages, index):
                safe_ids.add(id(removable))
        safe = [msg for msg in messages if id(msg) in safe_ids]
        if not safe:
            return False

        content_blocks = _flatten_messages_to_content(safe)
        summary = await _summarize_content(content_blocks, model, self._config)
        if not summary:
            return False

        total_tokens = await model.count_tokens(safe)

        removed, lowest_index = _splice_with_pairs(messages, safe)
        if removed == 0:
            return False

        summary_message = Message(
            role="user",
            content=[ContentBlock(text=_format_summarized(f"{removed} messages", total_tokens, summary))],
        )
        insert_index = max(1, min(lowest_index, len(messages)))
        messages.insert(insert_index, summary_message)

        _repair_alternation(messages)
        logger.debug("summarized=<%s>, tokens=<%s> | batched summarization complete", removed, total_tokens)
        return True

    async def _replace_block(
        self,
        block: ContentBlock,
        tokens: int,
        message: Message,
        agent: Agent,
        stash_refs: list[str],
    ) -> ContentBlock | None:
        model = self._resolve_model(agent)
        if not model:
            return None

        refs = _format_stash_refs(stash_refs)

        if "toolResult" in block:
            tool_result = block["toolResult"]
            content_blocks = _tool_result_to_content_blocks(tool_result["content"])
            summary = await _summarize_content(content_blocks, model, self._config)
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

        if "text" not in block:
            summary = await _summarize_content([block], model, self._config)
            if summary:
                logger.debug(
                    "tracking_id=<%s>, tokens=<%s> | summarized media block", message.get("tracking_id"), tokens
                )
                marker = _format_summarized("media block", tokens, summary) + refs
                return ContentBlock(text=marker)
            logger.debug("tracking_id=<%s>, tokens=<%s> | offloaded media block", message.get("tracking_id"), tokens)
            return ContentBlock(text=f"[Offloaded: ~{tokens} tokens]{refs}")

        summary = await _summarize_content([ContentBlock(text=block["text"])], model, self._config)
        if not summary:
            return None

        logger.debug("tracking_id=<%s>, tokens=<%s> | summarized text block", message.get("tracking_id"), tokens)
        marker = _format_summarized("text block", tokens, summary) + refs
        return ContentBlock(text=marker)

    def _resolve_model(self, agent: Agent) -> Model | None:
        return self._config.get("model") or agent.model

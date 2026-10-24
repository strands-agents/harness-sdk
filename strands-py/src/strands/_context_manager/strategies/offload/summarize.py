"""Summarize strategy — replaces oversized content with LLM-generated summaries."""

from __future__ import annotations

import logging
import math
from typing import TYPE_CHECKING

from ....agent.conversation_manager.compression.pin_message import is_pinned
from ....types.content import ContentBlock, Message, Messages
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

        if await self._try_server_compaction(context):
            return True

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

    async def _try_server_compaction(self, context: ContextState) -> bool:
        """Summarize the history before the kept turns server side, so their replayed thinking stays valid.

        Applies only to whole-history summarization on the agent's own model, when that model supports it.
        The history keeps the same layout as the client-side summary.
        """
        agent = context.agent
        if self._target != "*" or self._threshold is not None or "model" in self._config:
            return False
        if getattr(agent.model, "_supports_server_compaction", False) is not True:
            return False

        messages = context.messages
        cut = self._compaction_cut(messages)
        if cut is None:
            return False

        try:
            summary = await agent.model._compact(  # type: ignore[attr-defined]
                messages[:cut],
                system_prompt_content=agent.system_prompt_content,
                tool_specs=agent.tool_registry.get_all_tool_specs(),
            )
        except Exception as error:
            logger.warning("error=<%s> | server compaction failed, summarizing client side", error)
            return False
        if not summary:
            return False

        removed = messages[1:cut]
        total_tokens = await agent.model.count_tokens(removed)
        del messages[1:cut]
        _insert_marker(messages, 1, _format_summarized(f"{len(removed)} messages", total_tokens, summary))
        logger.debug("summarized=<%s>, tokens=<%s> | server compaction complete", len(removed), total_tokens)
        return True

    def _compaction_cut(self, messages: Messages) -> int | None:
        """Index of the first kept message: the latest assistant reply to a user message before the kept turns.

        Cutting at the end of a request already sent never splits a tool use from its result. Pinned messages
        are kept.
        """
        preserve = self._preserve_recent
        resolved = math.ceil(len(messages) * preserve) if 0 < preserve < 1 else int(preserve)
        first_pinned = next((index for index in range(1, len(messages)) if is_pinned(messages, index)), len(messages))
        upper = min(len(messages) - max(resolved, 1), first_pinned)
        return next(
            (
                cut
                for cut in range(upper, 1, -1)
                if messages[cut - 1]["role"] == "user" and messages[cut]["role"] == "assistant"
            ),
            None,
        )

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

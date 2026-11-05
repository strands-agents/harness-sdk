"""Truncate strategy — replaces oversized content with a preview."""

from __future__ import annotations

import json
import logging
import math
from typing import TYPE_CHECKING

from ....agent.conversation_manager.compression.pin_message import is_pinned
from ....types.content import ContentBlock, Message, Messages
from ...methods.summarize import _SUMMARIZED_PREFIX
from ...methods.truncate import (
    _TRUNCATED_PREFIX,
    CHARS_PER_TOKEN,
    DEFAULT_PREVIEW_TOKENS,
    TruncateConfig,
    _truncate_text_block,
    _truncate_tool_result,
)
from ...stash import Stash, _format_stash_refs
from ...types import is_text_block
from .base import (
    BaseOffloadStrategy,
    OffloadConditions,
    OffloadTarget,
    _build_conditions,
    _build_tool_name_map,
    _insert_marker,
    _repair_alternation,
    _splice_with_pairs,
)

if TYPE_CHECKING:
    from ....agent.agent import Agent
    from ....agent.invocation_context import InvocationContext

from ...types import ContextState

logger = logging.getLogger(__name__)


def _append_stash_refs_to_tool_result(block: ContentBlock, refs: str) -> None:
    """Append stash ref annotation to the first text entry of a tool result in place."""
    if "toolResult" not in block:
        return
    for item in block["toolResult"]["content"]:
        if "text" in item:
            item["text"] += f"\n\n[Stashed]{refs}"
            return


class TruncateStrategy(BaseOffloadStrategy):
    """Truncate strategy — replaces oversized content with a head/tail preview."""

    @property
    def name(self) -> str:
        """Strategy name."""
        return "offload:truncate"

    def __init__(
        self,
        target: OffloadTarget | None = None,
        config: TruncateConfig | None = None,
        conditions: OffloadConditions | None = None,
    ) -> None:
        super().__init__(target, conditions)
        self._truncate_config: TruncateConfig = config or {}

        raw_preview = self._truncate_config.get("preview_tokens", 1000)
        preview_tokens = raw_preview if isinstance(raw_preview, (int, float)) and math.isfinite(raw_preview) else 1000

        if (
            conditions
            and "threshold" in conditions
            and isinstance(conditions["threshold"], (int, float))
            and conditions["threshold"] <= preview_tokens
        ):
            raise ValueError(
                f"threshold ({conditions['threshold']}) must be greater than preview_tokens ({preview_tokens}) "
                "to ensure truncation converges"
            )

    def when(
        self,
        *,
        threshold: int | None = None,
        utilization: float | None = None,
        preserve_recent: int | float = 0,
    ) -> TruncateStrategy:
        """Return a new instance with the given conditions applied."""
        return TruncateStrategy(
            self._target,
            self._truncate_config,
            _build_conditions(threshold=threshold, utilization=utilization, preserve_recent=preserve_recent),
        )

    def _make_removal_marker(self, count: int) -> str:
        word = "message" if count == 1 else "messages"
        return f"[... {count} {word} elided ...]"

    async def _replace_block(
        self,
        block: ContentBlock,
        tokens: int,
        message: Message,
        agent: Agent,
        stash_refs: list[str],
        invocation_context: InvocationContext | None = None,
        config: TruncateConfig | None = None,
    ) -> ContentBlock | None:
        config = config or self._truncate_config
        refs = _format_stash_refs(stash_refs)
        if "toolResult" in block:
            tool_use_id = block["toolResult"]["toolUseId"]
            logger.debug("tool_use_id=<%s>, tokens=<%s> | truncated tool result", tool_use_id, tokens)
            truncated_result = _truncate_tool_result(block["toolResult"], config)
            if truncated_result is block["toolResult"]:
                return block
            truncated = ContentBlock(toolResult=truncated_result)
            if refs:
                _append_stash_refs_to_tool_result(truncated, refs)
            return truncated
        if is_text_block(block):
            logger.debug("tracking_id=<%s>, tokens=<%s> | truncated text block", message.get("tracking_id"), tokens)
            result = _truncate_text_block(block, config)
            if result is block:
                return block
            if refs and "text" in result:
                result = ContentBlock(text=result["text"] + f"\n\n[Stashed]{refs}")
            return result
        logger.debug("tracking_id=<%s>, tokens=<%s> | offloaded media block", message.get("tracking_id"), tokens)
        return ContentBlock(text=f"[Offloaded: ~{tokens} tokens]{refs}")


_EMERGENCY_REMOVAL_RATIO = 0.2
_EMERGENCY_TARGET_UTILIZATION = 0.9
_EMERGENCY_MIN_CUT = 0.25
_FULL_PREVIEW_CHARS = DEFAULT_PREVIEW_TOKENS * CHARS_PER_TOKEN


def _text_size(block: ContentBlock) -> int:
    """Characters of previewable text in a block: its text, or the joined text and JSON items of a tool result."""
    if is_text_block(block):
        return len(block["text"])
    if "toolResult" not in block:
        return 0
    textual = [
        item["text"] if "text" in item else json.dumps(item["json"])
        for item in block["toolResult"]["content"]
        if "text" in item or "json" in item
    ]
    return len("\n".join(textual))


def _first_text(block: ContentBlock) -> str:
    items = [block] if is_text_block(block) else block.get("toolResult", {}).get("content", [])
    return str(items[0].get("text", "")) if items else ""


def _is_truncated(block: ContentBlock) -> bool:
    return _first_text(block).startswith(_TRUNCATED_PREFIX)


def _is_protected(messages: Messages, index: int, block: ContentBlock) -> bool:
    """The head message, pinned messages and summaries are cut last: they hold the context other strategies kept."""
    return index == 0 or is_pinned(messages, index) or _first_text(block).startswith(_SUMMARIZED_PREFIX)


def _total_text_size(messages: Messages) -> int:
    return sum(_text_size(block) for message in messages for block in message["content"])


class EmergencyTruncateStrategy(TruncateStrategy):
    """Last-resort strategy for a context that still overflows after every other strategy ran.

    Drops the oldest 20% of messages while more than three remain, then truncates the largest text blocks
    until the history is estimated to fit, so an overflow carried by a few messages recovers as well.
    """

    @property
    def name(self) -> str:
        """Strategy name."""
        return "offload:emergency-truncate"

    def __init__(self) -> None:
        super().__init__("*")

    def init(self, agent: Agent, stash: Stash | None = None) -> None:
        """No eager hooks for emergency truncation."""
        self._stash = stash

    async def apply(self, context: ContextState) -> bool:
        """Fire when overflow is set, or when recomputed utilization >= 1.0."""
        utilization = context.utilization
        if not context.overflow:
            tokens = await context.agent.model.count_tokens(context.messages)
            utilization = context.agent.model.estimate_utilization(tokens)
            if utilization < 1.0:
                return False
        chars_before = _total_text_size(context.messages)
        dropped = await self._apply_per_message(context)
        # Scale the utilization by the text that survived the drop to estimate how much is still in excess.
        fits_chars = chars_before * _EMERGENCY_TARGET_UTILIZATION / utilization if utilization > 0 else 0
        chars_now = _total_text_size(context.messages)
        excess_chars = chars_now - fits_chars
        if context.overflow:
            # The model rejected the input, so the local count (messages only, no system prompt or tool specs, a
            # heuristic tokenizer) is optimistic by an unknown margin: remove at least a quarter of the text per pass,
            # counting what the drop removed, so the 3-retry cap cannot run out on a context the count undersells by 2x.
            excess_chars = max(excess_chars, chars_before * _EMERGENCY_MIN_CUT - (chars_before - chars_now))
        truncated = await self._truncate_largest_text_blocks(context, excess_chars)
        return dropped or truncated

    async def _apply_per_message(self, context: ContextState) -> bool:
        """Drop the oldest 20% of non-head messages each pass.

        Pins are intentionally ignored so an all-pinned overflow is still recoverable.
        """
        messages = context.messages
        if len(messages) <= 3:
            return False

        removable = [msg for index, msg in enumerate(messages) if index > 0]
        remove_count = max(1, int(len(removable) * _EMERGENCY_REMOVAL_RATIO))
        # Cut just before an assistant message, which holds no tool result to orphan and never merges into message 0.
        if removable[remove_count]["role"] != "assistant":
            remove_count += 1
        to_remove = removable[:remove_count]

        removed, lowest_index = _splice_with_pairs(messages, to_remove)
        if removed == 0:
            return False

        _insert_marker(messages, lowest_index, self._make_removal_marker(removed))
        _repair_alternation(messages)
        return True

    async def _truncate_largest_text_blocks(self, context: ContextState, excess_chars: float) -> bool:
        """Truncate untruncated text blocks, largest first, until ``excess_chars`` characters are gone.

        Each block keeps at most a quarter of its text as preview (never more than the default preview), so
        every truncation removes most of the block. Ties go to the oldest block. Protected blocks (head message,
        pinned messages, summaries) are only cut once every other block is, so an overflow that lives in one of
        them still recovers. Already truncated blocks are skipped unless they are still larger than a full
        preview, so a block that merely starts with the marker cannot stall the recovery.
        """
        messages = context.messages
        tool_name_map = _build_tool_name_map(messages)
        candidates = sorted(
            (
                (_is_protected(messages, index, block), -_text_size(block), index, block_index)
                for index, message in enumerate(messages)
                for block_index, block in enumerate(message["content"])
                if self._block_matches_target(block, message, tool_name_map)
                and (_text_size(block) > _FULL_PREVIEW_CHARS or (_text_size(block) > 0 and not _is_truncated(block)))
            )
        )
        saved = 0
        truncated = 0
        for _, negative_size, index, block_index in candidates:
            if saved >= excess_chars:
                break
            size = -negative_size
            message = messages[index]
            block = message["content"][block_index]
            config = TruncateConfig(preview_tokens=min(DEFAULT_PREVIEW_TOKENS, size // (4 * CHARS_PER_TOKEN)))
            stash_refs = self._stash.refs_for(block, message, block_index) if self._stash else []
            replacement = await self._replace_block(
                block, size // CHARS_PER_TOKEN, message, context.agent, stash_refs, config=config
            )
            if replacement is None or replacement is block:
                continue
            message["content"][block_index] = replacement
            saved += size - _text_size(replacement)
            truncated += 1
        if truncated:
            logger.warning(
                "truncated_blocks=<%d>, saved_chars=<%d> | emergency truncation of the largest text blocks",
                truncated,
                saved,
            )
        return truncated > 0

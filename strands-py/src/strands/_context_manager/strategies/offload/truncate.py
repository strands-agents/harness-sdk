"""Truncate strategy — keeps a head/tail preview of oversized blocks, or of the old messages."""

from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING

from ....types.content import ContentBlock, Message
from ...methods.truncate import (
    TruncateConfig,
    _is_truncated,
    _resolve_head_share,
    _resolve_preview_tokens,
    _truncate_text_block,
    _truncate_tool_result,
)
from ...stash import Stash, _format_stash_refs
from ...types import is_text_block
from .base import (
    BaseOffloadStrategy,
    OffloadConditions,
    OffloadTarget,
    _insert_marker,
    _repair_alternation,
    _splice_with_pairs,
)

if TYPE_CHECKING:
    from ....agent.agent import Agent
    from ....agent.invocation_context import InvocationContext

from ...types import ContextState

logger = logging.getLogger(__name__)

_ELISION_MARKER = re.compile(r"\[\.\.\. \d+ messages? elided \.\.\.\]")


def _append_stash_refs_to_tool_result(block: ContentBlock, refs: str) -> None:
    """Append stash ref annotation to the first text entry of a tool result in place."""
    if "toolResult" not in block:
        return
    for item in block["toolResult"]["content"]:
        if "text" in item:
            item["text"] += f"\n\n[Stashed]{refs}"
            return


class TruncateStrategy(BaseOffloadStrategy):
    """Truncate strategy — keeps a head/tail preview of oversized blocks, or of the old messages."""

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
        self._truncate_config: TruncateConfig = config or {}
        super().__init__(target, conditions)

        preview_tokens = _resolve_preview_tokens(self._truncate_config)
        threshold = (conditions or {}).get("threshold")
        # A percent resolves against the window at apply time; skipping already-truncated blocks keeps it convergent.
        if isinstance(threshold, int) and threshold <= preview_tokens:
            raise ValueError(
                f"threshold ({threshold}) must be greater than preview_tokens ({preview_tokens}) "
                "to ensure truncation converges"
            )

    def _default_threshold(self) -> int:
        return _resolve_preview_tokens(self._truncate_config)

    async def _apply_per_message(self, context: ContextState) -> bool:
        """Keep the head and tail of the old messages within ``preview_tokens`` and elide the middle."""
        messages = context.messages
        # Skipping earlier markers lets a pass with nothing new to elide return False instead of re-eliding them.
        eligible = [msg for msg in self._get_eligible_messages(context) if not _has_elision_marker(msg)]
        middle = await self._middle_of(eligible, context.agent)
        if not middle:
            return False

        removed, lowest_index = _splice_with_pairs(messages, middle)
        if removed == 0:
            return False

        _insert_marker(messages, lowest_index, self._make_removal_marker(removed))
        _repair_alternation(messages)
        return True

    async def _middle_of(self, eligible: list[Message], agent: Agent) -> list[Message]:
        preview_tokens = _resolve_preview_tokens(self._truncate_config)
        head_budget = int(preview_tokens * _resolve_head_share(self._truncate_config))
        head = await _count_within_budget(eligible, head_budget, agent)
        tail = await _count_within_budget(eligible[head:][::-1], preview_tokens - head_budget, agent)
        return eligible[head : len(eligible) - tail]

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
    ) -> ContentBlock | None:
        if _is_truncated(block):
            return None
        refs = _format_stash_refs(stash_refs)
        if "toolResult" in block:
            tool_use_id = block["toolResult"]["toolUseId"]
            logger.debug("tool_use_id=<%s>, tokens=<%s> | truncated tool result", tool_use_id, tokens)
            truncated_result = _truncate_tool_result(block["toolResult"], self._truncate_config)
            if truncated_result is block["toolResult"]:
                return block
            truncated = ContentBlock(toolResult=truncated_result)
            if refs:
                _append_stash_refs_to_tool_result(truncated, refs)
            return truncated
        if is_text_block(block):
            logger.debug("tracking_id=<%s>, tokens=<%s> | truncated text block", message.get("tracking_id"), tokens)
            result = _truncate_text_block(block, self._truncate_config)
            if result is block:
                return block
            if refs and "text" in result:
                result = ContentBlock(text=result["text"] + f"\n\n[Stashed]{refs}")
            return result
        logger.debug("tracking_id=<%s>, tokens=<%s> | offloaded media block", message.get("tracking_id"), tokens)
        return ContentBlock(text=f"[Offloaded: ~{tokens} tokens]{refs}")


async def _count_within_budget(messages: list[Message], budget: int, agent: Agent) -> int:
    """Count how many leading messages fit within ``budget`` tokens."""
    used = 0
    for count, message in enumerate(messages):
        used += await agent.model.count_tokens([message])
        if used > budget:
            return count
    return len(messages)


def _has_elision_marker(message: Message) -> bool:
    return any(is_text_block(block) and _ELISION_MARKER.fullmatch(block["text"]) for block in message["content"])


_EMERGENCY_REMOVAL_RATIO = 0.2


class EmergencyTruncateStrategy(TruncateStrategy):
    """Last-resort strategy that drops the oldest 20% of messages when still overflowing."""

    @property
    def name(self) -> str:
        """Strategy name."""
        return "offload:emergency-truncate"

    def __init__(self) -> None:
        super().__init__("*", {"preview": "tail"})

    def init(self, agent: Agent, stash: Stash | None = None) -> None:
        """No eager hooks for emergency truncation."""
        self._stash = stash

    async def apply(self, context: ContextState) -> bool:
        """Fire when overflow is set, or when recomputed utilization >= 1.0."""
        if len(context.messages) <= 3:
            return False
        if not context.overflow:
            tokens = await context.agent.model.count_tokens(context.messages)
            utilization = context.agent.model.estimate_utilization(tokens)
            if utilization < 1.0:
                return False
        return await self._apply_per_message(context)

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

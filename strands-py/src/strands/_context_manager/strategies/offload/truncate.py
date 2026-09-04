"""Truncate strategy — replaces oversized content with a preview."""

from __future__ import annotations

import logging
import math
from typing import TYPE_CHECKING

from ....types.content import ContentBlock, Message
from ...methods.truncate import TruncateConfig, _truncate_text_block, _truncate_tool_result
from ...stash import Stash, _format_stash_refs
from ...types import is_text_block
from .base import (
    BaseOffloadStrategy,
    OffloadConditions,
    OffloadTarget,
    _build_conditions,
    _repair_alternation,
    _splice_with_pairs,
)

if TYPE_CHECKING:
    from ....agent.agent import Agent

from ...types import ContextState

logger = logging.getLogger(__name__)


def _append_stash_refs_to_tool_result(block: ContentBlock, refs: str) -> None:
    """Append stash ref annotation to the first text entry of a tool result in place."""
    if "toolResult" not in block:
        return
    for item in block["toolResult"]["content"]:
        if "text" in item:
            item["text"] += f"\n\n[Stashed:{refs}]"
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
        preserve_recent: int = 0,
    ) -> TruncateStrategy:
        """Return a new instance with the given conditions applied."""
        return TruncateStrategy(
            self._target,
            self._truncate_config,
            _build_conditions(threshold=threshold, utilization=utilization, preserve_recent=preserve_recent),
        )

    def _make_removal_marker(self, count: int) -> str | None:
        word = "message" if count == 1 else "messages"
        return f"[... {count} {word} elided ...]"

    async def _apply_per_message(self, context: ContextState) -> bool:
        """Message-level truncation: remove middle messages, keep head/tail."""
        messages = context.messages
        if len(messages) <= 1:
            return False

        eligible = await self._get_eligible_messages(context)
        if not eligible:
            return False

        preview_mode = self._truncate_config.get("preview", "head_tail")
        head_share = {"head": 1.0, "tail": 0.0, "head_tail": 0.3}.get(preview_mode, 0.3)
        target_removal = max(1, int(len(eligible) * self._removal_ratio))
        keep_count = len(eligible) - target_removal

        head_keep = int(keep_count * head_share)
        tail_keep = keep_count - head_keep

        end_slice = len(eligible) - tail_keep if tail_keep > 0 else len(eligible)
        middle_messages = eligible[head_keep:end_slice]

        if not middle_messages:
            return False

        removed, lowest_index = _splice_with_pairs(messages, middle_messages)
        if removed == 0:
            return False

        marker = self._make_removal_marker(removed)
        if marker:
            insert_index = max(1, min(lowest_index, len(messages)))
            messages.insert(insert_index, Message(role="user", content=[ContentBlock(text=marker)]))

        _repair_alternation(messages)
        return True

    async def _replace_block(
        self,
        block: ContentBlock,
        tokens: int,
        message: Message,
        agent: Agent,
        stash_refs: list[str],
    ) -> ContentBlock | None:
        refs = _format_stash_refs(stash_refs)
        if "toolResult" in block:
            tool_use_id = block["toolResult"]["toolUseId"]
            logger.debug("tool_use_id=<%s>, tokens=<%s> | truncated tool result", tool_use_id, tokens)
            truncated = ContentBlock(toolResult=_truncate_tool_result(block["toolResult"], self._truncate_config))
            if truncated is not block and refs:
                _append_stash_refs_to_tool_result(truncated, refs)
            return truncated
        if is_text_block(block):
            logger.debug("tracking_id=<%s>, tokens=<%s> | truncated text block", message.get("tracking_id"), tokens)
            result = _truncate_text_block(block, self._truncate_config)
            if result is not None and refs and "text" in result:
                result = ContentBlock(text=result["text"] + f"\n\n[Stashed:{refs}]")
            return result
        logger.debug("tracking_id=<%s>, tokens=<%s> | offloaded media block", message.get("tracking_id"), tokens)
        return ContentBlock(text=f"[Offloaded: ~{tokens} tokens{refs}]")


class EmergencyTruncateStrategy(TruncateStrategy):
    """Last-resort strategy that drops the oldest 20% of messages when still overflowing."""

    _removal_ratio: float = 0.2

    @property
    def name(self) -> str:
        """Strategy name."""
        return "offload:emergency-truncate"

    def __init__(self) -> None:
        super().__init__("*", {"preview": "tail"})

    def init(self, agent: Agent, stash: Stash | None = None) -> None:
        """No eager hooks for emergency truncation."""
        self._stash = stash

    def _make_removal_marker(self, count: int) -> str | None:
        return None

    async def apply(self, context: ContextState) -> bool:
        """Fire only when utilization >= 1.0 and messages > 3."""
        if len(context.messages) <= 3:
            return False
        tokens = await context.agent.model.count_tokens(context.messages)
        utilization = context.agent.model.estimate_utilization(tokens)
        if utilization < 1.0:
            return False
        state = ContextState(messages=context.messages, agent=context.agent, utilization=utilization)
        return await self._apply_per_message(state)

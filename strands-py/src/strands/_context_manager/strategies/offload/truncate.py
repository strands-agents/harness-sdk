"""Truncate strategy — replaces oversized content with a preview."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from ....types.content import ContentBlock, Message
from ...message_trimming import placeholder_for, remove_messages, with_pairs
from ...methods.truncate import (
    TruncateConfig,
    _head_share,
    _resolve_preview_tokens,
    _truncate_text_block,
    _truncate_tool_result_block,
)
from ...placeholder import format_elided, format_offloaded, is_offloaded, placeholder_result
from ...types import ContextState, is_text_block, is_tool_result_block
from .base import BaseOffloadStrategy
from .conditions import OffloadConditions
from .target import OffloadTarget, media_kind

if TYPE_CHECKING:
    from ....agent.agent import Agent
    from ....agent.invocation_context import InvocationContext
    from ...stash import Stash

logger = logging.getLogger(__name__)


class TruncateStrategy(BaseOffloadStrategy):
    """Truncate strategy — replaces oversized content with a head/tail preview."""

    def __init__(
        self,
        target: OffloadTarget,
        config: TruncateConfig | None = None,
        conditions: OffloadConditions | None = None,
    ) -> None:
        """Build the strategy.

        Args:
            target: Content the strategy truncates.
            config: Preview budget and which portion of the content to keep.
            conditions: When and how the strategy fires.

        Raises:
            ValueError: When target ``"*"`` is given a ``block_threshold``, or a token-count ``block_threshold`` is
                no larger than ``preview_tokens``.
        """
        super().__init__("truncate", target, conditions)
        self._truncate_config: TruncateConfig = config or {}
        self._preview_tokens = _resolve_preview_tokens(self._truncate_config)

        # Every message over a threshold is larger than preview_tokens, so middle-out would elide them all, as drop
        # does.
        if target == "*" and self._conditions.block_threshold:
            raise ValueError(
                'Offload.truncate("*") doesn\'t take a block_threshold; use Offload.drop("*") to remove large'
                ' messages, or Offload.truncate("tool_results") to preview large blocks'
            )
        # A percent needs the context window, so init checks it.
        threshold = self._conditions.block_threshold
        if threshold and not threshold.is_share:
            self._check_threshold_exceeds_preview(int(threshold.value), str(int(threshold.value)))

    def _with_conditions(self, conditions: OffloadConditions) -> TruncateStrategy:
        return TruncateStrategy(self._target, self._truncate_config, conditions)

    def init(self, agent: Agent, stash: Stash | None = None) -> None:
        """Check a percent ``block_threshold`` against ``preview_tokens``, then initialize the strategy.

        Args:
            agent: The agent this strategy is attached to.
            stash: The stash offloaded content is stored in.

        Raises:
            ValueError: When a percent ``block_threshold`` of the context window is no larger than ``preview_tokens``,
                or the base strategy's conditions can't run on this agent.
        """
        threshold = self._conditions.block_threshold
        tokens = self._conditions.threshold_tokens(agent)
        if threshold is not None and threshold.is_share and tokens is not None:
            self._check_threshold_exceeds_preview(tokens, f"{tokens} tokens of the context window")
        super().init(agent, stash)

    def _check_threshold_exceeds_preview(self, tokens: int, shown: str) -> None:
        """Check the threshold leaves room for a preview, so truncating a block takes it below the threshold.

        Raises:
            ValueError: When the threshold is no larger than ``preview_tokens``.
        """
        if tokens > self._preview_tokens:
            return
        raise ValueError(
            f"block_threshold ({shown}) must be greater than preview_tokens ({self._preview_tokens}) to ensure"
            " truncation converges; raise block_threshold or lower preview_tokens"
        )

    async def _apply_per_message(self, context: ContextState) -> bool:
        """Middle-out: keeps the oldest and newest eligible messages within the preview budget and elides the rest."""
        messages = context.messages
        selected = await self._select_middle(await self._removable_messages(context), context.agent)
        middle = with_pairs(messages, selected)
        # A middle of only placeholders has nothing new to elide.
        if all(is_offloaded(block) for message in middle for block in message["content"]):
            return False
        text_for = placeholder_for(context.agent.model, format_elided)
        return await remove_messages(messages, middle, text_for, "truncate", self._stash)

    async def _select_middle(self, eligible: list[Message], agent: Agent) -> list[Message]:
        """The eligible messages between the head and the tail kept within the preview token budget."""
        head_budget = self._preview_tokens * _head_share(self._truncate_config)
        head_count = await _count_within_budget(eligible, head_budget, agent)
        rest = eligible[head_count:]
        tail_count = await _count_within_budget(rest[::-1], self._preview_tokens - head_budget, agent)
        return rest[: len(rest) - tail_count]

    async def _replace_block(
        self,
        block: ContentBlock,
        tokens: int,
        message: Message,
        agent: Agent,
        stash_ref: str | None,
        tool_name: str | None,
        invocation_context: InvocationContext | None = None,
    ) -> ContentBlock | None:
        if is_tool_result_block(block):
            tool_result = block["toolResult"]
            truncated = _truncate_tool_result_block(tool_result, self._truncate_config)
            if truncated is None:
                return None
            logger.debug("tool_use_id=<%s>, tokens=<%s> | truncated tool result", tool_result["toolUseId"], tokens)
            placeholder = self._placeholder(truncated.preview, stash_ref, tokens)
            return placeholder_result(tool_result, [placeholder, *truncated.kept])

        if is_text_block(block):
            preview = _truncate_text_block(block, self._truncate_config)
            if preview is None:
                return None
            logger.debug("tracking_id=<%s>, tokens=<%s> | truncated text block", message.get("tracking_id"), tokens)
            return self._placeholder(preview, stash_ref, tokens)

        logger.debug("tracking_id=<%s>, tokens=<%s> | offloaded media block", message.get("tracking_id"), tokens)
        return self._placeholder(format_offloaded(tokens, media_kind(block)), stash_ref, tokens)


async def _count_within_budget(messages: list[Message], budget: float, agent: Agent) -> int:
    """How many leading messages fit within ``budget`` tokens."""
    total = 0
    count = 0
    for message in messages:
        total += await agent.model.count_tokens([message])
        if total > budget:
            break
        count += 1
    return count

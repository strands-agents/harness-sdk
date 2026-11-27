"""Drop strategy — removes matching content from the context window entirely."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from ....types.content import ContentBlock, Message
from ....types.tools import ToolResultContent
from ...message_trimming import remove_messages
from ...placeholder import format_dropped, format_dropped_messages
from ...types import ContextState
from .base import BaseOffloadStrategy
from .conditions import OffloadConditions
from .target import OffloadTarget, media_kind

if TYPE_CHECKING:
    from ....agent.agent import Agent
    from ....agent.invocation_context import InvocationContext

logger = logging.getLogger(__name__)


class DropStrategy(BaseOffloadStrategy):
    """Drop strategy — replaces matching content with a ``[Dropped]`` placeholder."""

    def __init__(self, target: OffloadTarget, conditions: OffloadConditions | None = None) -> None:
        """Build the strategy.

        Args:
            target: Content the strategy drops.
            conditions: When and how the strategy fires.
        """
        super().__init__("drop", target, conditions)

    def _with_conditions(self, conditions: OffloadConditions) -> DropStrategy:
        return DropStrategy(self._target, conditions)

    async def _apply_per_message(self, context: ContextState) -> bool:
        removable = await self._removable_messages(context)
        model = context.agent.model
        return await remove_messages(
            context.messages, removable, model, format_dropped_messages, "drop", context.archive
        )

    async def _replace_block(
        self,
        block: ContentBlock,
        tokens: int,
        message: Message,
        agent: Agent,
        tool_name: str | None,
        invocation_context: InvocationContext | None = None,
    ) -> tuple[str, list[ToolResultContent]] | None:
        logger.debug("tracking_id=<%s> | dropped block from context window", message.get("tracking_id"))
        return format_dropped(tokens, media_kind(block)), []

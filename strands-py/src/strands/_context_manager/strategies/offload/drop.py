"""Drop strategy — removes matching content from the context window entirely."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from ....types.content import ContentBlock, Message
from ....types.tools import ToolResult, ToolResultContent
from ...stash import _format_stash_refs
from .base import BaseOffloadStrategy, OffloadConditions, OffloadTarget

if TYPE_CHECKING:
    from ....agent.agent import Agent
    from ....agent.invocation_context import InvocationContext

logger = logging.getLogger(__name__)

DROPPED_MARKER = "[Dropped]"


class DropStrategy(BaseOffloadStrategy):
    """Drop strategy — removes old messages, or replaces matching blocks with a [Dropped] marker."""

    @property
    def name(self) -> str:
        """Strategy name."""
        return "offload:drop"

    def __init__(self, target: OffloadTarget | None = None, conditions: OffloadConditions | None = None) -> None:
        super().__init__(target, conditions)

    def _make_removal_marker(self, count: int) -> str:
        word = "message" if count == 1 else "messages"
        return f"[Dropped: {count} {word}]"

    async def _replace_block(
        self,
        block: ContentBlock,
        tokens: int,
        message: Message,
        agent: Agent,
        stash_refs: list[str],
        invocation_context: InvocationContext | None = None,
    ) -> ContentBlock | None:
        marker = f"{DROPPED_MARKER}{_format_stash_refs(stash_refs)}"
        if "toolResult" in block:
            tool_result = block["toolResult"]
            logger.debug("tool_use_id=<%s> | dropped tool result from context window", tool_result["toolUseId"])
            dropped_content: list[ToolResultContent] = [{"text": marker}]
            return ContentBlock(
                toolResult=ToolResult(
                    toolUseId=tool_result["toolUseId"],
                    status=tool_result["status"],
                    content=dropped_content,
                )
            )
        logger.debug("tracking_id=<%s> | dropped block from context window", message.get("tracking_id"))
        return ContentBlock(text=marker)

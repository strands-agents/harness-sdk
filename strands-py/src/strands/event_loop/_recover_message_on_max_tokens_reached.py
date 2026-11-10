"""Message recovery utilities for handling max token limit scenarios.

This module provides functionality to recover and clean up incomplete messages that occur
when model responses are truncated due to maximum token limits being reached. It specifically
handles cases where tool use blocks are incomplete or malformed due to truncation.
"""

import logging

from ..types.content import ContentBlock, Message
from ..types.tools import ToolUse

logger = logging.getLogger(__name__)


def recover_message_on_max_tokens_reached(message: Message) -> Message:
    """Recover and clean up messages when max token limits are reached.

    When a model response is truncated due to maximum token limits, all tool use blocks
    should be replaced with informative error messages since they may be incomplete or
    unreliable. This function inspects the message content and:

    1. Identifies all tool use blocks (regardless of validity)
    2. Replaces all tool uses with informative error messages
    3. Preserves all non-tool content blocks (text, images, etc.)
    4. Returns a cleaned message suitable for conversation history

    This recovery mechanism ensures that the conversation can continue gracefully even when
    model responses are truncated, providing clear feedback about what happened and preventing
    potentially incomplete or corrupted tool executions.

    Args:
        message: The potentially incomplete message from the model that was truncated
                due to max token limits.

    Returns:
        A cleaned Message with all tool uses replaced by explanatory text content.
        The returned message maintains the same role as the input message.

    Example:
        If a message contains any tool use (complete or incomplete):
        ```
        {"toolUse": {"name": "calculator", "input": {"expression": "2+2"}, "toolUseId": "123"}}
        ```

        It will be replaced with:
        ```
        {"text": "The selected tool calculator's tool use was incomplete due to maximum token limits being reached."}
        ```
    """
    logger.info("handling max_tokens stop reason - replacing all tool uses with error messages")

    valid_content: list[ContentBlock] = []
    for content in message["content"] or []:
        tool_use: ToolUse | None = content.get("toolUse")
        if not tool_use:
            valid_content.append(content)
            continue

        # Replace all tool uses with error messages when max_tokens is reached
        display_name = tool_use.get("name") or "<unknown>"
        logger.warning("tool_name=<%s> | replacing with error message due to max_tokens truncation.", display_name)

        valid_content.append(
            {
                "text": f"The selected tool {display_name}'s tool use was incomplete due "
                f"to maximum token limits being reached."
            }
        )

    recovered: Message = {"content": valid_content, "role": message["role"]}
    if "metadata" in message:
        recovered["metadata"] = message["metadata"]
    return recovered

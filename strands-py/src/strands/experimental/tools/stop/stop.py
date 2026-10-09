"""Tool for gracefully ending the agent loop.

This tool is experimental and subject to change in future revisions without notice.

Provides :func:`make_stop` (a factory for customized stop tools) and :data:`stop`
(the default instance). The tool calls ``agent.cancel(message=..., after_current_tools=True)``:
any sibling tools in the same batch run to completion, then the loop exits with
``stop_reason == "cancelled"`` and the message as the final assistant message.
The same message is returned as the tool result the model sees for its stop request.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ....tools.decorator import tool
from ....types.tools import ToolContext

if TYPE_CHECKING:
    from ....tools.decorator import DecoratedFunctionTool

_DEFAULT_MESSAGE = "Agent loop stopped."
DEFAULT_MAX_MESSAGE_LENGTH = 4096
"""Default cap on the stop ``message`` length. The cap exists so a runaway model
can't blow the conversation history in one shot; adjust via
``make_stop(max_message_length=...)`` when a longer summary is legitimate."""

DEFAULT_STOP_DESCRIPTION = (
    "Gracefully ends the agent loop when the task is complete. "
    "Call this tool once with an optional final message when no further work is needed. "
    "This is a cooperative stop, not an abort: any tools already requested in this turn still run."
)


def _validate_message(message: str | None, max_length: int) -> str:
    """Validate an optional stop message and return the effective value.

    Args:
        message: The model-supplied message, or ``None`` for the default.
        max_length: The configured upper bound on the returned message length.

    Returns:
        The validated message string. Empty or ``None`` becomes the default so
        the assistant-facing final turn is never blank.

    Raises:
        ValueError: If ``message`` is not a string or exceeds the length cap.
    """
    if message is None or message == "":
        return _DEFAULT_MESSAGE
    if not isinstance(message, str):
        raise ValueError(f"`message` must be a string, got {type(message).__name__}")
    if len(message) > max_length:
        raise ValueError(f"`message` length exceeds the maximum of {max_length} characters")
    return message


def make_stop(
    *,
    name: str = "stop",
    description: str = DEFAULT_STOP_DESCRIPTION,
    max_message_length: int = DEFAULT_MAX_MESSAGE_LENGTH,
) -> DecoratedFunctionTool:
    """Create a stop tool that gracefully ends the agent loop.

    The tool calls ``agent.cancel(message=..., after_current_tools=True)`` so the loop
    ends after the current tool batch without invoking the model again.

    Args:
        name: Tool name. Defaults to ``"stop"``.
        description: Tool description shown to the model.
        max_message_length: Maximum accepted length for the model-supplied
            ``message`` argument, in characters. Must be a positive integer.
            Defaults to :data:`DEFAULT_MAX_MESSAGE_LENGTH` (4096).

    Returns:
        A decorated tool that signals the event loop to stop after the current
        tool batch completes.

    Raises:
        ValueError: If ``max_message_length`` is not a positive integer.
    """
    if not isinstance(max_message_length, int) or isinstance(max_message_length, bool) or max_message_length <= 0:
        raise ValueError(f"max_message_length must be a positive integer, got {max_message_length!r}")

    @tool(name=name, description=description, context="tool_context")
    async def stop_tool(tool_context: ToolContext, message: str | None = None) -> str:
        """Ends the agent loop gracefully. Call once when the task is complete.

        Args:
            tool_context: Injected by the framework. Not user-facing.
            message: Optional final message describing why the loop is ending.
                Capped at the tool's configured ``max_message_length``; longer
                values are rejected.
        """
        final_message = _validate_message(message, max_message_length)
        tool_context.agent.cancel(message=final_message, after_current_tools=True)
        return final_message

    return stop_tool


stop = make_stop()
"""Default stop tool. Ends the agent loop when called by the model."""

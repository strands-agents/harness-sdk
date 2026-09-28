"""Tool for pausing the agent loop and surfacing a message to the user.

Provides :func:`make_handoff_to_user` (a factory for customized handoff tools) and
:data:`handoff_to_user` (the default instance). The tool shims onto the SDK's
interrupt primitive via ``tool_context.interrupt``, raising
:exc:`~strands.interrupt.InterruptException` on the first invocation and halting
the agent loop with ``stop_reason == "interrupt"``. The message is surfaced as the
interrupt's ``reason`` field in ``AgentResult.interrupts``; the agent resumes when
the caller passes back an ``interruptResponse`` content block, and the human's reply
is returned as the tool result.

The raised interrupt's ``name`` is always :data:`HANDOFF_INTERRUPT_NAME`, held
constant even when the tool is renamed via ``make_handoff_to_user(name=...)``, so
consumers can reliably match handoff interrupts in ``AgentResult.interrupts``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from ...tools.decorator import tool
from ...types.tools import ToolContext
from .types import DEFAULT_HANDOFF_TO_USER_DESCRIPTION, HANDOFF_INTERRUPT_NAME

if TYPE_CHECKING:
    from ...tools.decorator import DecoratedFunctionTool


def make_handoff_to_user(
    *,
    name: str = "handoff_to_user",
    description: str = DEFAULT_HANDOFF_TO_USER_DESCRIPTION,
) -> DecoratedFunctionTool:
    """Create a handoff tool that pauses the agent loop and surfaces a message to the user.

    Args:
        name: Tool name. Defaults to ``"handoff_to_user"``.
        description: Tool description shown to the model.

    Returns:
        A decorated tool that suspends the agent loop on first call and returns the
        human's response on resume.
    """

    @tool(name=name, description=description, context="tool_context")
    async def handoff_to_user_tool(tool_context: ToolContext, message: str) -> Any:
        """Pause the agent loop and surface a message to the user.

        Args:
            tool_context: Injected by the framework. Not user-facing.
            message: The message to surface to the user.

        Returns:
            The user's response when the agent is resumed.
        """
        if not isinstance(message, str):
            raise ValueError(f"`message` must be a string, got {type(message).__name__}")
        if not message.strip():
            raise ValueError("`message` must not be empty")
        return tool_context.interrupt(HANDOFF_INTERRUPT_NAME, reason=message)

    return handoff_to_user_tool


handoff_to_user = make_handoff_to_user()
"""Default handoff tool. Pauses the agent loop and surfaces a message to the user."""

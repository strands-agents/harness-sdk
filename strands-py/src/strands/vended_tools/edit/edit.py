"""Sandbox-routed edit tool.

Replaces an exact, unique string in a text file through a
:class:`~strands.sandbox.base.Sandbox`: either one bound at creation (as the
built-in Docker/SSH sandboxes do when vending tools) or the agent's configured
sandbox read from ``tool_context.agent.sandbox`` at call time.

Pairs with the companion ``read`` and ``write`` vended tools.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ...tools.decorator import tool
from ...types.tools import ToolContext
from .._paths import validate_absolute_path

if TYPE_CHECKING:
    from ...sandbox.base import Sandbox
    from ...tools.decorator import DecoratedFunctionTool

DEFAULT_EDIT_DESCRIPTION = (
    "Replace an exact string in a text file. `old_str` must appear in the "
    "file exactly once. Files must use absolute paths."
)


def make_edit(
    *,
    sandbox: Sandbox | None = None,
    name: str = "edit",
    description: str = DEFAULT_EDIT_DESCRIPTION,
) -> DecoratedFunctionTool:
    """Create a sandbox-routed edit tool.

    If a ``sandbox`` is passed, it is bound at creation time. Otherwise the tool
    reads the sandbox from ``tool_context.agent.sandbox`` at call time. Used by
    sandbox implementations in :meth:`~strands.sandbox.base.Sandbox.get_tools`
    and by users who want a customized edit tool.

    Args:
        sandbox: Sandbox to bind at creation. When ``None``, the agent's
            configured sandbox is used at call time.
        name: Tool name. Defaults to ``"edit"``.
        description: Tool description shown to the model.

    Returns:
        A decorated tool that performs the edit through the sandbox.
    """

    @tool(name=name, description=description, context="tool_context")
    async def edit_tool(
        path: str,
        old_str: str,
        new_str: str,
        tool_context: ToolContext,
    ) -> str:
        """Replace an exact string in a file. ``old_str`` must appear exactly once.

        Args:
            path: Absolute path to the file.
            old_str: Exact text to find. Must be unique within the file.
            new_str: Replacement text.
            tool_context: Injected by the framework. Not user-facing.
        """
        validate_absolute_path(path)
        if old_str == "":
            raise ValueError("old_str must not be empty.")
        active = sandbox if sandbox is not None else tool_context.agent.sandbox

        content = await active.read_text(path)
        occurrences = content.count(old_str)
        if occurrences == 0:
            raise ValueError(f"old_str did not appear verbatim in {path}.")
        if occurrences > 1:
            raise ValueError(f"old_str appears {occurrences} times in {path}; make it unique.")
        await active.write_text(path, content.replace(old_str, new_str, 1))
        return f"Edited {path}."

    return edit_tool


edit = make_edit()
"""Default sandbox-routed edit tool. Reads the sandbox from the agent's context at call time."""

"""Sandbox-routed write tool.

Creates or overwrites a text file through a
:class:`~strands.sandbox.base.Sandbox`: either one bound at creation (as the
built-in Docker/SSH sandboxes do when vending tools) or the agent's configured
sandbox read from ``tool_context.agent.sandbox`` at call time.

Pairs with the companion ``read`` and ``edit`` vended tools.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ...tools.decorator import tool
from ...types.tools import ToolContext
from .._paths import validate_absolute_path

if TYPE_CHECKING:
    from ...sandbox.base import Sandbox
    from ...tools.decorator import DecoratedFunctionTool

DEFAULT_WRITE_DESCRIPTION = (
    "Create or overwrite a text file with the full provided content. Files must use absolute paths."
)


def make_write(
    *,
    sandbox: Sandbox | None = None,
    name: str = "write",
    description: str = DEFAULT_WRITE_DESCRIPTION,
) -> DecoratedFunctionTool:
    """Create a sandbox-routed write tool.

    If a ``sandbox`` is passed, it is bound at creation time. Otherwise the tool
    reads the sandbox from ``tool_context.agent.sandbox`` at call time. Used by
    sandbox implementations in :meth:`~strands.sandbox.base.Sandbox.get_tools`
    and by users who want a customized write tool.

    Args:
        sandbox: Sandbox to bind at creation. When ``None``, the agent's
            configured sandbox is used at call time.
        name: Tool name. Defaults to ``"write"``.
        description: Tool description shown to the model.

    Returns:
        A decorated tool that writes files through the sandbox.

    Raises:
        ValueError: When ``path`` is not absolute or contains ``..`` segments
            (raised by the returned tool at call time).
    """

    @tool(name=name, description=description, context="tool_context")
    async def write_tool(
        path: str,
        content: str,
        tool_context: ToolContext,
    ) -> str:
        """Write a file, creating it or overwriting it.

        Args:
            path: Absolute path to the file.
            content: The full file content to write.
            tool_context: Injected by the framework. Not user-facing.

        Raises:
            ValueError: When ``path`` is not absolute or contains ``..``
                segments.
        """
        validate_absolute_path(path)
        active = sandbox if sandbox is not None else tool_context.agent.sandbox

        await active.write_text(path, content)
        line_count = 0 if content == "" else len(content.split("\n"))
        noun = "line" if line_count == 1 else "lines"
        return f"Wrote {line_count} {noun} to {path}."

    return write_tool


write = make_write()
"""Default sandbox-routed write tool. Reads the sandbox from the agent's context at call time."""

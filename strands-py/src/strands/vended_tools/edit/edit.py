"""Sandbox-routed edit tool.

Provides ``str_replace`` (replace a unique exact string) and ``insert``
(insert text at a line) through a :class:`~strands.sandbox.base.Sandbox`:
either one bound at creation (as the built-in Docker/SSH sandboxes do when
vending tools) or the agent's configured sandbox read from
``tool_context.agent.sandbox`` at call time.

Pairs with the companion ``read`` and ``write`` vended tools.
"""

from __future__ import annotations

import posixpath
from typing import TYPE_CHECKING, Literal

from ...tools.decorator import tool
from ...types.tools import ToolContext

if TYPE_CHECKING:
    from ...sandbox.base import Sandbox
    from ...tools.decorator import DecoratedFunctionTool

DEFAULT_EDIT_DESCRIPTION = (
    "Edit a text file in place. Two commands: str_replace replaces an exact "
    "unique old_str with new_str (old_str must appear in the file exactly "
    "once); insert inserts new_str after a 0-indexed line number "
    "(insert_line=0 inserts at the beginning of the file). Files must use "
    "absolute paths."
)

_Command = Literal["str_replace", "insert"]


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
        command: _Command,
        path: str,
        tool_context: ToolContext,
        old_str: str | None = None,
        new_str: str | None = None,
        insert_line: int | None = None,
    ) -> str:
        """Edit a text file in place.

        Args:
            command: The operation to perform: ``str_replace`` or ``insert``.
            path: Absolute path to the file.
            tool_context: Injected by the framework. Not user-facing.
            old_str: Exact string to find (required for ``str_replace``). Must
                appear in the file exactly once.
            new_str: Replacement text (``str_replace``) or text to insert
                (``insert``).
            insert_line: 0-indexed line number for ``insert``: new_str is
                inserted *after* this line. Use ``0`` to insert at the
                beginning of the file.
        """
        _validate_path(path)
        active = sandbox if sandbox is not None else tool_context.agent.sandbox

        if command == "str_replace":
            if not old_str:
                raise ValueError("Parameter `old_str` is required and must be non-empty for command: str_replace")
            replacement = new_str or ""
            content = await active.read_text(path)
            occurrences = content.count(old_str)
            if occurrences == 0:
                raise ValueError(f"old_str did not appear verbatim in {path}.")
            if occurrences > 1:
                raise ValueError(f"old_str appears {occurrences} times in {path}; make it unique.")
            await active.write_text(path, content.replace(old_str, replacement, 1))
            return f"Edited {path}."

        if command == "insert":
            if insert_line is None or new_str is None:
                raise ValueError("Parameters `insert_line` and `new_str` are required for command: insert")
            content = await active.read_text(path)
            lines = content.split("\n")
            if insert_line < 0 or insert_line > len(lines):
                raise ValueError(
                    f"Invalid insert_line {insert_line}; must be between 0 and "
                    f"{len(lines)} (number of lines in {path})."
                )
            new_lines = new_str.split("\n")
            edited = new_lines if content == "" else [*lines[:insert_line], *new_lines, *lines[insert_line:]]
            await active.write_text(path, "\n".join(edited))
            return f"Edited {path}."

        raise ValueError(f"Unknown command: {command}")

    return edit_tool


edit = make_edit()
"""Default sandbox-routed edit tool. Reads the sandbox from the agent's context at call time."""


def _validate_path(path: str) -> None:
    """Reject non-absolute paths and ``..`` segments.

    Lexical check only. Symlink and filesystem semantics are the sandbox's responsibility.
    """
    if not posixpath.isabs(path):
        raise ValueError(f"The path {path} is not an absolute path, it should start with `/`.")
    if ".." in path.split("/"):
        raise ValueError("Invalid path: path traversal is not allowed")

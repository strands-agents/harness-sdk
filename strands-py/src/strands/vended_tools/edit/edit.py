"""Sandbox-routed edit tool.

Replaces an exact, unique string in a text file through a
:class:`~strands.sandbox.base.Sandbox`: either one bound at creation (as the
built-in Docker/SSH sandboxes do when vending tools) or the agent's configured
sandbox read from ``tool_context.agent.sandbox`` at call time.

Pairs with the companion ``read`` and ``write`` vended tools.
"""

from __future__ import annotations

import re
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

# A line break in the requested text may be LF or CRLF in the file.
_LINE_BREAK = r"(?:\r\n|\n)"


def _old_str_pattern(old_str: str) -> re.Pattern[str]:
    """Build a matcher for ``old_str`` that tolerates the file's line endings.

    The model emits ``\\n`` line breaks and cannot see whether the file on disk
    uses ``\\r\\n``. Matching the text verbatim therefore fails on a CRLF file
    even though the text is identical. Each line break in ``old_str`` is
    matched against any line break in the file; every other character is
    matched literally.
    """
    lines = re.split(r"\r\n|\n", old_str)
    return re.compile(_LINE_BREAK.join(re.escape(line) for line in lines))


def _detect_line_ending(text: str) -> str:
    """Return the dominant line ending of ``text`` (``\\r\\n`` or ``\\n``)."""
    crlf = text.count("\r\n")
    lf = text.count("\n") - crlf
    return "\r\n" if crlf > lf else "\n"


def _match_line_ending(matched: str, fallback: str) -> str:
    """Return the line ending used by the matched region of the file."""
    return "\r\n" if "\r\n" in matched else fallback


def _convert_line_endings(text: str, line_ending: str) -> str:
    """Rewrite every line break in ``text`` to ``line_ending``."""
    return re.sub(r"\r\n|\n", line_ending, text)


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
        matches = list(_old_str_pattern(old_str).finditer(content))
        if not matches:
            raise ValueError(f"old_str did not appear verbatim in {path}.")
        if len(matches) > 1:
            raise ValueError(f"old_str appears {len(matches)} times in {path}; make it unique.")

        match = matches[0]
        file_line_ending = _detect_line_ending(content)
        line_ending = _match_line_ending(match.group(0), file_line_ending)
        replacement = _convert_line_endings(new_str, line_ending)

        await active.write_text(path, content[: match.start()] + replacement + content[match.end() :])
        return f"Edited {path}."

    return edit_tool


edit = make_edit()
"""Default sandbox-routed edit tool. Reads the sandbox from the agent's context at call time."""

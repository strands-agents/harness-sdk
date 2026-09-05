"""Sandbox-routed file editor tool.

Provides
``view`` (with line ranges), ``create``, ``str_replace``, and ``insert``
operations, all routed through a :class:`~strands.sandbox.base.Sandbox`: either
one bound at creation (as the built-in Docker/SSH sandboxes do when vending
tools) or the agent's configured sandbox read from ``tool_context.agent.sandbox``
at call time.
"""

from __future__ import annotations

import posixpath
import re
from typing import TYPE_CHECKING, Literal

from ...sandbox.errors import SandboxPathNotFoundError
from ...tools.decorator import tool
from ...types.tools import ToolContext

if TYPE_CHECKING:
    from ...sandbox.base import Sandbox
    from ...tools.decorator import DecoratedFunctionTool

_SNIPPET_LINES = 4
_DEFAULT_MAX_FILE_SIZE = 1048576  # 1MB
_MAX_DIRECTORY_DEPTH = 2

DEFAULT_FILE_EDITOR_DESCRIPTION = (
    "Filesystem editor tool for viewing, creating, and editing files. Supports view "
    "(with line ranges), create, str_replace, and insert operations. Files must use absolute paths."
)


def make_file_editor(
    *,
    sandbox: Sandbox | None = None,
    name: str = "file_editor",
    description: str = DEFAULT_FILE_EDITOR_DESCRIPTION,
) -> DecoratedFunctionTool:
    """Create a sandbox-routed file editor tool.

    If a ``sandbox`` is passed, it is bound at creation time. Otherwise the tool
    reads the sandbox from ``tool_context.agent.sandbox`` at call time. Used by
    sandbox implementations in :meth:`~strands.sandbox.base.Sandbox.get_tools`
    and by users who want a customized file editor.

    Args:
        sandbox: Sandbox to bind at creation. When ``None``, the agent's
            configured sandbox is used at call time.
        name: Tool name. Defaults to ``"file_editor"``.
        description: Tool description shown to the model.

    Returns:
        A decorated tool that performs file operations through the sandbox.
    """

    @tool(name=name, description=description, context="tool_context")
    async def file_editor_tool(
        command: Literal["view", "create", "str_replace", "insert"],
        path: str,
        tool_context: ToolContext,
        file_text: str | None = None,
        view_range: list[int] | None = None,
        old_str: str | None = None,
        new_str: str | None = None,
        insert_line: int | None = None,
    ) -> str:
        """Filesystem editor for viewing, creating, and editing files.

        Args:
            command: The operation to perform: `view`, `create`, `str_replace`, `insert`.
            path: Absolute path to the file or directory.
            tool_context: Injected by the framework. Not user-facing.
            file_text: Content for new file (required for create command).
            view_range: Line range to view [start, end]. 1-indexed. End can be -1 for end of file.
            old_str: Exact string to find and replace (required for str_replace command).
            new_str: Replacement string (for str_replace and insert commands).
            insert_line: Line number where text should be inserted (0-indexed, required for insert command).
        """
        active = sandbox if sandbox is not None else tool_context.agent.sandbox
        # Strip trailing slashes from the path.
        file_path = re.sub(r"[/\\]+$", "", path)

        if command == "view":
            return await _handle_view(active, file_path, view_range)
        if command == "create":
            return await _handle_create(active, file_path, file_text)
        if command == "str_replace":
            return await _handle_str_replace(active, file_path, old_str, new_str)
        if command == "insert":
            return await _handle_insert(active, file_path, insert_line, new_str)
        raise ValueError(f"Unknown command: {command}")

    return file_editor_tool


file_editor = make_file_editor()
"""Default sandbox-routed file editor tool. Reads the sandbox from the agent's context at call time."""


def _validate_path(file_path: str) -> None:
    """Validate that a path is absolute and contains no directory traversal.

    Args:
        file_path: The path to validate.

    Raises:
        ValueError: If the path is not absolute or contains a ``..`` segment.
    """
    # Absolute means POSIX-absolute (leading "/"), matching the sandbox path model.
    if not posixpath.isabs(file_path):
        suggested = posixpath.abspath(file_path)
        raise ValueError(
            f"The path {file_path} is not an absolute path, it should start with `/`. Maybe you meant {suggested}?"
        )
    # Check for '..' segments on the raw input -- normalizing first would resolve them away.
    if ".." in re.split(r"[/\\]", file_path):
        raise ValueError("Invalid path: path traversal is not allowed")


def _apply_view_range(file_content: str, view_range: list[int] | None) -> tuple[str, int]:
    """Slice file content to a 1-indexed [start, end] range (end -1 means end of file).

    Args:
        file_content: The full file content.
        view_range: The [start, end] range, or ``None`` for the whole file.

    Returns:
        A tuple of (visible content, first line number for output numbering).

    Raises:
        ValueError: If the range is out of bounds or malformed.
    """
    if not view_range:
        return file_content, 1
    lines = file_content.split("\n")
    n_lines = len(lines)
    start, end = view_range[0], view_range[1]

    if start < 1 or start > n_lines:
        raise ValueError(
            f"Invalid `view_range`: [{start}, {end}]. Its first element `{start}` should be within the "
            f"range of lines of the file: [1, {n_lines}]"
        )
    if end != -1 and end > n_lines:
        raise ValueError(
            f"Invalid `view_range`: [{start}, {end}]. Its second element `{end}` should be smaller than "
            f"the number of lines in the file: `{n_lines}`"
        )
    if end != -1 and end < start:
        raise ValueError(
            f"Invalid `view_range`: [{start}, {end}]. Its second element `{end}` should be larger or "
            f"equal than its first `{start}`"
        )

    content = "\n".join(lines[start - 1 :]) if end == -1 else "\n".join(lines[start - 1 : end])
    return content, start


def _find_occurrences(haystack: str, needle: str) -> list[tuple[int, int]]:
    """Locate every non-overlapping occurrence of ``needle``.

    Args:
        haystack: The text to search.
        needle: The substring to find.

    Returns:
        A list of (offset, 1-indexed line number) for each occurrence, in order.
    """
    results: list[tuple[int, int]] = []
    position = haystack.find(needle)
    while position != -1:
        results.append((position, len(haystack[:position].split("\n"))))
        position = haystack.find(needle, position + len(needle))
    return results


def _build_str_replace_result(
    original_content: str, old_str: str, new_str: str | None, file_path: str
) -> tuple[str, str, int]:
    """Perform a unique str_replace and return (new content, change snippet, 0-indexed snippet start).

    Args:
        original_content: The current file content.
        old_str: The exact string to replace (must appear exactly once).
        new_str: The replacement string (``None`` deletes the match).
        file_path: The file path, for error messages.

    Returns:
        A tuple of (new content, snippet around the change, 0-indexed snippet start line).

    Raises:
        ValueError: If ``old_str`` does not appear exactly once.
    """
    if not old_str:
        raise ValueError("No replacement was performed, old_str must not be empty.")

    replacement = new_str or ""

    # Matching and splicing both run against the raw content: this result is written back to the
    # file, so any transform applied here would persist. Tab expansion belongs to _make_output,
    # which formats the snippet for display only.
    occurrences = _find_occurrences(original_content, old_str)
    if not occurrences:
        raise ValueError(f"No replacement was performed, old_str `{old_str}` did not appear verbatim in {file_path}.")
    if len(occurrences) > 1:
        line_numbers = [line for _, line in occurrences]
        raise ValueError(
            f"No replacement was performed. Multiple occurrences of old_str `{old_str}` in lines "
            f"{line_numbers}. Please ensure it is unique"
        )

    match_index, _ = occurrences[0]
    new_content = original_content[:match_index] + replacement + original_content[match_index + len(old_str) :]
    replacement_line = len(original_content[:match_index].split("\n")) - 1
    inserted_lines = len(replacement.split("\n"))
    original_lines = len(old_str.split("\n"))
    line_difference = inserted_lines - original_lines

    new_lines = new_content.split("\n")
    start_line = max(0, replacement_line - _SNIPPET_LINES)
    end_line = min(len(new_lines), replacement_line + _SNIPPET_LINES + line_difference + 1)
    snippet = "\n".join(new_lines[start_line:end_line])

    return new_content, snippet, start_line


def _build_insert_result(original_content: str, insert_line: int, new_str: str) -> tuple[str, str, int]:
    """Insert text at a 0-indexed line and return (new content, snippet, 0-indexed snippet start).

    Args:
        original_content: The current file content.
        insert_line: The 0-indexed line after which to insert.
        new_str: The text to insert.

    Returns:
        A tuple of (new content, snippet around the insertion, 0-indexed snippet start line).

    Raises:
        ValueError: If ``insert_line`` is out of bounds.
    """
    # Raw content for the same reason as _build_str_replace_result: this is written back to disk.
    file_text_lines = original_content.split("\n")
    n_lines = len(file_text_lines)

    if insert_line < 0 or insert_line > n_lines:
        raise ValueError(
            f"Invalid `insert_line` parameter: {insert_line}. It should be within the range of lines "
            f"of the file: [0, {n_lines}]"
        )

    new_str_lines = new_str.split("\n")
    new_file_text_lines = (
        new_str_lines
        if original_content == ""
        else [*file_text_lines[:insert_line], *new_str_lines, *file_text_lines[insert_line:]]
    )

    new_content = "\n".join(new_file_text_lines)
    snippet_start_line = max(0, insert_line - _SNIPPET_LINES)
    snippet_end_line = min(len(new_file_text_lines), insert_line + len(new_str_lines) + _SNIPPET_LINES)
    snippet = "\n".join(new_file_text_lines[snippet_start_line:snippet_end_line])

    return new_content, snippet, snippet_start_line


def _make_output(file_content: str, file_descriptor: str, init_line: int = 1) -> str:
    """Format file content with ``cat -n`` style line numbers.

    Args:
        file_content: The content to number.
        file_descriptor: A description of the source (file path or snippet label).
        init_line: The line number of the first line.

    Returns:
        The formatted, line-numbered output.
    """
    expanded_content = file_content.replace("\t", "        ")
    numbered_lines = [f"{index + init_line:>6}  {line}" for index, line in enumerate(expanded_content.split("\n"))]
    return f"Here's the result of running `cat -n` on {file_descriptor}:\n" + "\n".join(numbered_lines) + "\n"


# ---- Sandbox-routed I/O helpers ----


async def _probe_sandbox_path(sandbox: Sandbox, file_path: str) -> tuple[bool, bool]:
    """Probe a path through the sandbox, returning (exists, is_dir).

    Lists the parent directory and looks for the entry. A missing parent or entry
    resolves to ``(False, False)``; permission, transport, and other failures
    propagate so they are not disguised as non-existence.

    Args:
        sandbox: The sandbox to probe through.
        file_path: The path to check.

    Returns:
        A tuple of (exists, is_dir).
    """
    normalized = file_path.replace("\\", "/")
    parent = "/".join(normalized.split("/")[:-1]) or "/"
    name = normalized.split("/")[-1]
    try:
        entry = next((e for e in await sandbox.list_files(parent) if e.name == name), None)
    except SandboxPathNotFoundError:
        return False, False
    if entry is None:
        return False, False
    return True, entry.is_dir or False


def _assert_within_size_limit(content: str, max_size: int = _DEFAULT_MAX_FILE_SIZE) -> None:
    """Assert content is within the size limit.

    Checked after reading because ``list_files`` does not reliably report size
    across sandbox backends.

    Args:
        content: The content to measure.
        max_size: The maximum allowed size in bytes.

    Raises:
        ValueError: If the content exceeds ``max_size``.
    """
    size = len(content.encode("utf-8"))
    if size > max_size:
        raise ValueError(f"File size ({size} bytes) exceeds maximum allowed size ({max_size} bytes)")


async def _list_directory(sandbox: Sandbox, dir_path: str) -> str:
    """List directory contents up to 2 levels deep through the sandbox, excluding hidden files.

    Args:
        sandbox: The sandbox to list through.
        dir_path: The directory to list.

    Returns:
        A formatted listing of relative paths.
    """
    items: list[str] = []

    async def walk(current_path: str, prefix: str, depth: int) -> None:
        try:
            entries = await sandbox.list_files(current_path)
        except OSError:
            # Ignore permission/path errors and continue.
            return
        for entry in entries:
            if entry.name.startswith("."):
                continue
            relative_path = f"{prefix}/{entry.name}" if prefix else entry.name
            items.append(relative_path)
            if entry.is_dir and depth < _MAX_DIRECTORY_DEPTH:
                await walk(f"{current_path}/{entry.name}", relative_path, depth + 1)

    await walk(dir_path, "", 0)
    result = "\n".join(sorted(items))
    return f"Here's the files and directories up to 2 levels deep in {dir_path}, excluding hidden items:\n{result}\n"


# ---- Sandbox-path handlers ----


async def _handle_view(sandbox: Sandbox, file_path: str, view_range: list[int] | None) -> str:
    """Handle the ``view`` command: render a file with line numbers or list a directory."""
    _validate_path(file_path)

    exists, is_dir = await _probe_sandbox_path(sandbox, file_path)
    if not exists:
        raise ValueError(f"The path {file_path} does not exist. Please provide a valid path.")

    if is_dir:
        if view_range:
            raise ValueError("The `view_range` parameter is not allowed when `path` points to a directory.")
        return await _list_directory(sandbox, file_path)

    file_content = await sandbox.read_text(file_path)
    _assert_within_size_limit(file_content)

    content, init_line = _apply_view_range(file_content, view_range)
    return _make_output(content, file_path, init_line)


async def _handle_create(sandbox: Sandbox, file_path: str, file_text: str | None) -> str:
    """Handle the ``create`` command: write a new file, refusing to overwrite."""
    if file_text is None:
        raise ValueError("Parameter `file_text` is required for command: create")

    _validate_path(file_path)

    exists, _ = await _probe_sandbox_path(sandbox, file_path)
    if exists:
        raise ValueError(f"File already exists at: {file_path}. Cannot overwrite files using command `create`.")

    await sandbox.write_text(file_path, file_text)
    return f"File created successfully at: {file_path}"


async def _handle_str_replace(sandbox: Sandbox, file_path: str, old_str: str | None, new_str: str | None) -> str:
    """Handle the ``str_replace`` command: replace a unique occurrence of ``old_str``."""
    if old_str is None:
        raise ValueError("Parameter `old_str` is required for command: str_replace")

    _validate_path(file_path)

    exists, is_dir = await _probe_sandbox_path(sandbox, file_path)
    if not exists:
        raise ValueError(f"The path {file_path} does not exist. Please provide a valid path.")
    if is_dir:
        raise ValueError(f"The path {file_path} is a directory and only the `view` command can be used on directories")

    file_content = await sandbox.read_text(file_path)
    _assert_within_size_limit(file_content)

    new_content, snippet, start_line = _build_str_replace_result(file_content, old_str, new_str, file_path)

    await sandbox.write_text(file_path, new_content)

    return (
        f"The file {file_path} has been edited. "
        f"{_make_output(snippet, f'a snippet of {file_path}', start_line + 1)}"
        "Review the changes and make sure they are as expected. Edit the file again if necessary."
    )


async def _handle_insert(sandbox: Sandbox, file_path: str, insert_line: int | None, new_str: str | None) -> str:
    """Handle the ``insert`` command: insert text at a 0-indexed line."""
    if insert_line is None or new_str is None:
        raise ValueError("Parameters `insert_line` and `new_str` are required for command: insert")

    _validate_path(file_path)

    exists, is_dir = await _probe_sandbox_path(sandbox, file_path)
    if not exists:
        raise ValueError(f"The path {file_path} does not exist. Please provide a valid path.")
    if is_dir:
        raise ValueError(f"The path {file_path} is a directory and only the `view` command can be used on directories")

    file_text = await sandbox.read_text(file_path)
    _assert_within_size_limit(file_text)

    new_content, snippet, start_line = _build_insert_result(file_text, insert_line, new_str)

    await sandbox.write_text(file_path, new_content)

    return (
        f"The file {file_path} has been edited. "
        f"{_make_output(snippet, 'a snippet of the edited file', start_line + 1)}"
        "Review the changes and make sure they are as expected (correct indentation, no duplicate lines, etc). "
        "Edit the file again if necessary."
    )

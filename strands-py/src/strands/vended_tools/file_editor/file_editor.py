"""Sandbox-routed file editor tool.

Provides ``view`` (with line ranges), ``create``, ``str_replace``, ``insert``,
``find_line``, and ``undo_edit`` operations, all routed through a
:class:`~strands.sandbox.base.Sandbox`: either one bound at creation (as the
built-in Docker/SSH sandboxes do when vending tools) or the agent's configured
sandbox read from ``tool_context.agent.sandbox`` at call time.
"""

from __future__ import annotations

import posixpath
from typing import TYPE_CHECKING, Literal
from weakref import WeakSet

from ...sandbox.errors import SandboxPathNotFoundError
from ...tools.decorator import tool
from ...types.media import DocumentFormat, ImageFormat
from ...types.tools import ToolContext, ToolResult

if TYPE_CHECKING:
    from ...sandbox.base import Sandbox
    from ...tools.decorator import DecoratedFunctionTool

_MB = 1024 * 1024
_SNIPPET_LINES = 4
_DEFAULT_MAX_FILE_SIZE = 1 * _MB
_MAX_DIRECTORY_DEPTH = 2
_MAX_FIND_LINE_HITS = 200
_DEFAULT_MAX_UNDO_ENTRIES = 32
_DEFAULT_MAX_UNDO_BYTES = 32 * _MB

# Extension → Bedrock media format. Detection is by extension because the
# sandbox seam exposes no MIME metadata. `csv`, `html`, `txt`, and `md` are
# text-representable documents and stay on the numbered-lines path so
# find_line and str_replace still work; only opaque binary documents route
# through the ToolResult document block.
_IMAGE_FORMATS: dict[str, ImageFormat] = {
    "png": "png",
    "jpg": "jpeg",
    "jpeg": "jpeg",
    "gif": "gif",
    "webp": "webp",
}
_BINARY_DOCUMENT_FORMATS: dict[str, DocumentFormat] = {
    "pdf": "pdf",
    "doc": "doc",
    "docx": "docx",
    "xls": "xls",
    "xlsx": "xlsx",
}

DEFAULT_FILE_EDITOR_DESCRIPTION = (
    "Filesystem editor for viewing, creating, and editing files. Supports view (text with "
    "line ranges; png/jpeg/gif/webp images and pdf/doc/docx/xls/xlsx documents returned as "
    "media blocks), create, str_replace (exact match; ambiguous matches must opt in via "
    "replace_all), insert, find_line, and undo_edit. Files must use absolute paths."
)

DEFAULT_UNDO_STATE_KEY = "file_editor.undo_history"

_Command = Literal[
    "view",
    "create",
    "str_replace",
    "insert",
    "find_line",
    "undo_edit",
]

_MUTATING_COMMANDS: frozenset[str] = frozenset({"create", "str_replace", "insert", "undo_edit"})


def make_file_editor(
    *,
    sandbox: Sandbox | None = None,
    name: str = "file_editor",
    description: str = DEFAULT_FILE_EDITOR_DESCRIPTION,
    root: str | None = None,
    max_file_size: int = _DEFAULT_MAX_FILE_SIZE,
    max_undo_entries: int = _DEFAULT_MAX_UNDO_ENTRIES,
    max_undo_bytes: int = _DEFAULT_MAX_UNDO_BYTES,
    undo_state_key: str = DEFAULT_UNDO_STATE_KEY,
) -> DecoratedFunctionTool:
    """Create a sandbox-routed file editor tool.

    If a ``sandbox`` is passed, it is bound at creation time. Otherwise the tool
    reads the sandbox from ``tool_context.agent.sandbox`` at call time. Used by
    sandbox implementations in :meth:`~strands.sandbox.base.Sandbox.get_tools`
    and by users who want a customized file editor.

    Undo history is stored in ``tool_context.agent.state`` under
    ``undo_state_key`` (default ``"file_editor.undo_history"``), so two agents
    sharing one editor factory cannot see or overwrite each other's snapshots
    and any configured session manager can persist it across restarts.

    Args:
        sandbox: Sandbox to bind at creation. When ``None``, the agent's
            configured sandbox is used at call time.
        name: Tool name. Defaults to ``"file_editor"``.
        description: Tool description shown to the model.
        root: Optional absolute directory that confines every operation. Paths
            are normalized (so ``..`` segments collapse before the containment
            check) and must sit inside ``root``. Confinement is *lexical*: the
            editor does not follow symlinks itself. Filesystem semantics —
            including whether a symlink inside ``root`` can escape it — are
            governed by the sandbox. On first use, the editor verifies ``root``
            exists in the sandbox via :meth:`Sandbox.list_files`; if it does
            not, the call fails. When ``root`` is ``None`` only the
            absolute-path check applies.
        max_file_size: Maximum file size (bytes) accepted by view/edit
            commands. Defaults to 1 MB.
        max_undo_entries: Maximum number of distinct paths retained in the
            in-memory undo history *per agent*. Oldest entry is evicted on
            overflow. Defaults to 32.
        max_undo_bytes: Approximate cap on total bytes of file content held in
            the per-agent undo history (UTF-8). Oldest entries are evicted
            until the cap is met. Defaults to 32 MB.
        undo_state_key: Key under which the undo history is stored in
            ``agent.state``. Two editors sharing the same key on the same
            agent will share undo history; use distinct keys to isolate them.

    Returns:
        A decorated tool that performs file operations through the sandbox.

    Raises:
        ValueError: If ``root`` is set but not an absolute path.
    """
    if root is not None and not posixpath.isabs(root):
        raise ValueError(f"root must be an absolute path, got: {root}")
    normalized_root: str | None = None if root is None else posixpath.normpath(root).rstrip("/") or "/"

    if normalized_root is not None and description is DEFAULT_FILE_EDITOR_DESCRIPTION:
        description = f"{DEFAULT_FILE_EDITOR_DESCRIPTION} All paths must be absolute and inside {normalized_root}."

    # Sandboxes already verified to contain `root`. WeakSet so a sandbox that
    # goes out of scope does not pin the cache entry.
    verified_sandboxes: WeakSet[Sandbox] = WeakSet()

    async def _verify_root(active: Sandbox) -> None:
        if normalized_root is None or active in verified_sandboxes:
            return
        try:
            await active.list_files(normalized_root)
        except SandboxPathNotFoundError as error:
            raise ValueError(f"Invalid configuration: root {normalized_root} does not exist in the sandbox.") from error
        verified_sandboxes.add(active)

    @tool(name=name, description=description, context="tool_context")
    async def file_editor_tool(
        command: _Command,
        path: str,
        tool_context: ToolContext,
        file_text: str | None = None,
        view_range: list[int] | None = None,
        old_str: str | None = None,
        new_str: str | None = None,
        insert_line: int | None = None,
        search_text: str | None = None,
        fuzzy: bool = False,
        replace_all: bool = False,
    ) -> str | ToolResult:
        """Filesystem editor for viewing, creating, and editing files.

        Args:
            command: The operation to perform: ``view``, ``create``,
                ``str_replace``, ``insert``, ``find_line``, or ``undo_edit``.
            path: Absolute path to the file or directory.
            tool_context: Injected by the framework. Not user-facing.
            file_text: Content for new file (required for ``create``).
            view_range: Line range to view ``[start, end]``. 1-indexed. End can
                be ``-1`` for end of file.
            old_str: Exact string to find and replace (required for
                ``str_replace``). Must be unique unless ``replace_all=True``.
            new_str: Replacement string (for ``str_replace`` and ``insert``).
            insert_line: Line number where text should be inserted (0-indexed,
                required for ``insert``).
            search_text: Text to search for (required for ``find_line``).
            fuzzy: Enable whitespace-tolerant matching for ``find_line``.
            replace_all: For ``str_replace``, allow replacing all occurrences.
                Defaults to ``False`` (unique match required) to prevent silent
                broad edits.
        """
        active = sandbox if sandbox is not None else tool_context.agent.sandbox
        await _verify_root(active)
        resolved = _resolve_path(path, normalized_root)

        # Only mutating commands touch undo history, so read-only paths skip
        # the state load/save (which deep-copies and JSON-validates).
        mutates_undo = command in _MUTATING_COMMANDS
        state = tool_context.agent.state if mutates_undo else None
        undo_history: dict[str, str] = state.get(undo_state_key) or {} if state is not None else {}

        try:
            if command == "view":
                return await _handle_view(
                    active, resolved, view_range, max_file_size, tool_context.tool_use["toolUseId"]
                )
            if command == "create":
                return await _handle_create(active, resolved, file_text, undo_history, max_file_size)
            if command == "str_replace":
                return await _handle_str_replace(
                    active,
                    resolved,
                    old_str,
                    new_str,
                    replace_all,
                    max_file_size,
                    undo_history,
                    max_undo_entries,
                    max_undo_bytes,
                )
            if command == "insert":
                return await _handle_insert(
                    active,
                    resolved,
                    insert_line,
                    new_str,
                    max_file_size,
                    undo_history,
                    max_undo_entries,
                    max_undo_bytes,
                )
            if command == "find_line":
                return await _handle_find_line(active, resolved, search_text, fuzzy, max_file_size)
            if command == "undo_edit":
                return await _handle_undo(active, resolved, undo_history)
            raise ValueError(f"Unknown command: {command}")
        finally:
            if state is not None:
                # Handlers only mutate after a successful sandbox write, so
                # persisting on the exception path is safe.
                state.set(undo_state_key, undo_history)

    return file_editor_tool


file_editor = make_file_editor()
"""Default sandbox-routed file editor tool. Reads the sandbox from the agent's context at call time."""


# ---- Path resolution and confinement ----


def _resolve_path(file_path: str, root: str | None) -> str:
    """Normalize a path and enforce lexical confinement.

    Rejects non-absolute paths. When ``root`` is set the normalized path must
    sit inside it. Symlink semantics are the sandbox's responsibility.

    Raises:
        ValueError: On non-absolute paths or out-of-root resolution.
    """
    stripped = file_path.rstrip("/") or file_path

    if not posixpath.isabs(stripped):
        suggested = posixpath.abspath(stripped)
        raise ValueError(
            f"The path {file_path} is not an absolute path, it should start with `/`. Maybe you meant {suggested}?"
        )

    normalized = posixpath.normpath(stripped)

    if root is not None:
        root_norm = posixpath.normpath(root).rstrip("/") or "/"
        if normalized != root_norm and not normalized.startswith(root_norm.rstrip("/") + "/"):
            raise ValueError(f"Invalid path: {file_path} is outside the configured root {root}")

    return normalized


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


def _preflight_str_replace_output_size(
    original_content: str,
    old_str: str,
    new_str_value: str,
    replace_all: bool,
    occurrences: int,
    max_size: int,
    file_path: str,
) -> None:
    """Reject a ``str_replace`` whose projected UTF-8 output would exceed ``max_size``.

    The projected size is exact — ``str.replace`` never re-runs itself — so
    rejection happens before allocating the substituted string. Guards against
    a pathological ``replace_all`` (many small matches, large replacement)
    trying to allocate a multi-terabyte buffer.
    """
    old_bytes = len(old_str.encode("utf-8"))
    new_bytes = len(new_str_value.encode("utf-8"))
    count = occurrences if replace_all else 1
    projected = len(original_content.encode("utf-8")) + count * (new_bytes - old_bytes)
    if projected > max_size:
        raise ValueError(
            f"The edit would produce a {projected}-byte file at {file_path}, "
            f"exceeding the maximum allowed size of {max_size} bytes."
        )


def _preflight_insert_output_size(
    original_content: str,
    new_str: str,
    max_size: int,
    file_path: str,
) -> None:
    """Reject an ``insert`` whose projected UTF-8 output would exceed ``max_size``."""
    projected = len(original_content.encode("utf-8")) + len(new_str.encode("utf-8"))
    if projected > max_size:
        raise ValueError(
            f"The edit would produce a {projected}-byte file at {file_path}, "
            f"exceeding the maximum allowed size of {max_size} bytes."
        )


def _build_str_replace_result(
    original_content: str,
    old_str: str,
    new_str: str | None,
    file_path: str,
    replace_all: bool,
    max_size: int,
) -> tuple[str, str, int, int]:
    """Perform ``str_replace`` and return ``(new content, snippet, snippet start, count)``.

    Raises:
        ValueError: If ``old_str`` does not appear, appears more than once
            without ``replace_all``, or the substitution would exceed
            ``max_size``.
    """
    new_str_value = new_str or ""

    occurrences = original_content.count(old_str)
    if occurrences == 0:
        raise ValueError(f"No replacement was performed, old_str `{old_str}` did not appear verbatim in {file_path}.")
    if occurrences > 1 and not replace_all:
        lines = original_content.split("\n")
        line_numbers = [i + 1 for i, line in enumerate(lines) if old_str in line]
        raise ValueError(
            f"No replacement was performed. Multiple occurrences of old_str `{old_str}` in lines "
            f"{line_numbers}. Pass replace_all=True to replace every occurrence, or make old_str unique."
        )

    _preflight_str_replace_output_size(
        original_content, old_str, new_str_value, replace_all, occurrences, max_size, file_path
    )

    count = occurrences if replace_all else 1
    new_content = (
        original_content.replace(old_str, new_str_value)
        if replace_all
        else original_content.replace(old_str, new_str_value, 1)
    )
    replacement_line = len(original_content[: original_content.index(old_str)].split("\n")) - 1
    inserted_lines = len(new_str_value.split("\n"))
    original_lines = len(old_str.split("\n"))
    line_difference = inserted_lines - original_lines

    new_lines = new_content.split("\n")
    start_line = max(0, replacement_line - _SNIPPET_LINES)
    end_line = min(len(new_lines), replacement_line + _SNIPPET_LINES + line_difference + 1)
    snippet = "\n".join(new_lines[start_line:end_line])

    return new_content, snippet, start_line, count


def _build_insert_result(original_content: str, insert_line: int, new_str: str) -> tuple[str, str, int]:
    """Insert text at a 0-indexed line and return (new content, snippet, 0-indexed snippet start).

    Raises:
        ValueError: If ``insert_line`` is out of bounds.
    """
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


def _find_line_numbers(content: str, search_text: str, fuzzy: bool, cap: int) -> list[int]:
    """Return every 0-indexed line where ``search_text`` matches, capped at ``cap`` entries.

    When ``fuzzy=True``, whitespace between tokens is collapsed and matching is
    case-insensitive. Returns an empty list when nothing matches.
    """
    lines = content.split("\n")
    hits: list[int] = []
    if fuzzy:
        # Whitespace-tolerant, case-insensitive: match tokens in order using a
        # linear ordered-subsequence scan. A previous implementation joined
        # tokens with a regex `.*` chain, which is O(line_length**tokens)
        # against long single-line content and cannot be interrupted by an
        # asyncio timeout because the regex engine holds the interpreter.
        tokens = [t.lower() for t in search_text.strip().split()]
        if not tokens:
            return hits
        for index, line in enumerate(lines):
            lowered = line.lower()
            position = 0
            matched = True
            for token in tokens:
                found = lowered.find(token, position)
                if found == -1:
                    matched = False
                    break
                position = found + len(token)
            if matched:
                hits.append(index)
                if len(hits) >= cap:
                    break
    else:
        for index, line in enumerate(lines):
            if search_text in line:
                hits.append(index)
                if len(hits) >= cap:
                    break
    return hits


# ---- Undo history bookkeeping ----


def _store_undo_snapshot(
    undo_history: dict[str, str],
    file_path: str,
    content: str,
    max_entries: int,
    max_bytes: int,
) -> None:
    """Record a pre-edit snapshot in the LRU undo history, evicting oldest on overflow.

    ``dict`` insertion order gives LRU semantics: a re-inserted key is moved to
    the end, and eviction removes the oldest key when either the entry count or
    the aggregate byte cap is exceeded.

    Callers must invoke this only *after* the corresponding write has succeeded
    so a failed write does not overwrite a still-valid earlier snapshot.
    """
    if file_path in undo_history:
        del undo_history[file_path]
    undo_history[file_path] = content
    total_bytes = sum(len(v.encode("utf-8")) for v in undo_history.values())
    while undo_history and (len(undo_history) > max_entries or total_bytes > max_bytes):
        oldest_key = next(iter(undo_history))
        evicted = undo_history.pop(oldest_key)
        total_bytes -= len(evicted.encode("utf-8"))


# ---- Sandbox-routed I/O helpers ----


async def _probe_sandbox_path(sandbox: Sandbox, file_path: str) -> tuple[bool, bool]:
    """Return ``(exists, is_dir)`` for a path by listing its parent through the sandbox.

    A missing parent or entry becomes ``(False, False)``; other listing errors
    (permission, transport) propagate so they are not disguised as non-existence.
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


async def _read_text_or_reject_binary(sandbox: Sandbox, file_path: str, max_size: int) -> str:
    """Read text through the sandbox, rejecting binary files and oversize inputs.

    Reads raw bytes first so the size cap and encoding detection run before UTF-8
    decoding — a corrupted UTF-8 error message is worse than a clean rejection.
    UTF-16 BOMs are detected up front so a valid UTF-16 file is reported as an
    unsupported encoding rather than misclassified as binary. Otherwise the
    classic NUL-in-first-8-KB heuristic identifies binary content.
    """
    raw = await sandbox.read_file(file_path)
    if len(raw) > max_size:
        raise ValueError(f"File size ({len(raw)} bytes) exceeds maximum allowed size ({max_size} bytes)")
    if raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff"):
        raise ValueError(f"Refusing to read non-UTF-8 file (detected UTF-16 BOM): {file_path}")
    if b"\x00" in raw[:8192]:
        raise ValueError(f"Refusing to read binary file: {file_path}")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as e:
        raise ValueError(f"Refusing to read non-UTF-8 file: {file_path}") from e


async def _list_directory(sandbox: Sandbox, dir_path: str) -> str:
    """List directory contents up to 2 levels deep through the sandbox, excluding hidden files."""
    items: list[str] = []

    async def walk(current_path: str, prefix: str, depth: int) -> None:
        try:
            entries = await sandbox.list_files(current_path)
        except OSError:
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


async def _handle_view(
    sandbox: Sandbox,
    file_path: str,
    view_range: list[int] | None,
    max_size: int,
    tool_use_id: str,
) -> str | ToolResult:
    """Handle the ``view`` command: text file (numbered lines), directory (listing), or media (ToolResult)."""
    exists, is_dir = await _probe_sandbox_path(sandbox, file_path)
    if not exists:
        raise ValueError(f"The path {file_path} does not exist. Please provide a valid path.")

    if is_dir:
        if view_range:
            raise ValueError("The `view_range` parameter is not allowed when `path` points to a directory.")
        return await _list_directory(sandbox, file_path)

    extension = posixpath.splitext(file_path)[1].lstrip(".").lower()

    if extension in _IMAGE_FORMATS or extension in _BINARY_DOCUMENT_FORMATS:
        if view_range:
            raise ValueError("The `view_range` parameter is not allowed for image or binary document files.")
        raw = await sandbox.read_file(file_path)
        if len(raw) > max_size:
            raise ValueError(f"File size ({len(raw)} bytes) exceeds maximum allowed size ({max_size} bytes)")
        if extension in _IMAGE_FORMATS:
            return {
                "toolUseId": tool_use_id,
                "status": "success",
                "content": [{"image": {"format": _IMAGE_FORMATS[extension], "source": {"bytes": raw}}}],
            }
        return {
            "toolUseId": tool_use_id,
            "status": "success",
            "content": [
                {
                    "document": {
                        "format": _BINARY_DOCUMENT_FORMATS[extension],
                        "name": posixpath.basename(file_path),
                        "source": {"bytes": raw},
                    }
                }
            ],
        }

    file_content = await _read_text_or_reject_binary(sandbox, file_path, max_size)

    content, init_line = _apply_view_range(file_content, view_range)
    return _make_output(content, file_path, init_line)


def _reject_oversize_replacement(text: str | None, max_size: int, label: str = "new_str") -> None:
    """Reject a replacement payload whose UTF-8 encoding would exceed ``max_size``.

    Mirrors the read-side cap on the write side so a model cannot ship an
    unbounded ``file_text`` or ``new_str`` through the tool.
    """
    if text is None:
        return
    encoded = len(text.encode("utf-8"))
    if encoded > max_size:
        raise ValueError(f"{label} ({encoded} bytes) exceeds maximum allowed size ({max_size} bytes)")


async def _handle_create(
    sandbox: Sandbox,
    file_path: str,
    file_text: str | None,
    undo_history: dict[str, str],
    max_size: int,
) -> str:
    """Handle the ``create`` command: write a new file, refusing to overwrite."""
    if file_text is None:
        raise ValueError("Parameter `file_text` is required for command: create")
    _reject_oversize_replacement(file_text, max_size, label="file_text")

    exists, _ = await _probe_sandbox_path(sandbox, file_path)
    if exists:
        raise ValueError(f"File already exists at: {file_path}. Cannot overwrite files using command `create`.")

    await sandbox.write_text(file_path, file_text)
    # ``create`` is intentionally not snapshotted for undo: rolling back a
    # create means deleting the file, which is a different operation from
    # "restore prior content" and is easy for the caller to do themselves.
    undo_history.pop(file_path, None)
    return f"File created successfully at: {file_path}"


async def _handle_str_replace(
    sandbox: Sandbox,
    file_path: str,
    old_str: str | None,
    new_str: str | None,
    replace_all: bool,
    max_size: int,
    undo_history: dict[str, str],
    max_undo_entries: int,
    max_undo_bytes: int,
) -> str:
    """Handle the ``str_replace`` command: replace ``old_str`` (unique unless ``replace_all``)."""
    if old_str is None:
        raise ValueError("Parameter `old_str` is required for command: str_replace")
    if old_str == "":
        raise ValueError("Parameter `old_str` must not be empty for command: str_replace")
    _reject_oversize_replacement(new_str, max_size)

    exists, is_dir = await _probe_sandbox_path(sandbox, file_path)
    if not exists:
        raise ValueError(f"The path {file_path} does not exist. Please provide a valid path.")
    if is_dir:
        raise ValueError(f"The path {file_path} is a directory and only the `view` command can be used on directories")

    file_content = await _read_text_or_reject_binary(sandbox, file_path, max_size)

    new_content, snippet, start_line, count = _build_str_replace_result(
        file_content, old_str, new_str, file_path, replace_all, max_size
    )

    # Snapshot only after the write commits so a failed write leaves the
    # previous entry — which still reflects on-disk state — valid to undo.
    await sandbox.write_text(file_path, new_content)
    _store_undo_snapshot(undo_history, file_path, file_content, max_undo_entries, max_undo_bytes)

    suffix = f" ({count} occurrences replaced)" if replace_all and count > 1 else ""
    return (
        f"The file {file_path} has been edited.{suffix} "
        f"{_make_output(snippet, f'a snippet of {file_path}', start_line + 1)}"
        "Review the changes and make sure they are as expected. Edit the file again if necessary."
    )


async def _handle_insert(
    sandbox: Sandbox,
    file_path: str,
    insert_line: int | None,
    new_str: str | None,
    max_size: int,
    undo_history: dict[str, str],
    max_undo_entries: int,
    max_undo_bytes: int,
) -> str:
    """Handle the ``insert`` command: insert text at a 0-indexed line."""
    if insert_line is None or new_str is None:
        raise ValueError("Parameters `insert_line` and `new_str` are required for command: insert")
    _reject_oversize_replacement(new_str, max_size)

    exists, is_dir = await _probe_sandbox_path(sandbox, file_path)
    if not exists:
        raise ValueError(f"The path {file_path} does not exist. Please provide a valid path.")
    if is_dir:
        raise ValueError(f"The path {file_path} is a directory and only the `view` command can be used on directories")

    file_text = await _read_text_or_reject_binary(sandbox, file_path, max_size)

    _preflight_insert_output_size(file_text, new_str, max_size, file_path)
    new_content, snippet, start_line = _build_insert_result(file_text, insert_line, new_str)

    await sandbox.write_text(file_path, new_content)
    _store_undo_snapshot(undo_history, file_path, file_text, max_undo_entries, max_undo_bytes)

    return (
        f"The file {file_path} has been edited. "
        f"{_make_output(snippet, 'a snippet of the edited file', start_line + 1)}"
        "Review the changes and make sure they are as expected (correct indentation, no duplicate lines, etc). "
        "Edit the file again if necessary."
    )


async def _handle_find_line(
    sandbox: Sandbox,
    file_path: str,
    search_text: str | None,
    fuzzy: bool,
    max_size: int,
) -> str:
    """Handle the ``find_line`` command: return every match (bounded) or an empty report.

    Returns 1-indexed line numbers along with a short snippet around the first
    hit. A missing match is not an error; the caller can branch on the reply.
    """
    if search_text is None:
        raise ValueError("Parameter `search_text` is required for command: find_line")

    exists, is_dir = await _probe_sandbox_path(sandbox, file_path)
    if not exists:
        raise ValueError(f"The path {file_path} does not exist. Please provide a valid path.")
    if is_dir:
        raise ValueError(f"The path {file_path} is a directory and only the `view` command can be used on directories")

    file_content = await _read_text_or_reject_binary(sandbox, file_path, max_size)

    hits = _find_line_numbers(file_content, search_text, fuzzy, cap=_MAX_FIND_LINE_HITS)
    if not hits:
        return f"No matches for `{search_text}` in {file_path}."

    line_numbers = [index + 1 for index in hits]
    truncated_note = f" (truncated to first {_MAX_FIND_LINE_HITS} hits)" if len(hits) == _MAX_FIND_LINE_HITS else ""

    first = hits[0]
    lines = file_content.split("\n")
    start = max(0, first - _SNIPPET_LINES)
    end = min(len(lines), first + _SNIPPET_LINES + 1)
    snippet = "\n".join(lines[start:end])

    return (
        f"Found `{search_text}` at line(s) {line_numbers}{truncated_note} of {file_path}.\n"
        f"{_make_output(snippet, f'a snippet around line {first + 1} of {file_path}', start + 1)}"
    )


async def _handle_undo(sandbox: Sandbox, file_path: str, undo_history: dict[str, str]) -> str:
    """Handle the ``undo_edit`` command: restore the last in-memory snapshot for ``file_path``.

    The snapshot is unconditionally written back through the sandbox: if the
    file was deleted (or moved) outside the tool since the snapshot was
    captured, ``undo_edit`` will re-create it at that path. Undo tracks
    content-per-path, not the file's presence.

    The snapshot stays in history until the restoring write succeeds so a
    transient sandbox failure leaves undo retryable.
    """
    if file_path not in undo_history:
        raise ValueError(f"No undo history available for {file_path} in this session.")

    previous_content = undo_history[file_path]
    await sandbox.write_text(file_path, previous_content)
    del undo_history[file_path]
    return f"Reverted {file_path} to its previous in-memory snapshot."

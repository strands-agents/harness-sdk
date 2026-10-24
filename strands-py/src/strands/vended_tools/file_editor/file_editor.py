"""Sandbox-routed file editor tool.

.. deprecated::
    This tool is deprecated in favor of the focused ``read``, ``write``, and
    ``edit`` vended tools (see :mod:`strands.vended_tools.edit`). It will be
    removed in a future release.

Provides ``view`` (with line ranges), ``create``, ``str_replace``, ``insert``,
``find_line``, and ``undo_edit`` operations, all routed through a
:class:`~strands.sandbox.base.Sandbox`: either one bound at creation (as the
built-in Docker/SSH sandboxes do when vending tools) or the agent's configured
sandbox read from ``tool_context.agent.sandbox`` at call time.
"""

from __future__ import annotations

import posixpath
import re
import warnings
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, cast

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
_DEFAULT_MAX_MEDIA_FILE_SIZE = 5 * _MB
_MAX_DIRECTORY_DEPTH = 2
_MAX_FIND_LINE_HITS = 200
_MAX_REPORTED_MATCH_LINES = 10
_DEFAULT_MAX_UNDO_ENTRIES = 16
_DEFAULT_MAX_UNDO_BYTES = 8 * _MB
# Bedrock DocumentBlock.name is capped at 200 characters by the Converse API.
_MAX_DOCUMENT_NAME_LENGTH = 200

# Detection is by extension because the sandbox seam exposes no MIME metadata.
_IMAGE_FORMATS = ("png", "jpg", "jpeg", "gif", "webp")
# PDF-only by default: office formats crash Anthropic unrecoverably. Opt in via
# ``binary_document_formats`` on providers that support them.
_DEFAULT_BINARY_DOCUMENT_FORMATS = ("pdf",)


def _default_description(*, media: bool, document_formats: tuple[str, ...]) -> str:
    docs = "/".join(document_formats)
    view_clause = (
        f"png/jpeg/gif/webp images and {docs} documents returned as media blocks"
        if media
        else f"png/jpeg/gif/webp images and {docs} documents described in text (this agent cannot render media)"
    )
    return (
        f"Filesystem editor for viewing, creating, and editing files. Any file type: view "
        f"(text with line ranges; {view_clause}). Text files only: create, str_replace "
        f"(exact match; ambiguous matches must opt in via replace_all), insert, find_line, "
        f"and undo_edit. Files must use absolute paths."
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


@dataclass
class _UndoEntry:
    """Single undo snapshot: file content plus its cached UTF-8 byte length.

    Pairing content with its byte length in one struct keeps size bookkeeping
    O(1) and prevents the two values from drifting out of sync across edits.
    """

    content: str
    size: int

    def to_state(self) -> dict[str, Any]:
        """Serialize for ``agent.state`` (JSON-compatible)."""
        return {"content": self.content, "size": self.size}

    @classmethod
    def from_state(cls, raw: Any) -> _UndoEntry:
        """Rebuild from a serialized ``agent.state`` entry, re-encoding size when absent."""
        if isinstance(raw, dict) and "content" in raw:
            content = raw["content"]
            size = raw.get("size")
            if not isinstance(size, int):
                size = len(content.encode("utf-8"))
            return cls(content=content, size=size)
        content = raw if isinstance(raw, str) else ""
        return cls(content=content, size=len(content.encode("utf-8")))


def make_file_editor(
    *,
    sandbox: Sandbox | None = None,
    name: str = "file_editor",
    description: str | None = None,
    root: str | None = None,
    max_file_size: int = _DEFAULT_MAX_FILE_SIZE,
    max_media_file_size: int = _DEFAULT_MAX_MEDIA_FILE_SIZE,
    max_undo_entries: int = _DEFAULT_MAX_UNDO_ENTRIES,
    max_undo_bytes: int = _DEFAULT_MAX_UNDO_BYTES,
    undo_state_key: str = DEFAULT_UNDO_STATE_KEY,
    media: bool = True,
    binary_document_formats: tuple[str, ...] = _DEFAULT_BINARY_DOCUMENT_FORMATS,
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
        description: Tool description shown to the model. Defaults to a
            description generated from ``media``, ``binary_document_formats``,
            and ``root``.
        root: Optional absolute directory that confines every operation. Paths
            are normalized and must sit inside ``root``. Confinement is
            *lexical*: the editor does not follow symlinks itself. Filesystem
            semantics are governed by the sandbox. The editor verifies ``root``
            exists in the sandbox on every call. When ``root`` is ``None`` only
            the absolute-path check applies.
        max_file_size: Maximum file size (bytes) accepted by view/edit
            commands for text files. Defaults to 1 MB.
        max_media_file_size: Maximum file size (bytes) accepted by ``view``
            for images and binary documents, which skip the text/edit path
            and are shipped verbatim to the model. Defaults to 5 MB, matched
            to the strictest common provider cap (Anthropic images at 5 MB,
            Bedrock documents at 4.5 MB and images at 3.75 MB).
        max_undo_entries: Maximum number of distinct paths retained in the
            in-memory undo history *per agent*. Oldest entry is evicted on
            overflow. Set to ``0`` to disable undo entirely — mutating
            commands then skip the agent-state write. Defaults to 16.
        max_undo_bytes: Approximate cap on total bytes of file content held in
            the per-agent undo history (UTF-8). Oldest entries are evicted
            until the cap is met. Defaults to 8 MB.
        undo_state_key: Key under which the undo history is stored in
            ``agent.state``. Two editors sharing the same key on the same
            agent will share undo history; use distinct keys to isolate them.
        media: Return images and binary documents as viewable media. Set
            ``False`` for a model that rejects media blocks, and ``view``
            describes those files in text instead.
        binary_document_formats: Extensions routed as binary DocumentBlocks.
            Defaults to ``("pdf",)``. Opt into the full office set
            ``("pdf", "doc", "docx", "xls", "xlsx")`` on a provider that
            supports them; Anthropic raises a non-recoverable
            ``TypeError("unsupported format")`` when office-format blocks
            re-enter conversation history.

    Returns:
        A decorated tool that performs file operations through the sandbox.

    Raises:
        ValueError: If ``root`` is set but not an absolute path.
    """
    warnings.warn(
        "file_editor is deprecated and will be removed in a future release. "
        "Use the focused read, write, and edit vended tools instead "
        "(strands.vended_tools.edit, and the forthcoming read/write tools).",
        DeprecationWarning,
        stacklevel=2,
    )
    if root is not None and not posixpath.isabs(root):
        raise ValueError(f"root must be an absolute path, got: {root}")
    normalized_root: str | None = None if root is None else posixpath.normpath(root).rstrip("/") or "/"
    binary_document_formats = tuple(ext.lower() for ext in binary_document_formats)

    if description is None:
        description = _default_description(media=media, document_formats=binary_document_formats)
        if normalized_root is not None:
            description = f"{description} All paths must be absolute and inside {normalized_root}."

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
                ``undo_edit`` restores ``path`` to the content captured just
                before the most recent ``str_replace`` or ``insert`` on that
                path in this session — a single-step revert, not a stack, and
                it does not track ``create`` or changes made by other tools.
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
        await _verify_root(active, normalized_root)
        resolved = _resolve_path(path, normalized_root)

        if command == "view":
            return await _handle_view(
                active,
                resolved,
                view_range,
                max_file_size,
                max_media_file_size,
                tool_context.tool_use["toolUseId"],
                media,
                binary_document_formats,
            )
        if command == "find_line":
            return await _handle_find_line(active, resolved, search_text, fuzzy, max_file_size)

        state = tool_context.agent.state

        if command == "create":
            result = await _handle_create(active, resolved, file_text, max_file_size)
            _commit_undo_update(
                state,
                undo_state_key,
                resolved,
                snapshot=None,
                max_entries=max_undo_entries,
                max_bytes=max_undo_bytes,
            )
            return result
        if command == "str_replace":
            result, pre_edit_content = await _handle_str_replace(
                active, resolved, old_str, new_str, replace_all, max_file_size
            )
            _commit_undo_update(
                state,
                undo_state_key,
                resolved,
                snapshot=pre_edit_content,
                max_entries=max_undo_entries,
                max_bytes=max_undo_bytes,
            )
            return result
        if command == "insert":
            result, pre_edit_content = await _handle_insert(active, resolved, insert_line, new_str, max_file_size)
            _commit_undo_update(
                state,
                undo_state_key,
                resolved,
                snapshot=pre_edit_content,
                max_entries=max_undo_entries,
                max_bytes=max_undo_bytes,
            )
            return result
        if command == "undo_edit":
            if max_undo_entries <= 0:
                raise ValueError("Undo is disabled for this editor (max_undo_entries=0).")
            raw_history = state.get(undo_state_key) or {}
            if resolved not in raw_history:
                raise ValueError(f"No undo history available for {resolved} in this session.")
            snapshot = _UndoEntry.from_state(raw_history[resolved])
            await active.write_text(resolved, snapshot.content)
            _commit_undo_update(
                state,
                undo_state_key,
                resolved,
                snapshot=None,
                max_entries=max_undo_entries,
                max_bytes=max_undo_bytes,
            )
            return f"Reverted {resolved} to its previous in-memory snapshot."

        raise ValueError(f"Unknown command: {command}")

    return file_editor_tool


file_editor = make_file_editor()
"""Default sandbox-routed file editor tool. Reads the sandbox from the agent's context at call time."""


# ---- Path resolution and confinement ----


async def _verify_root(sandbox: Sandbox, normalized_root: str | None) -> None:
    """Verify ``normalized_root`` exists in the sandbox, raising a clear configuration error if not.

    Probed on every call rather than memoized: a root that is deleted after an
    earlier successful probe must still trip the clear configuration error, not
    surface as a generic "path does not exist" on whatever child the model
    tries next.
    """
    if normalized_root is None:
        return
    try:
        await sandbox.list_files(normalized_root)
    except SandboxPathNotFoundError as error:
        raise ValueError(f"Invalid configuration: root {normalized_root} does not exist in the sandbox.") from error


def _resolve_path(file_path: str, root: str | None) -> str:
    """Normalize a path and enforce lexical confinement.

    Rejects non-absolute paths and any ``..`` segment outright, matching the
    sandbox path model. When ``root`` is set the normalized path must also
    sit inside it. Symlink semantics are the sandbox's responsibility.

    Raises:
        ValueError: On non-absolute paths, ``..`` segments, or out-of-root
            resolution.
    """
    stripped = file_path.rstrip("/") or file_path

    if not posixpath.isabs(stripped):
        suggested = posixpath.abspath(stripped)
        raise ValueError(
            f"The path {file_path} is not an absolute path, it should start with `/`. Maybe you meant {suggested}?"
        )

    if ".." in stripped.split("/"):
        raise ValueError("Invalid path: path traversal is not allowed")

    normalized = posixpath.normpath(stripped)

    if root is not None:
        root_norm = posixpath.normpath(root).rstrip("/") or "/"
        prefix = root_norm if root_norm == "/" else root_norm + "/"
        if normalized != root_norm and not normalized.startswith(prefix):
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
        # Walk non-overlapping matches so the reported lines agree with
        # ``str.count``, and cap the list so a many-match file does not
        # flood the model with a huge error.
        line_numbers: list[int] = []
        search_from = 0
        while (
            len(line_numbers) < _MAX_REPORTED_MATCH_LINES
            and (match_index := original_content.find(old_str, search_from)) != -1
        ):
            line_numbers.append(original_content.count("\n", 0, match_index) + 1)
            search_from = match_index + len(old_str)
        shown = f"{line_numbers}{'...' if occurrences > _MAX_REPORTED_MATCH_LINES else ''}"
        raise ValueError(
            f"No replacement was performed. {occurrences} occurrences of old_str `{old_str}` on lines "
            f"{shown}. Pass replace_all=True to replace every occurrence, or make old_str unique."
        )

    # Project the exact output size before allocating the substituted string so
    # a pathological ``replace_all`` (many small matches, large replacement)
    # cannot trigger a multi-gigabyte buffer. ``str.replace`` doesn't re-run
    # itself, so the arithmetic is exact.
    count = occurrences if replace_all else 1
    projected = len(original_content.encode("utf-8")) + count * (
        len(new_str_value.encode("utf-8")) - len(old_str.encode("utf-8"))
    )
    if projected > max_size:
        raise ValueError(
            f"The edit would produce a {projected}-byte file at {file_path}, "
            f"exceeding the maximum allowed size of {max_size} bytes."
        )
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
    r"""Return every 0-indexed line where ``search_text`` matches, capped at ``cap`` entries.

    When ``fuzzy=True``, runs of whitespace in both the search text and each
    line are collapsed to a single space before a case-insensitive substring
    match — so ``"foo bar"`` matches ``"foo   bar"`` or ``"foo\tbar"`` but
    not ``"foo xyz bar"``. Returns an empty list when nothing matches.
    """
    lines = content.split("\n")
    hits: list[int] = []
    # Empty search text would make the plain substring branch match every line
    # (``"" in line`` is always true); align the fuzzy branch to the same rule.
    if not search_text:
        return hits
    if fuzzy:
        needle = " ".join(search_text.split()).lower()
        if not needle:
            return hits
        for index, line in enumerate(lines):
            if needle in " ".join(line.split()).lower():
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


def _commit_undo_update(
    state: Any,
    state_key: str,
    file_path: str,
    *,
    snapshot: str | None,
    max_entries: int = _DEFAULT_MAX_UNDO_ENTRIES,
    max_bytes: int = _DEFAULT_MAX_UNDO_BYTES,
) -> None:
    """Apply an undo-history update to ``agent.state`` with no await between read and write.

    ``snapshot=None`` clears any entry for ``file_path`` (``create`` and
    ``undo_edit``); a string stores it as the pre-edit snapshot. The read of
    ``state.get`` and the matching ``state.set`` run back-to-back without an
    ``await`` in between, so two concurrent file_editor calls serialize on the
    event loop at the state write and cannot drop each other's snapshots.

    Callers must invoke this only *after* the corresponding sandbox write has
    succeeded so a failed write does not overwrite a still-valid earlier entry.
    """
    if max_entries <= 0:
        return
    raw_history = state.get(state_key) or {}
    undo_history: dict[str, _UndoEntry] = {path: _UndoEntry.from_state(entry) for path, entry in raw_history.items()}

    if snapshot is None:
        if undo_history.pop(file_path, None) is None:
            return
    else:
        undo_history.pop(file_path, None)
        undo_history[file_path] = _UndoEntry(content=snapshot, size=len(snapshot.encode("utf-8")))
        total_bytes = sum(entry.size for entry in undo_history.values())
        # Preserve the just-inserted entry: an edit whose snapshot alone exceeds
        # ``max_bytes`` would otherwise evict every older entry and then itself,
        # leaving the user with no undo for a write we already reported as
        # successful. The byte cap is best-effort when a single snapshot is
        # larger than the whole budget.
        while len(undo_history) > 1 and (len(undo_history) > max_entries or total_bytes > max_bytes):
            oldest_key = next(iter(undo_history))
            total_bytes -= undo_history.pop(oldest_key).size

    state.set(state_key, {path: entry.to_state() for path, entry in undo_history.items()})


# ---- Sandbox-routed I/O helpers ----


async def _probe_sandbox_path(sandbox: Sandbox, file_path: str) -> tuple[bool, bool]:
    """Return ``(exists, is_dir)`` for a path by listing its parent through the sandbox.

    A missing parent or entry becomes ``(False, False)``; other listing errors
    (permission, transport) propagate so they are not disguised as non-existence.
    """
    parent = "/".join(file_path.split("/")[:-1]) or "/"
    name = file_path.split("/")[-1]
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
    except UnicodeDecodeError as error:
        raise ValueError(f"Refusing to read non-UTF-8 file: {file_path}") from error


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


def _document_name(file_path: str) -> str:
    """Sanitize a filename into a model-safe document name.

    Bedrock accepts only alphanumerics, whitespace, hyphens, parentheses, and square brackets
    in document names, with no consecutive whitespace, and caps the length at 200 characters.
    """
    name = posixpath.basename(file_path)
    name = re.sub(r"[^a-zA-Z0-9\s\-()\[\]]", " ", name)
    name = re.sub(r"\s+", " ", name).strip()[:_MAX_DOCUMENT_NAME_LENGTH]
    return name or "document"


async def _handle_view(
    sandbox: Sandbox,
    file_path: str,
    view_range: list[int] | None,
    max_size: int,
    max_media_size: int,
    tool_use_id: str,
    media: bool,
    binary_document_formats: tuple[str, ...],
) -> str | ToolResult:
    """Handle ``view``: numbered text, directory listing, or a media ToolResult for images/binary documents."""
    exists, is_dir = await _probe_sandbox_path(sandbox, file_path)
    if not exists:
        raise ValueError(f"The path {file_path} does not exist. Please provide a valid path.")

    if is_dir:
        if view_range:
            raise ValueError("The `view_range` parameter is not allowed when `path` points to a directory.")
        return await _list_directory(sandbox, file_path)

    extension = posixpath.splitext(file_path)[1].lstrip(".").lower()

    is_image = extension in _IMAGE_FORMATS
    if is_image or extension in binary_document_formats:
        if view_range:
            raise ValueError("The `view_range` parameter is not allowed for image or binary document files.")
        raw = await sandbox.read_file(file_path)
        if not media:
            kind = "image" if is_image else "document"
            return (
                f"[{kind.capitalize()} file: {file_path} ({extension}, {len(raw)} bytes). "
                f"This model cannot view {kind} files, so its contents are not shown. "
                f"Use shell tools if the file has a text-extractable form.]"
            )
        if len(raw) > max_media_size:
            raise ValueError(f"File size ({len(raw)} bytes) exceeds maximum allowed size ({max_media_size} bytes)")
        if is_image:
            image_format = cast(ImageFormat, "jpeg" if extension == "jpg" else extension)
            return ToolResult(
                toolUseId=tool_use_id,
                status="success",
                content=[{"image": {"format": image_format, "source": {"bytes": raw}}}],
            )
        return ToolResult(
            toolUseId=tool_use_id,
            status="success",
            content=[
                {
                    "document": {
                        "format": cast(DocumentFormat, extension),
                        "name": _document_name(file_path),
                        "source": {"bytes": raw},
                    }
                }
            ],
        )

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
    max_size: int,
) -> str:
    """Handle the ``create`` command: write a new file, refusing to overwrite.

    ``create`` is intentionally not snapshotted for undo: rolling back a create
    means deleting the file, which is a different operation from "restore prior
    content" and is easy for the caller to do themselves. The caller clears any
    stale snapshot for ``file_path`` after this returns.
    """
    if file_text is None:
        raise ValueError("Parameter `file_text` is required for command: create")
    _reject_oversize_replacement(file_text, max_size, label="file_text")

    exists, _ = await _probe_sandbox_path(sandbox, file_path)
    if exists:
        raise ValueError(f"File already exists at: {file_path}. Cannot overwrite files using command `create`.")

    await sandbox.write_text(file_path, file_text)
    return f"File created successfully at: {file_path}"


async def _handle_str_replace(
    sandbox: Sandbox,
    file_path: str,
    old_str: str | None,
    new_str: str | None,
    replace_all: bool,
    max_size: int,
) -> tuple[str, str]:
    """Handle the ``str_replace`` command: replace ``old_str`` (unique unless ``replace_all``).

    Text-representable formats (``csv``, ``html``, ``txt``, ``md``) stay on
    this path by design: they are listed as documents by Bedrock's taxonomy
    but ``str_replace`` and ``find_line`` only work against the numbered
    lines, so ``binary_document_formats`` deliberately excludes them.

    Returns ``(message, pre_edit_content)`` so the caller can snapshot the
    original content into the undo history after this coroutine's final await.
    """
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

    await sandbox.write_text(file_path, new_content)

    suffix = f" ({count} occurrences replaced)" if replace_all and count > 1 else ""
    message = (
        f"The file {file_path} has been edited.{suffix} "
        f"{_make_output(snippet, f'a snippet of {file_path}', start_line + 1)}"
        "Review the changes and make sure they are as expected. Edit the file again if necessary."
    )
    return message, file_content


async def _handle_insert(
    sandbox: Sandbox,
    file_path: str,
    insert_line: int | None,
    new_str: str | None,
    max_size: int,
) -> tuple[str, str]:
    """Handle the ``insert`` command: insert text at a 0-indexed line.

    Returns ``(message, pre_edit_content)`` so the caller can snapshot the
    original content into the undo history after this coroutine's final await.
    """
    if insert_line is None or new_str is None:
        raise ValueError("Parameters `insert_line` and `new_str` are required for command: insert")
    _reject_oversize_replacement(new_str, max_size)

    exists, is_dir = await _probe_sandbox_path(sandbox, file_path)
    if not exists:
        raise ValueError(f"The path {file_path} does not exist. Please provide a valid path.")
    if is_dir:
        raise ValueError(f"The path {file_path} is a directory and only the `view` command can be used on directories")

    file_text = await _read_text_or_reject_binary(sandbox, file_path, max_size)

    # Project the UTF-8 output size before building the string so an insert
    # that would blow past ``max_size`` is rejected without allocating it. One
    # extra newline joins the inserted block to the surrounding content; no
    # separator is added when the file was empty — ``_build_insert_result``
    # replaces the content outright in that case.
    separator = 1 if file_text else 0
    projected = len(file_text.encode("utf-8")) + len(new_str.encode("utf-8")) + separator
    if projected > max_size:
        raise ValueError(
            f"The edit would produce a {projected}-byte file at {file_path}, "
            f"exceeding the maximum allowed size of {max_size} bytes."
        )

    new_content, snippet, start_line = _build_insert_result(file_text, insert_line, new_str)

    await sandbox.write_text(file_path, new_content)

    message = (
        f"The file {file_path} has been edited. "
        f"{_make_output(snippet, 'a snippet of the edited file', start_line + 1)}"
        "Review the changes and make sure they are as expected (correct indentation, no duplicate lines, etc). "
        "Edit the file again if necessary."
    )
    return message, file_text


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

    # Scan one past the cap so the handler can distinguish "exactly cap matches"
    # (not truncated) from "cap or more matches" (truncated). Truncating the
    # list for display happens here, not inside `_find_line_numbers`.
    hits = _find_line_numbers(file_content, search_text, fuzzy, cap=_MAX_FIND_LINE_HITS + 1)
    if not hits:
        return f"No matches for `{search_text}` in {file_path}."

    truncated = len(hits) > _MAX_FIND_LINE_HITS
    if truncated:
        hits = hits[:_MAX_FIND_LINE_HITS]
    line_numbers = [index + 1 for index in hits]
    truncated_note = f" (truncated to first {_MAX_FIND_LINE_HITS} hits)" if truncated else ""

    first = hits[0]
    lines = file_content.split("\n")
    start = max(0, first - _SNIPPET_LINES)
    end = min(len(lines), first + _SNIPPET_LINES + 1)
    snippet = "\n".join(lines[start:end])

    return (
        f"Found `{search_text}` at line(s) {line_numbers}{truncated_note} of {file_path}.\n"
        f"{_make_output(snippet, f'a snippet around line {first + 1} of {file_path}', start + 1)}"
    )

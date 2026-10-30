"""Filesystem tools: ``read``, ``write``, ``edit``.

Thin tools that route file access through the same ``tool_context.agent.sandbox`` seam the SDK's
file editor uses, so they behave identically across host and container filesystems. They are
candidates to port into the core SDK later; keep them minimal and SDK-idiomatic.
"""

from __future__ import annotations

import ntpath
import posixpath
import re

from strands.tools.decorator import tool
from strands.types.tools import ToolContext, ToolResult

_READ_DEFAULT_LIMIT = 2000

# Media formats the SDK accepts in tool results, selected by file extension because the sandbox seam
# exposes no MIME metadata. Text-representable document formats (csv, html, txt, md) stay on the
# numbered-lines path, which supports citing and paging. Video is omitted: the SDK's tool results do
# not accept video content.
_IMAGE_EXTENSIONS = ("png", "jpg", "jpeg", "gif", "webp")
_DOCUMENT_FORMATS = ("pdf", "doc", "docx", "xls", "xlsx")

# For images the extension only selects the media path; the signature decides the format. A non-image or
# mislabeled file sent as a success image block poisons history (every later request fails on it).
_IMAGE_SIGNATURES = ((b"\x89PNG\r\n\x1a\n", "png"), (b"\xff\xd8\xff", "jpeg"), (b"GIF87a", "gif"), (b"GIF89a", "gif"))


def _validate_path(path: str) -> None:
    # The path belongs to the sandbox, not the host, so accept either platform's notion of absolute. The two
    # libraries disagree only on backslash-rooted-without-drive (``\foo``: Node yes, Python 3.13 no); that
    # divergence is intentional and stdlib-driven, so do not hand-roll the check to make the SDKs agree.
    if not (posixpath.isabs(path) or ntpath.isabs(path)):
        raise ValueError(
            f"The path {path} is not absolute; it should start with '/' (or a drive letter or UNC share on Windows)."
        )
    if ".." in re.split(r"[/\\]", path):
        raise ValueError("Invalid path: path traversal is not allowed.")


def _number_lines(content: str, start: int) -> str:
    return "\n".join(f"{i + start:>6}\t{line}" for i, line in enumerate(content.split("\n")))


def _extension(path: str) -> str:
    name = re.split(r"[/\\]", path)[-1]
    return name.rpartition(".")[2].lower() if "." in name else ""


def _document_name(path: str) -> str:
    """Sanitize a filename into a model-safe document name.

    Bedrock accepts only alphanumerics, whitespace, hyphens, parentheses, and square brackets
    in document names, with no consecutive whitespace.
    """
    name = re.split(r"[/\\]", path)[-1]
    name = re.sub(r"[^a-zA-Z0-9\s\-()\[\]]", " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name or "document"


def _sniff_image_format(data: bytes) -> str | None:
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return next((fmt for signature, fmt in _IMAGE_SIGNATURES if data.startswith(signature)), None)


def _media_placeholder(path: str, kind: str, media_format: str, size: int) -> str:
    return (
        f"[{kind} file: {path} ({media_format}, {size} bytes). This model cannot view "
        f"{kind.lower()} files, so its contents are not shown. Use shell tools if the file has a "
        f"text-extractable form.]"
    )


def make_read(media: bool = True):
    """Build the ``read`` tool.

    Args:
        media: Return images and binary documents as viewable media. Set ``False`` for a model that
            rejects media blocks, and ``read`` describes those files in text instead. See
            ``_supports_media`` in ``models``.
    """

    @tool(name="read", context="tool_context")
    async def read(
        path: str, tool_context: ToolContext, offset: int | None = None, limit: int | None = None
    ) -> str | ToolResult:
        """Read a file. Text returns ``cat -n`` style numbered lines so you can cite ``path:line``; images
        (png/jpg/jpeg/gif/webp) and binary documents (pdf/doc/docx/xls/xlsx) return media you can view directly.

        Args:
            path: Absolute path to the file.
            tool_context: Injected by the framework. Not user-facing.
            offset: 1-indexed line to start from. Defaults to the first line. Text files only.
            limit: Maximum number of lines to return. Defaults to 2000. Text files only.
        """
        _validate_path(path)
        extension = _extension(path)

        if extension in _IMAGE_EXTENSIONS:
            data = await tool_context.agent.sandbox.read_file(path)
            image_format = _sniff_image_format(data)
            if image_format is None:
                raise ValueError(
                    f"{path} has a .{extension} extension but its {len(data)} bytes are not a png, jpeg, gif, or webp "
                    f"image. Identify it with `file`; if it is text, read it with `cat`."
                )
            if not media:
                return _media_placeholder(path, "Image", image_format, len(data))
            return {
                "toolUseId": tool_context.tool_use["toolUseId"],
                "status": "success",
                "content": [{"image": {"format": image_format, "source": {"bytes": data}}}],
            }

        if extension in _DOCUMENT_FORMATS:
            data = await tool_context.agent.sandbox.read_file(path)
            if not media:
                return _media_placeholder(path, "Document", extension, len(data))
            return {
                "toolUseId": tool_context.tool_use["toolUseId"],
                "status": "success",
                "content": [
                    {"document": {"format": extension, "name": _document_name(path), "source": {"bytes": data}}}
                ],
            }

        content = await tool_context.agent.sandbox.read_text(path)

        lines = content.split("\n")
        start = max(0, (offset - 1) if offset else 0)
        count = limit if limit is not None else _READ_DEFAULT_LIMIT
        window = lines[start : start + count]
        if not window:
            return f"[File has {len(lines)} lines; offset {offset} is past the end.]"

        numbered = _number_lines("\n".join(window), start + 1)
        if start > 0 or start + count < len(lines):
            shown_end = start + len(window)
            numbered += f"\n[Showing lines {start + 1}-{shown_end} of {len(lines)}. Use offset/limit to read more.]"
        return numbered

    return read


read = make_read()


@tool(name="write", context="tool_context")
async def write(path: str, content: str, tool_context: ToolContext) -> str:
    """Write a file, creating it or overwriting it. Use ``edit`` for surgical changes to a large file.

    Args:
        path: Absolute path to the file.
        content: The full file content to write.
        tool_context: Injected by the framework. Not user-facing.
    """
    _validate_path(path)
    await tool_context.agent.sandbox.write_text(path, content)
    line_count = 0 if content == "" else len(content.split("\n"))
    return f"Wrote {line_count} lines to {path}."


@tool(name="edit", context="tool_context")
async def edit(path: str, old_str: str, new_str: str, tool_context: ToolContext) -> str:
    """Replace an exact string in a file. ``old_str`` must appear exactly once.

    Args:
        path: Absolute path to the file.
        old_str: Exact text to find. Must be unique within the file.
        new_str: Replacement text.
        tool_context: Injected by the framework. Not user-facing.
    """
    _validate_path(path)
    sandbox = tool_context.agent.sandbox
    content = await sandbox.read_text(path)

    occurrences = content.count(old_str)
    if occurrences == 0:
        raise ValueError(f"old_str did not appear verbatim in {path}.")
    if occurrences > 1:
        raise ValueError(f"old_str appears {occurrences} times in {path}; make it unique.")

    await sandbox.write_text(path, content.replace(old_str, new_str, 1))
    return f"Edited {path}."

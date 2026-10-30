"""Sandbox-routed read tool.

Reads a file through a :class:`~strands.sandbox.base.Sandbox`: either one bound
at creation via :func:`make_read` or the agent's configured sandbox read from
``tool_context.agent.sandbox`` at call time. Text files return ``cat -n`` style
numbered lines so the model can cite ``path:line``; images (png/jpg/jpeg/gif/webp)
and binary documents (pdf/doc/docx/xls/xlsx) return as media content blocks when
``media`` is on.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, cast

from ...tools.decorator import tool
from ...types.media import DocumentFormat, ImageFormat
from ...types.tools import ToolContext, ToolResult
from .._paths import validate_absolute_path

if TYPE_CHECKING:
    from ...sandbox.base import Sandbox
    from ...tools.decorator import DecoratedFunctionTool

_READ_DEFAULT_LIMIT = 2000
_READ_MAX_BYTES = 1_048_576  # 1MB — mirrors file_editor so a few long lines cannot blow out model context
_READ_MAX_MEDIA_BYTES = 10_485_760  # 10MB — guards memory + provider payload limits

# Media formats the SDK accepts in tool results, selected by file extension because the sandbox seam
# exposes no MIME metadata. Text-representable document formats (csv, html, txt, md) stay on the
# numbered-lines path, which supports citing and paging. Video is omitted: the SDK's tool results do
# not accept video content.
_IMAGE_EXTENSIONS = ("png", "jpg", "jpeg", "gif", "webp")
_DOCUMENT_FORMATS = ("pdf", "doc", "docx", "xls", "xlsx")

# For images the extension only selects the media path; the signature decides the format. A non-image or
# mislabeled file sent as a success image block poisons history (every later request fails on it).
_IMAGE_SIGNATURES: tuple[tuple[bytes, ImageFormat], ...] = (
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpeg"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
)

# Documents are picked by extension but checked by magic bytes before shipping as a document block, for
# the same history-poisoning reason as images. Legacy .doc/.xls are OLE2 compound files; .docx/.xlsx are
# ZIP containers.
_OLE2_SIGNATURE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
_ZIP_SIGNATURE = b"PK\x03\x04"
_DOCUMENT_SIGNATURES: dict[str, tuple[bytes, ...]] = {
    "pdf": (b"%PDF-",),
    "doc": (_OLE2_SIGNATURE,),
    "xls": (_OLE2_SIGNATURE,),
    "docx": (_ZIP_SIGNATURE,),
    "xlsx": (_ZIP_SIGNATURE,),
}

DEFAULT_READ_DESCRIPTION = (
    "Read a file. Text returns `cat -n` style numbered lines so you can cite `path:line`. "
    "Files must use absolute paths."
)
_MEDIA_DESCRIPTION_SUFFIX = (
    " Images (png/jpg/jpeg/gif/webp) and binary documents (pdf/doc/docx/xls/xlsx) return media you can view directly."
)


def make_read(
    *,
    media: bool = True,
    sandbox: Sandbox | None = None,
    name: str = "read",
    description: str | None = None,
    max_bytes: int = _READ_MAX_BYTES,
    max_media_bytes: int = _READ_MAX_MEDIA_BYTES,
) -> DecoratedFunctionTool:
    """Create a sandbox-routed ``read`` tool.

    If a ``sandbox`` is passed, it is bound at creation time. Otherwise the tool
    reads the sandbox from ``tool_context.agent.sandbox`` at call time.

    Args:
        media: Return images and binary documents as viewable media. Set to
            ``False`` for a model that rejects media blocks, and ``read``
            describes those files in text instead.
        sandbox: Sandbox to bind at creation. When ``None``, the agent's
            configured sandbox is used at call time.
        name: Tool name. Defaults to ``"read"``.
        description: Tool description shown to the model.
        max_bytes: Maximum size of the returned text window. A 1MB default
            keeps a 1-line minified JSON file from exhausting the model's
            context; raise it when the agent needs to read bigger single-line
            payloads.
        max_media_bytes: Maximum byte size for image and document reads.
            Defaults to 10MB, above Anthropic's 5MB image and Bedrock's 4.5MB
            document limits.

    Returns:
        A decorated tool that reads files through the sandbox.
    """
    if description is None:
        description = DEFAULT_READ_DESCRIPTION + (_MEDIA_DESCRIPTION_SUFFIX if media else "")

    @tool(name=name, description=description, context="tool_context")
    async def read_tool(
        path: str,
        tool_context: ToolContext,
        offset: int | None = None,
        limit: int | None = None,
    ) -> str | ToolResult:
        """Read a file. Text returns ``cat -n`` style numbered lines so you can cite ``path:line``.

        Images (png/jpg/jpeg/gif/webp) and binary documents (pdf/doc/docx/xls/xlsx) return media you
        can view directly.

        Args:
            path: Absolute path to the file.
            tool_context: Injected by the framework. Not user-facing.
            offset: 1-indexed line to start from. Defaults to the first line. Text files only.
            limit: Maximum number of lines to return. Defaults to 2000. Text files only.
        """
        validate_absolute_path(path)
        if offset is not None and offset < 1:
            raise ValueError(f"offset must be a positive 1-indexed line number, got {offset}.")
        if limit is not None and limit < 1:
            raise ValueError(f"limit must be a positive line count, got {limit}.")
        active = sandbox if sandbox is not None else tool_context.agent.sandbox
        extension = _extension(path)

        if extension in _IMAGE_EXTENSIONS:
            data = await active.read_file(path)
            image_format = _sniff_image_format(data)
            if image_format is None:
                raise ValueError(
                    f"{path} has a .{extension} extension but its {len(data)} bytes are not a png, jpeg, gif, "
                    f"or webp image. If a shell tool is available, use it to identify or extract text."
                )
            if not media:
                return _media_placeholder(path, "Image", image_format, len(data))
            _assert_media_within_size_limit(path, "image", len(data), max_media_bytes)
            image_result: ToolResult = {
                "toolUseId": tool_context.tool_use["toolUseId"],
                "status": "success",
                "content": [{"image": {"format": image_format, "source": {"bytes": data}}}],
            }
            return image_result

        if extension in _DOCUMENT_FORMATS:
            data = await active.read_file(path)
            if not any(data.startswith(signature) for signature in _DOCUMENT_SIGNATURES[extension]):
                raise ValueError(
                    f"{path} has a .{extension} extension but its {len(data)} bytes are not a valid "
                    f"{extension} document. If a shell tool is available, use it to identify or extract text."
                )
            if not media:
                return _media_placeholder(path, "Document", extension, len(data))
            _assert_media_within_size_limit(path, "document", len(data), max_media_bytes)
            document_result: ToolResult = {
                "toolUseId": tool_context.tool_use["toolUseId"],
                "status": "success",
                "content": [
                    {
                        "document": {
                            "format": cast(DocumentFormat, extension),
                            "name": _document_name(path),
                            "source": {"bytes": data},
                        }
                    }
                ],
            }
            return document_result

        try:
            content = await active.read_text(path)
        except UnicodeDecodeError as error:
            raise ValueError(
                f"{path} is not UTF-8 text (decode failed at byte {error.start}). If a shell tool is "
                f"available, inspect it there."
            ) from error

        lines = content.split("\n")
        start = max(0, (offset - 1) if offset else 0)
        count = limit if limit is not None else _READ_DEFAULT_LIMIT
        window = lines[start : start + count]
        if not window:
            return f"[File has {len(lines)} lines; offset {offset} is past the end.]"

        window_text = "\n".join(window)
        window_bytes = len(window_text.encode("utf-8"))
        if window_bytes > max_bytes:
            raise ValueError(
                f"Read window from {path} is {window_bytes} bytes ({len(window)} lines), exceeding the "
                f"{max_bytes}-byte limit. Reduce `limit` or shift `offset` to read a smaller slice."
            )

        numbered = "\n".join(f"{index + start + 1:>6}\t{line}" for index, line in enumerate(window))
        if start > 0 or start + count < len(lines):
            shown_end = start + len(window)
            numbered += f"\n[Showing lines {start + 1}-{shown_end} of {len(lines)}. Use offset/limit to read more.]"
        return numbered

    return read_tool


read = make_read()
"""Default sandbox-routed ``read`` tool. Reads the sandbox from the agent's context at call time."""


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


def _sniff_image_format(data: bytes) -> ImageFormat | None:
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return next((fmt for signature, fmt in _IMAGE_SIGNATURES if data.startswith(signature)), None)


def _assert_media_within_size_limit(path: str, kind: str, size: int, max_bytes: int) -> None:
    if size > max_bytes:
        raise ValueError(
            f"{path} is {size} bytes, exceeding the {max_bytes}-byte limit for {kind} reads. "
            f"If a shell tool is available, use it to extract a smaller representation."
        )


def _media_placeholder(path: str, kind: str, media_format: str, size: int) -> str:
    return (
        f"[{kind} file: {path} ({media_format}, {size} bytes). This model cannot view "
        f"{kind.lower()} files, so its contents are not shown. If a shell tool is available, use it "
        f"when the file has a text-extractable form.]"
    )

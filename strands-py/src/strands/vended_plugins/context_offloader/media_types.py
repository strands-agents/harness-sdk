"""Canonical media-type mapping for offloaded content blocks.

At offload time the plugin knows each content block's structural identity: its
kind (text, json, image, or document) plus its ``format``. That identity is
projected into a single canonical MIME string which the storage backends
persist (metadata sidecar / S3 ``ContentType``) and which drives three
consumers:

- **File extension**: artifacts land on disk with a shell-friendly extension
  (``.csv``, ``.md``, ``.pdf``, ...) so agents can inspect them directly with
  shell tools instead of re-injecting content into context.
- **Searchability**: text-based document formats are stored under ``text/*``
  types, so they can be pattern-searched via ``retrieve_offloaded_content``.
- **Reconstruction**: full retrieval rebuilds the original content block
  (same kind, same format) through the inverse mapping.

The mapping covers the SDK's own format contract
(:data:`strands.types.media.DocumentFormat`) -- no provider-specific enum is
involved -- so offload -> retrieve reproduces the original document block for
every format except ``txt``, which intentionally retrieves as plain text
(content-identical, and additionally pattern-searchable). A drift-guard test
keeps this table in lockstep with ``DocumentFormat``.
"""

from __future__ import annotations

_DOCUMENT_FORMAT_TO_MIME: dict[str, str] = {
    "pdf": "application/pdf",
    "csv": "text/csv",
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xls": "application/vnd.ms-excel",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "html": "text/html",
    "txt": "text/plain",
    "md": "text/markdown",
}
"""Canonical IANA MIME type for each :data:`~strands.types.media.DocumentFormat`.

``txt`` maps to ``text/plain``, the same type used for plain text blocks: both
retrieve as text, which is content-identical to the original document block
and additionally makes the content pattern-searchable.
"""

_LEGACY_DOCUMENT_MIME_TO_FORMAT: dict[str, str] = {f"application/{fmt}": fmt for fmt in _DOCUMENT_FORMAT_TO_MIME}
"""Fabricated ``application/{format}`` types written by earlier releases.

Kept so artifacts stored before the canonical mapping still reconstruct into
their original document blocks.
"""

_MIME_TO_DOCUMENT_FORMAT: dict[str, str] = {
    **_LEGACY_DOCUMENT_MIME_TO_FORMAT,
    **{mime: fmt for fmt, mime in _DOCUMENT_FORMAT_TO_MIME.items() if mime != "text/plain"},
}
"""Inverse mapping used to reconstruct document blocks on retrieval.

``text/plain`` is intentionally absent: it retrieves as plain text (see
:data:`_DOCUMENT_FORMAT_TO_MIME`).
"""

_LEGACY_TEXT_DOCUMENT_TYPES: frozenset[str] = frozenset(f"application/{fmt}" for fmt in ("csv", "txt", "md", "html"))
"""Legacy types whose bytes are text and therefore pattern-searchable."""

_MIME_TO_EXTENSION: dict[str, str] = {
    "text/plain": ".txt",
    "text/csv": ".csv",
    "text/html": ".html",
    "text/markdown": ".md",
    "application/pdf": ".pdf",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/json": ".json",
    "application/octet-stream": ".bin",
}
"""File extensions for stored content types (keeps artifacts shell-friendly)."""


def _mime_for_document_format(doc_format: str) -> str:
    """Return the canonical MIME type to store a document block under.

    Formats outside :data:`~strands.types.media.DocumentFormat` (possible only
    with untyped runtime data) fall back to ``application/octet-stream``, which
    retrieval decodes as text rather than fabricating a document block the
    model would reject.

    Args:
        doc_format: The document block's ``format`` value.

    Returns:
        The canonical MIME type for the format.
    """
    return _DOCUMENT_FORMAT_TO_MIME.get(doc_format, "application/octet-stream")


def _document_format_for_mime(content_type: str) -> str | None:
    """Return the original document format for a stored MIME type, if any.

    Args:
        content_type: The stored MIME type.

    Returns:
        The document format to reconstruct, or ``None`` if the type does not
        correspond to a document block.
    """
    return _MIME_TO_DOCUMENT_FORMAT.get(content_type)


def _extension_for_content_type(content_type: str) -> str:
    """Return a file extension for the given content type.

    Args:
        content_type: The stored MIME type.

    Returns:
        A file extension including the leading dot.
    """
    ext = _MIME_TO_EXTENSION.get(content_type)
    if ext is not None:
        return ext
    return f".{content_type.split('/')[-1]}"

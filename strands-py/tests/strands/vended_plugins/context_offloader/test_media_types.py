"""Tests for the canonical media-type mapping."""

from typing import get_args

from strands.types.media import DocumentFormat
from strands.vended_plugins.context_offloader.media_types import (
    _DOCUMENT_FORMAT_TO_MIME,
    _MIME_TO_EXTENSION,
    _document_format_for_mime,
    _mime_for_document_format,
)


def test_document_mime_mapping_covers_every_document_format():
    """Drift guard: a format added to DocumentFormat without a mapping here would
    silently store as application/octet-stream and degrade to text on retrieval."""
    assert set(_DOCUMENT_FORMAT_TO_MIME) == set(get_args(DocumentFormat))


def test_every_stored_document_mime_has_a_file_extension():
    """Every MIME type the offloader can write must map to a shell-friendly extension."""
    for mime in _DOCUMENT_FORMAT_TO_MIME.values():
        assert mime in _MIME_TO_EXTENSION, f"missing extension for {mime}"


def test_document_round_trip_is_identity_except_txt():
    """format -> MIME -> format is the identity for every format except txt,
    which intentionally retrieves as plain text."""
    for fmt in get_args(DocumentFormat):
        mime = _mime_for_document_format(fmt)
        recovered = _document_format_for_mime(mime)
        if fmt == "txt":
            assert recovered is None
        else:
            assert recovered == fmt


def test_legacy_application_types_reconstruct_every_format():
    """Artifacts written by earlier releases (application/{format}) keep reconstructing."""
    for fmt in get_args(DocumentFormat):
        assert _document_format_for_mime(f"application/{fmt}") == fmt

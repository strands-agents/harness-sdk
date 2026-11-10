"""Structural checks that a file really is the image or document ``read`` is about to send as media.

A media block the provider cannot decode fails the request, and because the tool result stays in history, every
later request too. These checks catch truncated, corrupt, empty, and mislabeled files without decoding anything.
They reject a file only on positive evidence that it is broken, and are tuned to what Bedrock accepts: a JPEG cut
off mid-scan, a GIF without its trailer, or a PDF without ``%%EOF`` still renders there, so each passes here.
"""

from __future__ import annotations

import functools
import logging
import re
import struct
import zlib
from collections.abc import Callable

logger = logging.getLogger(__name__)

_TRUNCATED = "it is truncated"
_NO_IMAGE_DATA = "it has no image data"
# A marker that ends a JPEG scan's entropy-coded data: 0xFF not followed by a stuffed zero, a restart, or fill.
_JPEG_MARKER = re.compile(rb"\xff[^\x00\xd0-\xd7\xff]")
_JPEG_PROGRESSIVE = (0xC2, 0xC6, 0xCA, 0xCE)
# An object header (``12 0 obj``), with whitespace as PDF defines it.
_PDF_OBJECT = re.compile(rb"\d+[\0\t\n\f\r ]+\d+[\0\t\n\f\r ]+obj\b")
_OLE_SIGNATURE = bytes.fromhex("d0cf11e0a1b11ae1")
# OLE2 FAT values at or above this mark a free sector or the end of a chain rather than a next sector.
_OLE_SPECIAL = 0xFFFFFFFA
# Zip fields saturated to this defer to a zip64 record, which these checks do not read.
_ZIP64 = 0xFFFFFFFF
_ZIP_CORRUPT = "its zip archive is corrupt or truncated"
# The part (OOXML) and root stream names (OLE2) that mark each Office family.
_OOXML_PARTS = {"Word": "word/", "Excel": "xl/"}
_OLE_STREAMS = {"Word": ("WordDocument",), "Excel": ("Workbook", "WORKBOOK", "Book")}
_FAMILY_NAMES = {"Word": "a Word document", "Excel": "an Excel workbook"}


def media_problem(media_format: str, data: bytes) -> str | None:
    """Why ``data`` is not a usable ``media_format`` file, or ``None`` if it is.

    An image's signature must already match ``media_format``. A check that fails unexpectedly passes the file, so
    a gap in these checks never blocks a file that worked before them.
    """
    try:
        return _CHECKS[media_format](data)
    except Exception:
        logger.warning(
            "media_format=<%s> | media validation failed, sending the file unchecked", media_format, exc_info=True
        )
        return None


def _png_problem(data: bytes) -> str | None:
    pos, has_data = 8, False
    while pos + 12 <= len(data):
        length, kind = struct.unpack_from(">I4s", data, pos)
        end = pos + 12 + length
        if end > len(data):
            return _TRUNCATED
        if pos == 8 and (kind != b"IHDR" or length != 13):
            return "its IHDR header is malformed"
        # Like libpng, only a critical chunk (uppercase first letter) must carry a matching checksum.
        if not kind[0] & 0x20 and zlib.crc32(data[pos + 4 : end - 4]) != struct.unpack_from(">I", data, end - 4)[0]:
            return "a chunk checksum does not match"
        has_data |= kind == b"IDAT"
        if kind == b"IEND":
            return None if has_data else _NO_IMAGE_DATA
        pos = end
    return _TRUNCATED


def _jpeg_problem(data: bytes) -> str | None:
    # Decoders render a baseline JPEG cut off inside its scan, and a progressive one cut after its first scan.
    pos, frame, has_scan = 2, None, False
    while pos + 4 <= len(data):
        if data[pos] != 0xFF:
            return "its marker segments are malformed"
        marker = data[pos + 1]
        if marker == 0xFF:  # fill byte
            pos += 1
            continue
        if marker == 0x01 or 0xD0 <= marker <= 0xD8:  # standalone markers carry no length
            pos += 2
            continue
        if marker == 0xD9:
            break
        end = pos + 2 + struct.unpack_from(">H", data, pos + 2)[0]
        if end > len(data):
            return _TRUNCATED
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            frame = marker
        if marker == 0xDA:
            scan_end = _JPEG_MARKER.search(data, end)
            whole = scan_end is not None or frame not in _JPEG_PROGRESSIVE
            has_scan |= frame is not None and end < len(data) and whole
            end = scan_end.start() if scan_end else len(data)
        pos = end
    return None if has_scan else _NO_IMAGE_DATA


def _gif_problem(data: bytes) -> str | None:
    if len(data) < 13:
        return _TRUNCATED
    pos, images = 13 + _gif_color_table(data[10]), 0
    # A missing trailer is fine, and so is a cut after the first frame: decoders show the frames before it.
    while pos < len(data) and data[pos] != 0x3B:
        if data[pos] == 0x21:
            end = _gif_skip_sub_blocks(data, pos + 2)
        elif data[pos] == 0x2C:
            end = _gif_image_end(data, pos)
        else:
            return "its block structure is malformed"
        if end is None:
            return None if images else _TRUNCATED
        images += data[pos] == 0x2C
        pos = end
    return None if images else _NO_IMAGE_DATA


def _gif_image_end(data: bytes, pos: int) -> int | None:
    if pos + 10 > len(data):
        return None
    return _gif_skip_sub_blocks(data, pos + 11 + _gif_color_table(data[pos + 9]))


def _gif_color_table(flags: int) -> int:
    return 3 << ((flags & 7) + 1) if flags & 0x80 else 0


def _gif_skip_sub_blocks(data: bytes, pos: int) -> int | None:
    while pos < len(data):
        size = data[pos]
        pos += 1 + size
        if size == 0:
            return pos
    return None


def _webp_problem(data: bytes) -> str | None:
    end = min(len(data), struct.unpack_from("<I", data, 4)[0] + 8)
    pos, has_image = 12, False
    while pos + 8 <= end:
        kind, size = struct.unpack_from("<4sI", data, pos)
        if pos + 8 + size > len(data):
            # Like a GIF, an animation cut after its first complete frame still shows.
            return None if has_image else _TRUNCATED
        has_image |= kind in (b"VP8 ", b"VP8L", b"ANMF")
        pos += 8 + size + (size & 1)
    return None if has_image else _NO_IMAGE_DATA


def _pdf_problem(data: bytes) -> str | None:
    # Readers allow junk before the header and after the trailer. A truncated PDF loses its final trailer; a
    # linearized one still has its first-page trailer near the start, so no object may follow the last trailer.
    start = data.find(b"%PDF-", 0, 1024)
    if start < 0:
        return "it has no %PDF- header"
    trailer = data.rfind(b"startxref")
    if trailer > start and not _PDF_OBJECT.search(data, trailer):
        return None
    return "it does not end with a cross-reference trailer, so it is likely truncated"


def _office_problem(data: bytes, family: str) -> str | None:
    # The container does not have to match the extension (a docx named .doc renders), only the family.
    if data.startswith(b"PK\x03\x04"):
        return _ooxml_problem(data, family)
    if data.startswith(_OLE_SIGNATURE):
        return _ole_problem(data, family)
    return f"it is not {_FAMILY_NAMES[family]}"


def _ooxml_problem(data: bytes, family: str) -> str | None:
    # The end-of-central-directory record sits in the last 22 bytes plus an archive comment of up to 64 KiB.
    eocd = data.rfind(b"PK\x05\x06", max(0, len(data) - 65557))
    if eocd < 0 or eocd + 22 > len(data):
        return _ZIP_CORRUPT
    count, _, offset = struct.unpack_from("<HII", data, eocd + 10)
    if offset == _ZIP64:
        return None
    names = _zip_names(data, offset, count)
    if names is None:
        return _ZIP_CORRUPT
    if "[Content_Types].xml" not in names:
        return "it is a zip archive, not an Office document"
    if any(name.startswith(_OOXML_PARTS[family]) for name in names):
        return None
    return f"it is not {_FAMILY_NAMES[family]}"


def _zip_names(data: bytes, pos: int, count: int) -> list[str] | None:
    """The names of the ``count`` central-directory entries at ``pos``, or ``None`` if one lies outside ``data``."""
    names = []
    for _ in range(count):
        if data[pos : pos + 4] != b"PK\x01\x02" or pos + 46 > len(data):
            return None
        compressed, _, name_length, extra_length, comment_length = struct.unpack_from("<IIHHH", data, pos + 20)
        (local,) = struct.unpack_from("<I", data, pos + 42)
        if data[local : local + 4] != b"PK\x03\x04" or local + 30 > len(data):
            return None
        start = local + 30 + sum(struct.unpack_from("<HH", data, local + 26))
        if compressed != _ZIP64 and start + compressed > len(data):
            return None
        names.append(data[pos + 46 : pos + 46 + name_length].decode("latin-1"))
        pos += 46 + name_length + extra_length + comment_length
    return names


def _ole_problem(data: bytes, family: str) -> str | None:
    if len(data) < 512:
        return _TRUNCATED
    (shift,) = struct.unpack_from("<H", data, 30)
    if shift not in (9, 12):
        return "its header is malformed"
    sector = 1 << shift
    sectors = -(-len(data) // sector) - 1
    fat_count, directory = struct.unpack_from("<II", data, 44)
    fat_sectors = struct.unpack_from("<109I", data, 76)[:fat_count]
    if any(s >= sectors for s in (*fat_sectors, directory)):
        return _TRUNCATED
    # A truncated file still has FAT chains pointing at sectors past its end.
    if any(_ole_fat_reaches(data[(s + 1) * sector : (s + 2) * sector], sectors) for s in fat_sectors):
        return _TRUNCATED
    if any(_ole_has_entry(data, name) for name in _OLE_STREAMS[family]):
        return None
    return f"it is not {_FAMILY_NAMES[family]}"


def _ole_fat_reaches(fat: bytes, sectors: int) -> bool:
    """Whether a FAT sector chains to a sector at or past ``sectors``."""
    return any(
        sectors <= following < _OLE_SPECIAL for (following,) in struct.iter_unpack("<I", fat[: len(fat) // 4 * 4])
    )


def _ole_has_entry(data: bytes, name: str) -> bool:
    """Whether a directory entry named exactly ``name`` exists, at any depth."""
    # Directory entries are 128-byte aligned: a UTF-16 name, then its byte length (with terminator) at offset 64.
    encoded = name.encode("utf-16-le") + b"\x00\x00"
    pos = data.find(encoded)
    while pos >= 0:
        if pos % 128 == 0 and data[pos + 64 : pos + 66] == struct.pack("<H", len(encoded)):
            return True
        pos = data.find(encoded, pos + 1)
    return False


_CHECKS: dict[str, Callable[[bytes], str | None]] = {
    "png": _png_problem,
    "jpeg": _jpeg_problem,
    "gif": _gif_problem,
    "webp": _webp_problem,
    "pdf": _pdf_problem,
    "doc": functools.partial(_office_problem, family="Word"),
    "docx": functools.partial(_office_problem, family="Word"),
    "xls": functools.partial(_office_problem, family="Excel"),
    "xlsx": functools.partial(_office_problem, family="Excel"),
}

"""Structural checks that a file really is the image or document its extension claims.

A malformed media block makes Bedrock reject the request, and because the tool result stays in history,
every later request too. These checks catch truncated, corrupt, empty, and mislabeled files without a
decoding dependency, and are tuned to what Bedrock accepts: e.g. a JPEG missing its end marker or a PDF
missing ``%%EOF`` still renders there, so they pass here. Each returns ``None`` for a usable file, else why not.
"""

from __future__ import annotations

import io
import struct
import zipfile
import zlib

_TRUNCATED = "it is truncated"
_OLE_SIGNATURE = bytes.fromhex("d0cf11e0a1b11ae1")
_OLE_FREE, _OLE_SPECIAL = 0xFFFFFFFF, 0xFFFFFFFA
_DOCUMENT_FAMILY = {"doc": "Word", "docx": "Word", "xls": "Excel", "xlsx": "Excel"}


def image_problem(data: bytes, image_format: str) -> str | None:
    """Why ``data`` (whose signature already matched ``image_format``) is not a usable image, if it is not."""
    return {"png": _png_problem, "jpeg": _jpeg_problem, "gif": _gif_problem, "webp": _webp_problem}[image_format](data)


def document_problem(data: bytes, document_format: str) -> str | None:
    """Why ``data`` is not a usable ``document_format`` document, if it is not."""
    if document_format == "pdf":
        return _pdf_problem(data)
    if data.startswith(b"PK\x03\x04"):
        family, problem = _ooxml_family(data)
    elif data.startswith(_OLE_SIGNATURE):
        family, problem = _ole_family(data)
    else:
        return "it is not a Word or Excel file"
    if problem is None and family != _DOCUMENT_FAMILY[document_format]:
        problem = f"it is {'an' if family == 'Excel' else 'a'} {family} file" if family else "it is not Word or Excel"
    return problem


def _png_problem(data: bytes) -> str | None:
    pos, inflater, inflated, expected = 8, zlib.decompressobj(), 0, 0
    while pos + 12 <= len(data):
        (length,) = struct.unpack_from(">I", data, pos)
        kind, body = data[pos + 4 : pos + 8], data[pos + 8 : pos + 8 + length]
        if pos + 12 + length > len(data):
            return _TRUNCATED
        if pos == 8:
            expected = _png_pixel_bytes(body) if kind == b"IHDR" and length == 13 else None
            if expected is None:
                return "its IHDR header is malformed"
        # Bedrock tolerates a bad checksum on an ancillary chunk (lowercase first letter), like libpng.
        if not kind[0] & 0x20 and zlib.crc32(kind + body) != struct.unpack_from(">I", data, pos + 8 + length)[0]:
            return "a chunk checksum does not match"
        try:
            while kind == b"IDAT" and not inflater.eof:
                out = inflater.decompress(body, 1 << 20)
                inflated, body = inflated + len(out), inflater.unconsumed_tail
                if not body and len(out) < 1 << 20:
                    break
        except zlib.error:
            return "its image data is corrupt"
        if kind == b"IEND":
            return None if inflater.eof and inflated >= expected else "its image data is incomplete"
        pos += 12 + length
    return _TRUNCATED


def _png_pixel_bytes(ihdr: bytes) -> int | None:
    width, height, depth, color_type, _, _, interlace = struct.unpack(">IIBBBBB", ihdr)
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color_type)
    if channels is None or not width or not height:
        return None
    passes = ((0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2))
    total = 0
    for x0, y0, dx, dy in passes if interlace else ((0, 0, 1, 1),):
        columns, rows = -(-(width - x0) // dx), -(-(height - y0) // dy)
        if columns > 0 and rows > 0:
            total += rows * (1 + (columns * channels * depth + 7) // 8)
    return total


def _jpeg_problem(data: bytes) -> str | None:
    # Bedrock decodes a JPEG cut off mid-scan, so only the headers up to the first scan must be intact.
    pos, has_frame = 2, False
    while pos + 4 <= len(data):
        if data[pos] != 0xFF:
            return "its marker segments are malformed"
        marker = data[pos + 1]
        if marker == 0xFF or marker == 0x01 or 0xD0 <= marker <= 0xD8:
            pos += 1 if marker == 0xFF else 2
            continue
        if marker == 0xD9:
            break
        end = pos + 2 + struct.unpack_from(">H", data, pos + 2)[0]
        if end > len(data):
            return _TRUNCATED
        has_frame |= 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC)
        if marker == 0xDA:
            return None if has_frame and end < len(data) else "it has no image data"
        pos = end
    return "it has no image data"


def _gif_problem(data: bytes) -> str | None:
    def skip_sub_blocks(pos: int) -> int | None:
        while pos < len(data):
            size = data[pos]
            pos += 1 + size
            if size == 0:
                return pos
        return None

    if len(data) < 13:
        return _TRUNCATED
    pos: int | None = 13 + (3 << ((data[10] & 7) + 1) if data[10] & 0x80 else 0)
    images = 0
    # A missing trailer is fine (Bedrock accepts it); running out of data inside a block is not.
    while pos is not None and pos < len(data) and data[pos] != 0x3B:
        if data[pos] == 0x21:
            pos = skip_sub_blocks(pos + 2)
        elif data[pos] == 0x2C and pos + 10 <= len(data):
            flags = data[pos + 9]
            pos = skip_sub_blocks(pos + 11 + (3 << ((flags & 7) + 1) if flags & 0x80 else 0))
            images += 1
        elif data[pos] == 0x2C:
            pos = None
        else:
            return "its block structure is malformed"
    if pos is None:
        return _TRUNCATED
    return None if images else "it has no image data"


def _webp_problem(data: bytes) -> str | None:
    end = min(len(data), struct.unpack_from("<I", data, 4)[0] + 8)
    pos, has_image = 12, False
    while pos + 8 <= end:
        kind, (size,) = data[pos : pos + 4], struct.unpack_from("<I", data, pos + 4)
        if pos + 8 + size > len(data):
            return _TRUNCATED
        has_image |= kind in (b"VP8 ", b"VP8L", b"ANMF")
        pos += 8 + size + (size & 1)
    return None if has_image else "it has no image data"


def _pdf_problem(data: bytes) -> str | None:
    # Readers allow junk before the header and after the trailer; a truncated PDF loses its trailer.
    start = data.find(b"%PDF-", 0, 1024)
    if start < 0:
        return "it has no %PDF- header"
    return (
        None if data.find(b"startxref", start) >= 0 else "it has no cross-reference trailer, so it is likely truncated"
    )


def _ooxml_family(data: bytes) -> tuple[str | None, str | None]:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = archive.namelist()
            if archive.testzip() is not None:
                return None, "an archive entry is corrupt"
    except (zipfile.BadZipFile, zlib.error, EOFError, NotImplementedError, RuntimeError):
        return None, "its zip structure is corrupt or truncated"
    if "[Content_Types].xml" not in names:
        return None, "it is a zip archive, not an Office document"
    if any(name.startswith("word/") for name in names):
        return "Word", None
    return ("Excel", None) if any(name.startswith("xl/") for name in names) else (None, None)


def _ole_family(data: bytes) -> tuple[str | None, str | None]:
    if len(data) < 512:
        return None, _TRUNCATED
    sector = 1 << struct.unpack_from("<H", data, 30)[0]
    if sector not in (512, 4096):
        return None, "its header is malformed"
    sectors = -(-len(data) // sector) - 1
    fat_count = struct.unpack_from("<I", data, 44)[0]
    fat_sectors = struct.unpack_from("<109I", data, 76)[:fat_count]
    if any(s >= sectors for s in fat_sectors):
        return None, _TRUNCATED
    # A truncated file still has FAT entries for (or pointing at) sectors past its end.
    fat = b"".join(data[(s + 1) * sector : (s + 2) * sector] for s in fat_sectors)
    for index, (following,) in enumerate(struct.iter_unpack("<I", fat[: len(fat) // 4 * 4])):
        if following != _OLE_FREE and (index >= sectors or sectors <= following < _OLE_SPECIAL):
            return None, _TRUNCATED
    if "WordDocument".encode("utf-16-le") in data:
        return "Word", None
    if "Workbook".encode("utf-16-le") in data or "Book".encode("utf-16-le") in data:
        return "Excel", None
    return None, None

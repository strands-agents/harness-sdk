"""Minimal, structurally valid media files for the ``read`` media checks.

``harness-ts/test/tools/media-fixtures.ts`` builds the same bytes, so both SDKs are tested on identical files.
"""

import base64
import struct
import zlib


def png_chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))


def png(before_idat: bytes = b"") -> bytes:
    """A 1x1 RGB PNG."""
    ihdr = png_chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
    idat = png_chunk(b"IDAT", zlib.compress(bytes(4)))
    return b"\x89PNG\r\n\x1a\n" + ihdr + before_idat + idat + png_chunk(b"IEND", b"")


PNG = png()
# The IDAT chunk's type field.
PNG_IDAT = PNG.index(b"IDAT")


def jpeg(sof: int = 0xC0, scans: int = 1) -> bytes:
    """A 1x1 grayscale JPEG with ``scans`` scans under the ``sof`` frame marker."""
    jfif = b"\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    frame = bytes([0xFF, sof]) + b"\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00"
    scan = b"\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00" + b"\xd2\xcf\x20\xff\x00\x14"
    return b"\xff\xd8" + jfif + frame + scan * scans + b"\xff\xd9"


JPEG = jpeg()
PROGRESSIVE_JPEG = jpeg(sof=0xC2, scans=2)

_GIF_1X1 = base64.b64decode("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==")
# Header and global color table, then a graphic control extension, then one image, then the trailer.
_GIF_HEADER, _GIF_FRAME = _GIF_1X1[:19], _GIF_1X1[19:-1]


def gif(frames: int = 1) -> bytes:
    return _GIF_HEADER + _GIF_FRAME * frames + b";"


GIF = gif()
ANIMATED_GIF = gif(frames=2)
_VP8L = base64.b64decode("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==")[12:]


def riff(*chunks: bytes) -> bytes:
    body = b"WEBP" + b"".join(chunks)
    return b"RIFF" + struct.pack("<I", len(body)) + body


def webp_chunk(kind: bytes, body: bytes) -> bytes:
    return kind + struct.pack("<I", len(body)) + body + b"\x00" * (len(body) & 1)


WEBP = riff(_VP8L)
_ANMF = webp_chunk(b"ANMF", bytes(16) + _VP8L)
ANIMATED_WEBP = riff(webp_chunk(b"VP8X", b"\x02" + bytes(9)), webp_chunk(b"ANIM", bytes(6)), _ANMF, _ANMF)


def pdf(*objects: bytes) -> bytes:
    """A one-revision PDF with an exact cross-reference table."""
    out, offsets = b"%PDF-1.4\n", []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref, size = len(out), len(objects) + 1
    out += b"xref\n0 %d\n0000000000 65535 f \n" % size + b"".join(b"%010d 00000 n \n" % o for o in offsets)
    return out + b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (size, xref)


PDF = pdf(
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
)
# A linearized PDF cut off after its first-page trailer.
PDF_LINEARIZED_CUT = (
    b"%PDF-1.7\n1 0 obj\n<< /Linearized 1 >>\nendobj\ntrailer\n<< /Root 2 0 R >>\nstartxref\n0\n%%EOF\n"
    b"2 0 obj\n<< /Type /Catalog"
)


def zip_archive(*names: str) -> bytes:
    """A stored (uncompressed) zip archive with one small entry per name."""
    local, central, body = b"", b"", b"<x/>"
    for name in names:
        encoded = name.encode()
        fields = struct.pack("<HHHHHIIIHH", 20, 0, 0, 0, 0, zlib.crc32(body), len(body), len(body), len(encoded), 0)
        central += (
            b"PK\x01\x02" + struct.pack("<H", 20) + fields + struct.pack("<HHHII", 0, 0, 0, 0, len(local)) + encoded
        )
        local += b"PK\x03\x04" + fields + encoded + body
    end = struct.pack("<HHHHIIH", 0, 0, len(names), len(names), len(central), len(local), 0)
    return local + central + b"PK\x05\x06" + end


DOCX = zip_archive("[Content_Types].xml", "word/document.xml")
XLSX = zip_archive("[Content_Types].xml", "xl/workbook.xml")
_NOSTREAM = 0xFFFFFFFF


def ole_entry(name: str, kind: int = 2, child: int = _NOSTREAM, right: int = _NOSTREAM) -> bytes:
    encoded = name.encode("utf-16-le") + b"\x00\x00"
    return (
        encoded.ljust(64, b"\x00") + struct.pack("<HBBIII", len(encoded), kind, 1, _NOSTREAM, right, child) + bytes(48)
    )


def ole(*streams: str, directory_next: int = 0xFFFFFFFE) -> bytes:
    """A compound file: a header, one FAT sector, then one directory sector of a root and its ``streams``."""
    entries = [ole_entry("Root Entry", 5, child=1)]
    entries += [ole_entry(name, right=i + 2 if i + 1 < len(streams) else _NOSTREAM) for i, name in enumerate(streams)]
    header = bytearray(512)
    header[:8] = bytes.fromhex("d0cf11e0a1b11ae1")
    struct.pack_into("<H", header, 30, 9)
    struct.pack_into("<II", header, 44, 1, 1)
    struct.pack_into("<109I", header, 76, 0, *[_NOSTREAM] * 108)
    fat = struct.pack("<3I", 0xFFFFFFFD, directory_next, _NOSTREAM).ljust(512, b"\xff")
    return bytes(header) + fat + b"".join(entries).ljust(512, b"\x00")


DOC, XLS = ole("WordDocument"), ole("Workbook")
HTML = b"<!DOCTYPE html>\n<html><title>404 Not Found</title>\n<h1>Not Found</h1></html>\n"

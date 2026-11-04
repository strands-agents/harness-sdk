import base64
import io
import struct
import zipfile
import zlib

import pytest

from strands_harness import create_harness
from strands_harness.tools import edit, make_read, read, write


class _Ctx:
    def __init__(self, agent):
        self.agent = agent
        self.tool_use = {"toolUseId": "t1"}


def _png_chunk(kind, body):
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))


def _png(pixels=bytes(14), interlace=0, before_idat=b""):
    """A 2x2 RGB PNG; 14 pixel bytes when not interlaced, 15 when Adam7-interlaced."""
    ihdr = _png_chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, interlace))
    idat = _png_chunk(b"IDAT", zlib.compress(pixels))
    return b"\x89PNG\r\n\x1a\n" + ihdr + before_idat + idat + _png_chunk(b"IEND", b"")


_PNG = _png()
_JPEG = (
    b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    b"\xff\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00\xd2\xcf\x20\xff\xd9"
)
_GIF = base64.b64decode("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==")
_WEBP = base64.b64decode("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==")
_PDF = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\nstartxref\n9\n%%EOF\n"
_HTML = b"<!DOCTYPE html>\n<html><title>404 Not Found</title>\n<h1>Not Found</h1></html>\n"


def _ooxml(part, content_types=True):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        if content_types:
            archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr(part, "<document>" + "x" * 200 + "</document>")
    return buffer.getvalue()


def _ole(stream):
    """A minimal compound file: header, one FAT sector, one directory sector naming ``stream``."""
    header = bytearray(512)
    header[:8] = bytes.fromhex("d0cf11e0a1b11ae1")
    struct.pack_into("<HxxxxxxxxxxxxII", header, 30, 9, 1, 1)
    struct.pack_into("<109I", header, 76, 0, *[0xFFFFFFFF] * 108)
    fat = struct.pack("<128I", 0xFFFFFFFD, 0xFFFFFFFE, *[0xFFFFFFFF] * 126)
    return bytes(header) + fat + stream.encode("utf-16-le").ljust(512, b"\x00")


_DOCX, _XLSX = _ooxml("word/document.xml"), _ooxml("xl/workbook.xml")
_DOC, _XLS = _ole("WordDocument"), _ole("Workbook")


@pytest.fixture
def ctx():
    return _Ctx(create_harness(skills=False))


async def test_write_then_read(ctx, tmp_path):
    path = str(tmp_path / "f.txt")
    await write._tool_func(path=path, content="alpha\nbeta\n", tool_context=ctx)
    out = await read._tool_func(path=path, tool_context=ctx)
    assert "     1\talpha" in out
    assert "     2\tbeta" in out


async def test_read_offset_and_limit(ctx, tmp_path):
    path = str(tmp_path / "f.txt")
    await write._tool_func(path=path, content="\n".join(f"line{i}" for i in range(1, 11)), tool_context=ctx)
    out = await read._tool_func(path=path, offset=3, limit=2, tool_context=ctx)
    assert "     3\tline3" in out
    assert "     4\tline4" in out
    assert "line5" not in out
    assert "Showing lines 3-4 of 10" in out


async def test_edit_replaces_unique_occurrence(ctx, tmp_path):
    path = str(tmp_path / "f.txt")
    await write._tool_func(path=path, content="one\ntwo\nthree\n", tool_context=ctx)
    await edit._tool_func(path=path, old_str="two", new_str="TWO", tool_context=ctx)
    out = await read._tool_func(path=path, tool_context=ctx)
    assert "     2\tTWO" in out


async def test_edit_requires_verbatim_match(ctx, tmp_path):
    path = str(tmp_path / "f.txt")
    await write._tool_func(path=path, content="hello\n", tool_context=ctx)
    with pytest.raises(ValueError, match="did not appear verbatim"):
        await edit._tool_func(path=path, old_str="missing", new_str="x", tool_context=ctx)


async def test_edit_requires_unique_match(ctx, tmp_path):
    path = str(tmp_path / "f.txt")
    await write._tool_func(path=path, content="dup\ndup\n", tool_context=ctx)
    with pytest.raises(ValueError, match="appears 2 times"):
        await edit._tool_func(path=path, old_str="dup", new_str="x", tool_context=ctx)


async def test_relative_path_rejected(ctx):
    with pytest.raises(ValueError, match="not absolute"):
        await read._tool_func(path="relative/path", tool_context=ctx)


async def test_path_traversal_rejected(ctx):
    with pytest.raises(ValueError, match="path traversal"):
        await read._tool_func(path="/tmp/../etc/passwd", tool_context=ctx)


async def test_windows_drive_letter_path_is_absolute():
    written = []

    class _Sandbox:
        async def write_text(self, path, content):
            written.append(path)

    class _Agent:
        sandbox = _Sandbox()

    win_ctx = _Ctx(_Agent())
    await write._tool_func(path="C:\\Users\\me\\novel.json", content="{}", tool_context=win_ctx)
    await write._tool_func(path="C:/Users/me/novel.json", content="{}", tool_context=win_ctx)
    await write._tool_func(path="\\\\server\\share\\novel.json", content="{}", tool_context=win_ctx)
    assert written == ["C:\\Users\\me\\novel.json", "C:/Users/me/novel.json", "\\\\server\\share\\novel.json"]
    # Drive-relative (``C:foo``) is not absolute on either platform.
    with pytest.raises(ValueError, match="not absolute"):
        await write._tool_func(path="C:novel.json", content="", tool_context=win_ctx)
    with pytest.raises(ValueError, match="path traversal"):
        await write._tool_func(path="C:\\Users\\..\\secret", content="", tool_context=win_ctx)


async def test_read_image_returns_image_content(ctx, tmp_path):
    path = tmp_path / "pic.png"
    path.write_bytes(_PNG)
    result = await read._tool_func(path=str(path), tool_context=ctx)
    assert result["status"] == "success"
    image = result["content"][0]["image"]
    assert image["format"] == "png"
    assert image["source"]["bytes"] == _PNG


async def test_read_jpg_maps_to_jpeg(ctx, tmp_path):
    path = tmp_path / "photo.JPG"
    path.write_bytes(_JPEG)
    result = await read._tool_func(path=str(path), tool_context=ctx)
    assert result["content"][0]["image"]["format"] == "jpeg"


@pytest.mark.parametrize(
    ("name", "data", "expected"),
    [
        ("a.gif", _GIF, "gif"),
        ("a.gif", b"GIF87a" + _GIF[6:], "gif"),
        ("a.webp", _WEBP, "webp"),
        ("photo.jpg", _PNG, "png"),
        ("shot.png", _JPEG, "jpeg"),
    ],
)
async def test_read_image_format_follows_the_bytes_not_the_extension(ctx, tmp_path, name, data, expected):
    path = tmp_path / name
    path.write_bytes(data)
    result = await read._tool_func(path=str(path), tool_context=ctx)
    assert result["content"][0]["image"]["format"] == expected


@pytest.mark.parametrize(
    "data", [b"", b"\x89PNG\r\n\x1aXtruncated signature", b"RIFF\x00\x00\x00\x00WAVE", b"\x00\x01binary\xfe"]
)
async def test_read_rejects_non_image_bytes_under_an_image_extension(ctx, tmp_path, data):
    path = tmp_path / "notes.png"
    path.write_bytes(data)
    with pytest.raises(ValueError, match=rf"\.png extension but its {len(data)} bytes are not"):
        await read._tool_func(path=str(path), tool_context=ctx)
    with pytest.raises(ValueError, match=rf"\.png extension but its {len(data)} bytes are not"):
        await make_read(media=False)._tool_func(path=str(path), tool_context=ctx)


async def test_read_surfaces_a_non_image_as_an_error_tool_result(ctx, tmp_path):
    # A rejected file must reach history as a text error result, not a success image block.
    path = tmp_path / "notes.png"
    path.write_bytes(b"\xfe\xfe not text, not an image")
    tool_use = {"toolUseId": "t1", "name": "read", "input": {"path": str(path)}}
    events = [e async for e in read.stream(tool_use, {"agent": ctx.agent})]
    result = events[-1].tool_result
    assert result["status"] == "error"
    assert [next(iter(c)) for c in result["content"]] == ["text"]
    assert "25 bytes are not a png, jpeg, gif, or webp image" in result["content"][0]["text"]


async def test_read_pdf_returns_document_content(ctx, tmp_path):
    path = tmp_path / "my report_v2.pdf"
    path.write_bytes(_PDF)
    result = await read._tool_func(path=str(path), tool_context=ctx)
    document = result["content"][0]["document"]
    assert document["format"] == "pdf"
    assert document["name"] == "my report v2 pdf"
    assert document["source"]["bytes"] == _PDF


async def test_read_text_document_format_stays_numbered_text(ctx, tmp_path):
    path = tmp_path / "data.csv"
    path.write_text("a,b\n1,2\n")
    out = await read._tool_func(path=str(path), tool_context=ctx)
    assert "     1\ta,b" in out


async def test_read_returns_media_for_a_capable_model(ctx, tmp_path):
    path = tmp_path / "shot.png"
    path.write_bytes(_PNG)
    out = await read._tool_func(path=str(path), tool_context=ctx)
    assert out["content"] == [{"image": {"format": "png", "source": {"bytes": _PNG}}}]


async def test_read_describes_an_image_when_media_is_off(ctx, tmp_path):
    path = tmp_path / "shot.png"
    path.write_bytes(_PNG)
    out = await make_read(media=False)._tool_func(path=str(path), tool_context=ctx)
    assert isinstance(out, str)
    assert str(path) in out
    assert "png" in out
    assert f"{len(_PNG)} bytes" in out


async def test_read_describes_a_document_when_media_is_off(ctx, tmp_path):
    path = tmp_path / "spec.pdf"
    path.write_bytes(_PDF)
    out = await make_read(media=False)._tool_func(path=str(path), tool_context=ctx)
    assert isinstance(out, str)
    assert "pdf" in out
    assert "cannot view" in out


async def test_media_off_leaves_text_reads_untouched(ctx, tmp_path):
    path = str(tmp_path / "f.txt")
    await write._tool_func(path=path, content="alpha\nbeta\n", tool_context=ctx)
    out = await make_read(media=False)._tool_func(path=path, tool_context=ctx)
    assert "     1\talpha" in out


_PNG_IDAT = _PNG.index(b"IDAT") + 4
_DOCX_PART = _DOCX.index(b"word/document.xml") + len("word/document.xml")


@pytest.mark.parametrize(
    ("name", "data"),
    [
        ("pic.png", _PNG[: len(_PNG) // 2]),
        ("pic.png", _PNG[:-12]),
        ("pic.png", _PNG[:_PNG_IDAT] + bytes([_PNG[_PNG_IDAT] ^ 0xFF]) + _PNG[_PNG_IDAT + 1 :]),
        ("pic.png", _png(pixels=bytes(7))),
        ("pic.png", _png(pixels=bytes(14), interlace=1)),
        ("pic.png", _PNG[: _PNG_IDAT - 8] + _png_chunk(b"IDAT", b"not deflate") + _png_chunk(b"IEND", b"")),
        ("pic.jpg", _JPEG[: _JPEG.index(b"\xff\xda")]),
        ("pic.gif", _GIF[:30]),
        ("pic.gif", _GIF[:19]),
        ("pic.webp", _WEBP[:24]),
        ("report.pdf", b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog >>\n"),
        ("report.docx", _DOCX[: len(_DOCX) // 2]),
        (
            "report.docx",
            _DOCX[:_DOCX_PART]
            + bytes(b ^ 0x55 for b in _DOCX[_DOCX_PART : _DOCX_PART + 20])
            + _DOCX[_DOCX_PART + 20 :],
        ),
        ("report.docx", _ooxml("word/document.xml", content_types=False)),
        ("report.docx", _XLSX),
        ("report.xls", _DOC),
        ("report.doc", _DOC[:-512]),
    ],
)
async def test_read_rejects_a_truncated_corrupt_or_mislabeled_media_file(ctx, tmp_path, name, data):
    # Each of these fails the Bedrock request as a media block, and the history with it.
    path = tmp_path / name
    path.write_bytes(data)
    with pytest.raises(ValueError, match=rf"its {len(data)} bytes are not a valid \w+ (image|document): \w"):
        await read._tool_func(path=str(path), tool_context=ctx)
    with pytest.raises(ValueError, match="are not a valid"):
        await make_read(media=False)._tool_func(path=str(path), tool_context=ctx)


@pytest.mark.parametrize(
    ("name", "data", "kind"),
    [
        ("pic.png", _PNG + b"trailing junk", "image"),
        ("pic.png", _png(before_idat=struct.pack(">I", 2) + b"tEXt" + b"ab" + bytes(4)), "image"),
        ("pic.png", _png(pixels=bytes(15), interlace=1), "image"),
        ("pic.jpg", _JPEG[:-2], "image"),
        ("pic.gif", _GIF[:-1], "image"),
        ("pic.webp", _WEBP + b"trailing junk", "image"),
        ("report.pdf", b"junk\n" + _PDF[: _PDF.index(b"%%EOF")], "document"),
        ("report.docx", _DOCX, "document"),
        ("report.doc", _DOCX, "document"),
        ("report.xlsx", _XLSX, "document"),
        ("report.xls", _XLSX, "document"),
        ("report.doc", _DOC, "document"),
        ("report.xls", _XLS, "document"),
        ("report.docx", _DOC, "document"),
    ],
)
async def test_read_returns_media_that_bedrock_accepts(ctx, tmp_path, name, data, kind):
    # Imperfect but renderable files (as observed against Bedrock) stay media blocks.
    path = tmp_path / name
    path.write_bytes(data)
    result = await read._tool_func(path=str(path), tool_context=ctx)
    assert result["status"] == "success"
    assert result["content"][0][kind]["source"]["bytes"] == data


@pytest.mark.parametrize("media", [True, False])
async def test_read_shows_text_saved_under_a_media_extension_as_text(ctx, tmp_path, media):
    path = tmp_path / "report.pdf"
    path.write_bytes(_HTML)
    out = await make_read(media=media)._tool_func(path=str(path), tool_context=ctx)
    assert out.startswith(f"[{path} is not a valid pdf document: it has no %PDF- header. Showing it as text.]\n")
    assert "     3\t<h1>Not Found</h1></html>" in out
    paged = await read._tool_func(path=str(path), offset=2, limit=1, tool_context=ctx)
    assert "     2\t<html><title>404 Not Found</title>" in paged
    assert "[Showing lines 2-2 of 4." in paged


async def test_read_rejects_an_empty_media_file(ctx, tmp_path):
    path = tmp_path / "report.pdf"
    path.write_bytes(b"")
    with pytest.raises(ValueError, match="its 0 bytes are not a valid pdf document"):
        await read._tool_func(path=str(path), tool_context=ctx)


async def test_read_surfaces_an_invalid_document_as_an_error_tool_result(ctx, tmp_path):
    path = tmp_path / "report.pdf"
    path.write_bytes(b"%PDF-1.7\n\xe2\xe3\xcf\xd3 cut off")
    tool_use = {"toolUseId": "t1", "name": "read", "input": {"path": str(path)}}
    events = [e async for e in read.stream(tool_use, {"agent": ctx.agent})]
    result = events[-1].tool_result
    assert result["status"] == "error"
    assert [next(iter(c)) for c in result["content"]] == ["text"]
    assert "not a valid pdf document: it has no cross-reference trailer" in result["content"][0]["text"]

import pytest

from strands_harness import create_harness
from strands_harness.tools import edit, make_read, read, write


class _Ctx:
    def __init__(self, agent):
        self.agent = agent
        self.tool_use = {"toolUseId": "t1"}


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
    path.write_bytes(b"\x89PNG\r\n\x1a\nfake")
    result = await read._tool_func(path=str(path), tool_context=ctx)
    assert result["status"] == "success"
    image = result["content"][0]["image"]
    assert image["format"] == "png"
    assert image["source"]["bytes"] == b"\x89PNG\r\n\x1a\nfake"


async def test_read_jpg_maps_to_jpeg(ctx, tmp_path):
    path = tmp_path / "photo.JPG"
    path.write_bytes(b"\xff\xd8\xff\xe0fake")
    result = await read._tool_func(path=str(path), tool_context=ctx)
    assert result["content"][0]["image"]["format"] == "jpeg"


@pytest.mark.parametrize(
    ("name", "data", "expected"),
    [
        ("a.gif", b"GIF89a fake", "gif"),
        ("a.gif", b"GIF87a fake", "gif"),
        ("a.webp", b"RIFF\x00\x00\x00\x00WEBPVP8 fake", "webp"),
        ("photo.jpg", b"\x89PNG\r\n\x1a\nfake", "png"),
        ("shot.png", b"\xff\xd8\xff\xe0fake", "jpeg"),
    ],
)
async def test_read_image_format_follows_the_bytes_not_the_extension(ctx, tmp_path, name, data, expected):
    path = tmp_path / name
    path.write_bytes(data)
    result = await read._tool_func(path=str(path), tool_context=ctx)
    assert result["content"][0]["image"]["format"] == expected


@pytest.mark.parametrize(
    "data", [b"this is plain text\n", b"", b"\x89PNG\r\n\x1aXtruncated signature", b"RIFF\x00\x00\x00\x00WAVE"]
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
    path.write_bytes(b"this is plain text\n")
    tool_use = {"toolUseId": "t1", "name": "read", "input": {"path": str(path)}}
    events = [e async for e in read.stream(tool_use, {"agent": ctx.agent})]
    result = events[-1].tool_result
    assert result["status"] == "error"
    assert [next(iter(c)) for c in result["content"]] == ["text"]
    assert "19 bytes are not a png, jpeg, gif, or webp image" in result["content"][0]["text"]


async def test_read_pdf_returns_document_content(ctx, tmp_path):
    path = tmp_path / "my report_v2.pdf"
    path.write_bytes(b"%PDF-1.4 fake")
    result = await read._tool_func(path=str(path), tool_context=ctx)
    document = result["content"][0]["document"]
    assert document["format"] == "pdf"
    assert document["name"] == "my report v2 pdf"
    assert document["source"]["bytes"] == b"%PDF-1.4 fake"


async def test_read_text_document_format_stays_numbered_text(ctx, tmp_path):
    path = tmp_path / "data.csv"
    path.write_text("a,b\n1,2\n")
    out = await read._tool_func(path=str(path), tool_context=ctx)
    assert "     1\ta,b" in out


async def test_read_returns_media_for_a_capable_model(ctx, tmp_path):
    path = tmp_path / "shot.png"
    path.write_bytes(b"\x89PNG\r\n\x1a\nfake")
    out = await read._tool_func(path=str(path), tool_context=ctx)
    assert out["content"] == [{"image": {"format": "png", "source": {"bytes": b"\x89PNG\r\n\x1a\nfake"}}}]


async def test_read_describes_an_image_when_media_is_off(ctx, tmp_path):
    path = tmp_path / "shot.png"
    path.write_bytes(b"\x89PNG\r\n\x1a\nfake")
    out = await make_read(media=False)._tool_func(path=str(path), tool_context=ctx)
    assert isinstance(out, str)
    assert str(path) in out
    assert "png" in out
    assert "12 bytes" in out


async def test_read_describes_a_document_when_media_is_off(ctx, tmp_path):
    path = tmp_path / "spec.pdf"
    path.write_bytes(b"%PDF-1.7 fake")
    out = await make_read(media=False)._tool_func(path=str(path), tool_context=ctx)
    assert isinstance(out, str)
    assert "pdf" in out
    assert "cannot view" in out


async def test_media_off_leaves_text_reads_untouched(ctx, tmp_path):
    path = str(tmp_path / "f.txt")
    await write._tool_func(path=path, content="alpha\nbeta\n", tool_context=ctx)
    out = await make_read(media=False)._tool_func(path=path, tool_context=ctx)
    assert "     1\talpha" in out

"""Tests for the sandbox-routed ``read`` tool.

Exercised against a real ``NotASandboxLocalEnvironment`` (host filesystem) and
called directly like a normal async function. Errors surface as raised
``ValueError`` (the raw function raises; the error -> status wrapping only
happens through the tool's ``stream`` path). Path semantics assume POSIX, so
these are skipped on Windows except for the explicit cross-platform case.
"""

import sys
from types import SimpleNamespace

import pytest

from strands.sandbox.not_a_sandbox_local_environment import NotASandboxLocalEnvironment
from strands.types.tools import ToolContext
from strands.vended_tools.read import make_read, read

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX path semantics assumed")


def _tool_context(sandbox: NotASandboxLocalEnvironment | None = None) -> ToolContext:
    agent = SimpleNamespace(sandbox=sandbox or NotASandboxLocalEnvironment())
    return ToolContext(
        tool_use={"name": "read", "toolUseId": "test-id", "input": {}},
        agent=agent,
        invocation_state={},
    )


@pytest.fixture
def reader():
    return make_read(sandbox=NotASandboxLocalEnvironment())


@pytest.fixture
def reader_text_only():
    return make_read(media=False, sandbox=NotASandboxLocalEnvironment())


@pytest.fixture
def ctx():
    return _tool_context()


class TestReadText:
    @pytest.mark.asyncio
    async def test_returns_numbered_lines(self, reader, ctx, tmp_path):
        file_path = tmp_path / "f.txt"
        file_path.write_text("alpha\nbeta\n")
        out = await reader(path=str(file_path), tool_context=ctx)
        assert out == "     1\talpha\n     2\tbeta\n     3\t"

    @pytest.mark.asyncio
    async def test_offset_and_limit_page_through_file(self, reader, ctx, tmp_path):
        file_path = tmp_path / "f.txt"
        file_path.write_text("\n".join(f"line{index}" for index in range(1, 11)))
        out = await reader(path=str(file_path), offset=3, limit=2, tool_context=ctx)
        assert "     3\tline3" in out
        assert "     4\tline4" in out
        assert "line5" not in out
        assert "Showing lines 3-4 of 10" in out

    @pytest.mark.asyncio
    async def test_offset_past_end_returns_message(self, reader, ctx, tmp_path):
        file_path = tmp_path / "f.txt"
        file_path.write_text("one\ntwo\n")
        out = await reader(path=str(file_path), offset=100, tool_context=ctx)
        assert "offset 100 is past the end" in out


class TestReadImage:
    @pytest.mark.asyncio
    async def test_png_returns_image_content(self, reader, ctx, tmp_path):
        file_path = tmp_path / "pic.png"
        file_path.write_bytes(b"\x89PNG\r\n\x1a\nfake")
        result = await reader(path=str(file_path), tool_context=ctx)
        assert result == {
            "toolUseId": "test-id",
            "status": "success",
            "content": [{"image": {"format": "png", "source": {"bytes": b"\x89PNG\r\n\x1a\nfake"}}}],
        }

    @pytest.mark.asyncio
    async def test_jpg_extension_maps_to_jpeg_format(self, reader, ctx, tmp_path):
        file_path = tmp_path / "photo.JPG"
        file_path.write_bytes(b"\xff\xd8\xff\xe0fake")
        result = await reader(path=str(file_path), tool_context=ctx)
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
    @pytest.mark.asyncio
    async def test_format_follows_bytes_not_extension(self, reader, ctx, tmp_path, name, data, expected):
        file_path = tmp_path / name
        file_path.write_bytes(data)
        result = await reader(path=str(file_path), tool_context=ctx)
        assert result["content"][0]["image"]["format"] == expected

    @pytest.mark.parametrize(
        "data",
        [b"this is plain text\n", b"", b"\x89PNG\r\n\x1aXtruncated signature", b"RIFF\x00\x00\x00\x00WAVE"],
    )
    @pytest.mark.asyncio
    async def test_rejects_non_image_bytes_under_image_extension(self, reader, reader_text_only, ctx, tmp_path, data):
        file_path = tmp_path / "notes.png"
        file_path.write_bytes(data)
        with pytest.raises(ValueError, match=rf"\.png extension but its {len(data)} bytes are not"):
            await reader(path=str(file_path), tool_context=ctx)
        with pytest.raises(ValueError, match=rf"\.png extension but its {len(data)} bytes are not"):
            await reader_text_only(path=str(file_path), tool_context=ctx)

    @pytest.mark.asyncio
    async def test_rejected_non_image_surfaces_as_error_tool_result(self, reader, ctx, tmp_path):
        # A rejected file must reach history as a text error result, not a success image block.
        file_path = tmp_path / "notes.png"
        file_path.write_bytes(b"this is plain text\n")
        tool_use = {"toolUseId": "t1", "name": "read", "input": {"path": str(file_path)}}
        events = [event async for event in reader.stream(tool_use, {"agent": ctx.agent})]
        result = events[-1].tool_result
        assert result["status"] == "error"
        assert [next(iter(block)) for block in result["content"]] == ["text"]
        assert "19 bytes are not a png, jpeg, gif, or webp image" in result["content"][0]["text"]


class TestReadDocument:
    @pytest.mark.asyncio
    async def test_pdf_returns_document_content(self, reader, ctx, tmp_path):
        file_path = tmp_path / "my report_v2.pdf"
        file_path.write_bytes(b"%PDF-1.4 fake")
        result = await reader(path=str(file_path), tool_context=ctx)
        assert result == {
            "toolUseId": "test-id",
            "status": "success",
            "content": [
                {
                    "document": {
                        "format": "pdf",
                        "name": "my report v2 pdf",
                        "source": {"bytes": b"%PDF-1.4 fake"},
                    }
                }
            ],
        }

    @pytest.mark.asyncio
    async def test_text_representable_format_stays_numbered(self, reader, ctx, tmp_path):
        file_path = tmp_path / "data.csv"
        file_path.write_text("a,b\n1,2\n")
        out = await reader(path=str(file_path), tool_context=ctx)
        assert out == "     1\ta,b\n     2\t1,2\n     3\t"

    @pytest.mark.parametrize(
        ("name", "data"),
        [
            ("notes.pdf", b"this is plain text\n"),
            ("notes.pdf", b"PK\x03\x04fake"),  # zip bytes under a pdf extension
            ("sheet.xlsx", b"this is plain text\n"),  # expected zip
            ("sheet.xlsx", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1fake"),  # ole2 bytes under xlsx
            ("legacy.doc", b"PK\x03\x04fake"),  # zip bytes under legacy ole2 extension
        ],
    )
    @pytest.mark.asyncio
    async def test_rejects_mislabeled_document_bytes(self, reader, reader_text_only, ctx, tmp_path, name, data):
        file_path = tmp_path / name
        file_path.write_bytes(data)
        extension = name.rsplit(".", 1)[1]
        with pytest.raises(ValueError, match=rf"\.{extension} extension but its {len(data)} bytes are not a valid"):
            await reader(path=str(file_path), tool_context=ctx)
        with pytest.raises(ValueError, match=rf"\.{extension} extension but its {len(data)} bytes are not a valid"):
            await reader_text_only(path=str(file_path), tool_context=ctx)


class TestMediaOff:
    @pytest.mark.asyncio
    async def test_describes_an_image_as_text(self, reader_text_only, ctx, tmp_path):
        file_path = tmp_path / "shot.png"
        file_path.write_bytes(b"\x89PNG\r\n\x1a\nfake")
        out = await reader_text_only(path=str(file_path), tool_context=ctx)
        assert out == (
            f"[Image file: {file_path} (png, 12 bytes). This model cannot view image files, so its "
            f"contents are not shown. If a shell tool is available, use it when the file has a "
            f"text-extractable form.]"
        )

    @pytest.mark.asyncio
    async def test_describes_a_document_as_text(self, reader_text_only, ctx, tmp_path):
        file_path = tmp_path / "spec.pdf"
        file_path.write_bytes(b"%PDF-1.7 fake")
        out = await reader_text_only(path=str(file_path), tool_context=ctx)
        assert out == (
            f"[Document file: {file_path} (pdf, 13 bytes). This model cannot view document files, so "
            f"its contents are not shown. If a shell tool is available, use it when the file has a "
            f"text-extractable form.]"
        )

    @pytest.mark.asyncio
    async def test_leaves_text_reads_untouched(self, reader_text_only, ctx, tmp_path):
        file_path = tmp_path / "f.txt"
        file_path.write_text("alpha\nbeta\n")
        out = await reader_text_only(path=str(file_path), tool_context=ctx)
        assert out == "     1\talpha\n     2\tbeta\n     3\t"


class TestPathValidation:
    @pytest.mark.asyncio
    async def test_relative_path_rejected(self, reader, ctx):
        with pytest.raises(ValueError, match="not absolute"):
            await reader(path="relative/path", tool_context=ctx)

    @pytest.mark.asyncio
    async def test_path_traversal_rejected(self, reader, ctx):
        with pytest.raises(ValueError, match="path traversal"):
            await reader(path="/tmp/../etc/passwd", tool_context=ctx)


class TestSizeCap:
    @pytest.mark.asyncio
    async def test_rejects_window_exceeding_max_bytes(self, reader, ctx, tmp_path):
        file_path = tmp_path / "big.txt"
        file_path.write_text("x" * (1_048_576 + 1))
        with pytest.raises(ValueError, match=r"exceeding the 1048576-byte limit"):
            await reader(path=str(file_path), tool_context=ctx)

    @pytest.mark.asyncio
    async def test_rejects_oversize_image(self, reader, ctx, tmp_path):
        file_path = tmp_path / "huge.png"
        file_path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * (10_485_760 + 1))
        with pytest.raises(ValueError, match=r"exceeding the 10485760-byte limit for image reads"):
            await reader(path=str(file_path), tool_context=ctx)

    @pytest.mark.asyncio
    async def test_rejects_oversize_document(self, reader, ctx, tmp_path):
        file_path = tmp_path / "huge.pdf"
        file_path.write_bytes(b"%PDF-" + b"x" * (10_485_760 + 1))
        with pytest.raises(ValueError, match=r"exceeding the 10485760-byte limit for document reads"):
            await reader(path=str(file_path), tool_context=ctx)

    @pytest.mark.asyncio
    async def test_oversize_image_returns_placeholder_when_media_off(self, reader_text_only, ctx, tmp_path):
        file_path = tmp_path / "huge.png"
        file_path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * (10_485_760 + 1))
        out = await reader_text_only(path=str(file_path), tool_context=ctx)
        assert isinstance(out, str)
        assert out.startswith("[Image file:")

    @pytest.mark.asyncio
    async def test_oversize_document_returns_placeholder_when_media_off(self, reader_text_only, ctx, tmp_path):
        file_path = tmp_path / "huge.pdf"
        file_path.write_bytes(b"%PDF-" + b"x" * (10_485_760 + 1))
        out = await reader_text_only(path=str(file_path), tool_context=ctx)
        assert isinstance(out, str)
        assert out.startswith("[Document file:")

    @pytest.mark.asyncio
    async def test_max_bytes_is_configurable(self, ctx, tmp_path):
        file_path = tmp_path / "f.txt"
        file_path.write_text("x" * 2000)  # one line, 2000 bytes
        reader_small = make_read(sandbox=NotASandboxLocalEnvironment(), max_bytes=1000)
        with pytest.raises(ValueError, match=r"exceeding the 1000-byte limit"):
            await reader_small(path=str(file_path), tool_context=ctx)
        reader_big = make_read(sandbox=NotASandboxLocalEnvironment(), max_bytes=4096)
        out = await reader_big(path=str(file_path), tool_context=ctx)
        assert out.startswith("     1\t")

    @pytest.mark.asyncio
    async def test_max_media_bytes_is_configurable(self, ctx, tmp_path):
        file_path = tmp_path / "pic.png"
        file_path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * 1000)
        reader_small = make_read(sandbox=NotASandboxLocalEnvironment(), max_media_bytes=500)
        with pytest.raises(ValueError, match=r"exceeding the 500-byte limit for image reads"):
            await reader_small(path=str(file_path), tool_context=ctx)


class TestNonUtf8:
    @pytest.mark.asyncio
    async def test_non_utf8_file_raises_clear_error(self, reader, ctx, tmp_path):
        file_path = tmp_path / "data.txt"
        file_path.write_bytes(b"valid\n\xe9\xff\xfe\n")
        with pytest.raises(ValueError, match="not UTF-8 text"):
            await reader(path=str(file_path), tool_context=ctx)


class TestDescription:
    def test_default_description_appends_media_suffix(self):
        reader_media = make_read()
        assert "return media you can view directly" in reader_media.tool_spec["description"]

    def test_media_off_description_omits_media_suffix(self):
        reader_text_only = make_read(media=False)
        assert "return media you can view directly" not in reader_text_only.tool_spec["description"]
        assert "numbered lines" in reader_text_only.tool_spec["description"]

    def test_explicit_description_wins(self):
        reader_custom = make_read(media=False, description="Custom.")
        assert reader_custom.tool_spec["description"] == "Custom."


class TestOffsetLimitValidation:
    @pytest.mark.parametrize("offset", [0, -1, -100])
    @pytest.mark.asyncio
    async def test_non_positive_offset_rejected(self, reader, ctx, tmp_path, offset):
        file_path = tmp_path / "f.txt"
        file_path.write_text("one\n")
        with pytest.raises(ValueError, match="offset must be a positive"):
            await reader(path=str(file_path), offset=offset, tool_context=ctx)

    @pytest.mark.parametrize("limit", [0, -1, -100])
    @pytest.mark.asyncio
    async def test_non_positive_limit_rejected(self, reader, ctx, tmp_path, limit):
        file_path = tmp_path / "f.txt"
        file_path.write_text("one\n")
        with pytest.raises(ValueError, match="limit must be a positive"):
            await reader(path=str(file_path), limit=limit, tool_context=ctx)


class TestAgentSandboxFallback:
    @pytest.mark.asyncio
    async def test_uses_agent_sandbox_when_unbound(self, tmp_path):
        file_path = tmp_path / "f.txt"
        file_path.write_text("hello\n")
        ctx = _tool_context()
        out = await read(path=str(file_path), tool_context=ctx)
        assert "     1\thello" in out

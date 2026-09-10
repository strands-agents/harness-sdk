"""Tests for the retrieve_context tool."""

import json

import pytest

from strands._context_manager.retrieval_tool import (
    RETRIEVAL_TOOL_NAME,
    _create_retrieval_tool,
    _extract_text,
    _track_retrieval_tool_use_ids,
)
from strands._context_manager.stash import Stash
from strands.storage.in_memory_storage import InMemoryStorage
from strands.types.content import ContentBlock, Message
from strands.types.tools import ToolUse


@pytest.fixture
def stash():
    return Stash(InMemoryStorage(), "test-session", "test-agent")


async def _store_text(stash, text):
    data = json.dumps({"text": text}).encode("utf-8")
    return await stash.store("tool-1", 0, data)


class TestRetrievalTool:
    """Tests for the retrieve_context tool."""

    def test_has_correct_name(self, stash):
        tool = _create_retrieval_tool(stash)
        assert tool.tool_name == RETRIEVAL_TOOL_NAME

    @pytest.mark.asyncio
    async def test_retrieves_full_content(self, stash):
        ref = await _store_text(stash, "hello world\nline two")
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": ref}})
        assert result["status"] == "success"
        content_text = result["content"][0]["text"]
        parsed = json.loads(content_text)
        assert parsed == {"text": "hello world\nline two"}

    @pytest.mark.asyncio
    async def test_searches_with_pattern(self, stash):
        lines = "\n".join(f"line {i}: {'ERROR' if i % 3 == 0 else 'ok'}" for i in range(1, 21))
        ref = await _store_text(stash, lines)
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": ref, "pattern": "ERROR"}})
        assert result["status"] == "success"
        assert "match" in result["content"][0]["text"].lower()

    @pytest.mark.asyncio
    async def test_returns_line_range(self, stash):
        lines = "\n".join(f"line {i}" for i in range(1, 11))
        ref = await _store_text(stash, lines)
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func(
            {"toolUseId": "t1", "input": {"reference": ref, "line_range": {"start": 3, "end": 5}}}
        )
        assert result["status"] == "success"
        text = result["content"][0]["text"]
        assert "line 3" in text
        assert "line 5" in text

    @pytest.mark.asyncio
    async def test_returns_error_for_unknown_reference(self, stash):
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": "nonexistent"}})
        assert result["status"] == "error"
        assert "not found" in result["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_retrieves_json_content(self, stash):
        data = json.dumps({"json": {"key": "value"}}).encode("utf-8")
        ref = await stash.store("tool-1", 0, data)
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": ref}})
        assert result["status"] == "success"
        parsed = json.loads(result["content"][0]["text"])
        assert parsed == {"json": {"key": "value"}}

    @pytest.mark.asyncio
    async def test_returns_error_for_non_text_content_with_pattern(self, stash):
        data = json.dumps({"image": {"format": "png", "source": "bytes"}}).encode("utf-8")
        ref = await stash.store("tool-1", 0, data)
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": ref, "pattern": "foo"}})
        assert result["status"] == "error"
        assert "cannot search non-text content" in result["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_returns_error_for_invalid_line_range(self, stash):
        ref = await _store_text(stash, "line 1\nline 2\nline 3")
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func(
            {"toolUseId": "t1", "input": {"reference": ref, "line_range": {"start": 100, "end": 5}}}
        )
        assert result["status"] == "error"


class TestExtractText:
    """Tests for _extract_text helper."""

    def test_extracts_string(self):
        assert _extract_text("hello") == "hello"

    def test_extracts_text_field(self):
        assert _extract_text({"text": "hello"}) == "hello"

    def test_extracts_json_field(self):
        result = _extract_text({"json": {"key": "val"}})
        assert result is not None
        assert "key" in result

    def test_returns_none_for_non_text(self):
        assert _extract_text({"image": "data"}) is None

    def test_returns_none_for_non_dict(self):
        assert _extract_text(42) is None


class TestFullTextTruncation:
    """Tests for full-content retrieval truncation."""

    @pytest.mark.asyncio
    async def test_truncates_large_full_content(self, stash):
        ref = await _store_text(stash, "x" * 50_000)
        tool = _create_retrieval_tool(stash, max_result_tokens=10)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": ref}})
        assert result["status"] == "success"
        text = result["content"][0]["text"]
        assert text.endswith("\n\n[truncated]")


class TestMediaBlockRetrieval:
    """Tests for media block retrieval (image/document/video)."""

    @pytest.mark.asyncio
    async def test_restores_image_block(self, stash):
        data = json.dumps({"image": {"format": "png", "source": {"bytes": "UE5HX0RBVEE="}}}).encode("utf-8")
        ref = await stash.store("tool-1", 0, data)
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": ref}})
        assert result["status"] == "success"
        assert "image" in result["content"][0]
        assert result["content"][0]["image"]["format"] == "png"
        assert result["content"][0]["image"]["source"]["bytes"] == b"PNG_DATA"

    @pytest.mark.asyncio
    async def test_restores_document_block(self, stash):
        data = json.dumps({"document": {"format": "pdf", "source": {"bytes": "UERGX0RBVEE="}}}).encode("utf-8")
        ref = await stash.store("tool-1", 0, data)
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": ref}})
        assert result["status"] == "success"
        assert "document" in result["content"][0]
        assert result["content"][0]["document"]["format"] == "pdf"
        assert result["content"][0]["document"]["source"]["bytes"] == b"PDF_DATA"

    @pytest.mark.asyncio
    async def test_returns_text_content_normally(self, stash):
        ref = await _store_text(stash, "hello world")
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func({"toolUseId": "t1", "input": {"reference": ref}})
        assert result["status"] == "success"
        assert "hello world" in result["content"][0]["text"]


class TestInvalidLineRange:
    """Tests for malformed line_range input."""

    @pytest.mark.asyncio
    async def test_returns_error_for_missing_start_key(self, stash):
        ref = await _store_text(stash, "line 1\nline 2")
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func(
            {"toolUseId": "t1", "input": {"reference": ref, "line_range": {"end": 2}}}
        )
        assert result["status"] == "error"
        assert "invalid line_range" in result["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_returns_error_for_non_numeric_values(self, stash):
        ref = await _store_text(stash, "line 1\nline 2")
        tool = _create_retrieval_tool(stash)
        result = await tool._tool_func(
            {"toolUseId": "t1", "input": {"reference": ref, "line_range": {"start": "abc", "end": 2}}}
        )
        assert result["status"] == "error"
        assert "invalid line_range" in result["content"][0]["text"]


class TestTrackRetrievalToolUseIds:
    """Tests for _track_retrieval_tool_use_ids."""

    def test_tracks_retrieve_context_tool_use_ids(self):
        skip_set: set[str] = set()
        message = Message(
            role="assistant",
            content=[
                ContentBlock(toolUse=ToolUse(toolUseId="tu-ret", name=RETRIEVAL_TOOL_NAME, input={})),
            ],
        )
        _track_retrieval_tool_use_ids(message, skip_set)
        assert "tu-ret" in skip_set

    def test_ignores_non_retrieval_tool_uses(self):
        skip_set: set[str] = set()
        message = Message(
            role="assistant",
            content=[
                ContentBlock(toolUse=ToolUse(toolUseId="tu-other", name="bash", input={})),
            ],
        )
        _track_retrieval_tool_use_ids(message, skip_set)
        assert len(skip_set) == 0

    def test_ignores_user_messages(self):
        skip_set: set[str] = set()
        message = Message(role="user", content=[ContentBlock(text="hello")])
        _track_retrieval_tool_use_ids(message, skip_set)
        assert len(skip_set) == 0

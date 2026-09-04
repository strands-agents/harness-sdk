"""Tests for the retrieve_context tool."""

import json

import pytest
from strands._context_manager.retrieval_tool import RETRIEVAL_TOOL_NAME, _create_retrieval_tool, _extract_text
from strands._context_manager.stash import Stash
from strands.storage.in_memory_storage import InMemoryStorage


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

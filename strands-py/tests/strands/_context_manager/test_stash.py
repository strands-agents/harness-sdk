"""Tests for the Stash class."""

import json
import unittest.mock

import pytest

from strands._context_manager.stash import Stash, _BytesEncoder, _format_stash_refs
from strands.storage.in_memory_storage import InMemoryStorage
from strands.types.content import ContentBlock, Message
from strands.types.tools import ToolResult


@pytest.fixture
def storage():
    return InMemoryStorage()


@pytest.fixture
def stash(storage):
    return Stash(storage, "test-session", "test-agent")


class TestStoreAndRetrieve:
    """Tests for store/retrieve round-tripping."""

    @pytest.mark.asyncio
    async def test_round_trips_text_content(self, stash):
        data = json.dumps({"text": "hello world"}).encode("utf-8")
        ref = await stash.store("tool-1", 0, data)
        result = await stash.retrieve(ref)
        assert result == {"text": "hello world"}

    @pytest.mark.asyncio
    async def test_round_trips_json_content(self, stash):
        data = json.dumps({"json": {"key": "value"}}).encode("utf-8")
        ref = await stash.store("tool-1", 0, data)
        result = await stash.retrieve(ref)
        assert result == {"json": {"key": "value"}}

    @pytest.mark.asyncio
    async def test_returns_none_for_unknown_reference(self, stash):
        result = await stash.retrieve("nonexistent")
        assert result is None

    @pytest.mark.asyncio
    async def test_deterministic_keys(self, stash):
        data = json.dumps({"text": "test"}).encode("utf-8")
        ref1 = await stash.store("tool-1", 0, data)
        ref2 = await stash.store("tool-1", 0, data)
        assert ref1 == ref2

    @pytest.mark.asyncio
    async def test_different_keys_for_different_ids(self, stash):
        data = json.dumps({"text": "test"}).encode("utf-8")
        ref1 = await stash.store("tool-1", 0, data)
        ref2 = await stash.store("tool-2", 0, data)
        assert ref1 != ref2

    @pytest.mark.asyncio
    async def test_different_keys_for_different_indices(self, stash):
        data = json.dumps({"text": "test"}).encode("utf-8")
        ref1 = await stash.store("tool-1", 0, data)
        ref2 = await stash.store("tool-1", 1, data)
        assert ref1 != ref2


class TestListAndDelete:
    """Tests for list and delete operations."""

    @pytest.mark.asyncio
    async def test_lists_stored_references(self, stash):
        data = json.dumps({"text": "test"}).encode("utf-8")
        await stash.store("tool-1", 0, data)
        await stash.store("tool-2", 0, data)
        keys = await stash.list()
        assert sorted(keys) == ["tool-1_0", "tool-2_0"]

    @pytest.mark.asyncio
    async def test_delete_removes_entry(self, stash):
        data = json.dumps({"text": "test"}).encode("utf-8")
        ref = await stash.store("tool-1", 0, data)
        await stash.delete(ref)
        result = await stash.retrieve(ref)
        assert result is None


class TestRefsFor:
    """Tests for refs_for — deterministic key computation."""

    def test_tool_result_block_produces_per_sub_block_refs(self):
        stash = Stash(InMemoryStorage(), "s", "a")
        block = ContentBlock(
            toolResult=ToolResult(
                toolUseId="tu-1",
                status="success",
                content=[{"text": "a"}, {"text": "b"}],
            )
        )
        message = Message(role="user", content=[block])
        refs = stash.refs_for(block, message, 0)
        assert refs == ["tu-1_0", "tu-1_1"]

    def test_text_block_uses_tracking_id(self):
        stash = Stash(InMemoryStorage(), "s", "a")
        block = ContentBlock(text="hello")
        message = Message(role="assistant", content=[block], tracking_id="track-1")
        refs = stash.refs_for(block, message, 0)
        assert refs == ["track-1_0"]


class TestStoreMessage:
    """Tests for eager stashing of messages."""

    @pytest.mark.asyncio
    async def test_stores_tool_result_content(self, stash):
        block = ContentBlock(
            toolResult=ToolResult(
                toolUseId="tu-1",
                status="success",
                content=[{"text": "result data"}],
            )
        )
        message = Message(role="user", content=[block])
        await stash.store_message(message)
        result = await stash.retrieve("tu-1_0")
        assert result == {"text": "result data"}

    @pytest.mark.asyncio
    async def test_stores_text_blocks(self, stash):
        block = ContentBlock(text="hello world")
        message = Message(role="assistant", content=[block], tracking_id="track-1")
        await stash.store_message(message)
        result = await stash.retrieve("track-1_0")
        assert result == {"text": "hello world"}

    @pytest.mark.asyncio
    async def test_stores_image_block_with_bytes(self, stash):
        block = ContentBlock(
            image={"format": "png", "source": {"bytes": b"\x89PNG\r\n\x1a\n"}}
        )
        message = Message(role="user", content=[block], tracking_id="track-img")
        await stash.store_message(message)
        result = await stash.retrieve("track-img_0")
        assert result is not None
        assert "image" in result

    @pytest.mark.asyncio
    async def test_skips_tool_use_blocks(self, stash):
        block = ContentBlock(toolUse={"toolUseId": "tu-1", "name": "test", "input": {}})
        message = Message(role="assistant", content=[block], tracking_id="track-1")
        await stash.store_message(message)
        keys = await stash.list()
        assert len(keys) == 0

    @pytest.mark.asyncio
    async def test_skips_tool_results_in_skip_set(self, stash):
        block = ContentBlock(
            toolResult=ToolResult(
                toolUseId="tu-skip",
                status="success",
                content=[{"text": "should skip"}],
            )
        )
        message = Message(role="user", content=[block])
        await stash.store_message(message, skip_tool_use_ids=frozenset({"tu-skip"}))
        result = await stash.retrieve("tu-skip_0")
        assert result is None


class TestNamespacing:
    """Tests for storage namespace isolation."""

    @pytest.mark.asyncio
    async def test_stash_keys_are_namespaced(self):
        storage = InMemoryStorage()
        stash = Stash(storage, "sess-1", "agent-1")
        await stash.store("tool-1", 0, json.dumps({"text": "test"}).encode("utf-8"))
        raw_keys = await storage.list("")
        assert raw_keys == ["context/sess-1/scopes/agent/agent-1/tool-1_0"]

    @pytest.mark.asyncio
    async def test_different_agents_dont_conflict(self):
        storage = InMemoryStorage()
        stash_a = Stash(storage, "sess-1", "agent-a")
        stash_b = Stash(storage, "sess-1", "agent-b")
        data = json.dumps({"text": "test"}).encode("utf-8")
        await stash_a.store("tool-1", 0, data)
        await stash_b.store("tool-1", 0, data)
        keys_a = await stash_a.list()
        keys_b = await stash_b.list()
        assert keys_a == ["tool-1_0"]
        assert keys_b == ["tool-1_0"]


class TestFormatStashRefs:
    """Tests for the _format_stash_refs helper."""

    def test_empty_returns_empty_string(self):
        assert _format_stash_refs([]) == ""

    def test_single_ref(self):
        assert _format_stash_refs(["tu-1_0"]) == " [ref: tu-1_0]"

    def test_multiple_refs(self):
        result = _format_stash_refs(["tu-1_0", "tu-1_1"])
        assert result == " [refs: tu-1_0, tu-1_1]"


class TestBytesEncoder:
    """Tests for _BytesEncoder."""

    def test_raises_for_non_serializable_type(self):
        encoder = _BytesEncoder()
        with pytest.raises(TypeError):
            encoder.default(object())


class TestStoreMessageErrorHandling:
    """Tests for error handling in store_message."""

    @pytest.mark.asyncio
    async def test_logs_warning_on_text_block_store_failure(self):
        stash = Stash(InMemoryStorage(), "s", "a")
        stash._storage.write = unittest.mock.AsyncMock(side_effect=RuntimeError("write failed"))
        block = ContentBlock(text="hello")
        message = Message(role="assistant", content=[block], tracking_id="track-1")
        await stash.store_message(message)

    @pytest.mark.asyncio
    async def test_logs_warning_on_tool_result_sub_block_store_failure(self):
        stash = Stash(InMemoryStorage(), "s", "a")
        stash._storage.write = unittest.mock.AsyncMock(side_effect=RuntimeError("write failed"))
        block = ContentBlock(
            toolResult=ToolResult(
                toolUseId="tu-1",
                status="success",
                content=[{"text": "data"}],
            )
        )
        message = Message(role="user", content=[block])
        await stash.store_message(message)

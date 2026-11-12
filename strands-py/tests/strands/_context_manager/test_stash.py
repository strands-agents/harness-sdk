"""Tests for the Stash class."""

import json
import unittest.mock

import pytest

from strands._context_manager.stash import Stash, _BytesEncoder, _parse_stash_key
from strands.storage.in_memory_storage import InMemoryStorage
from strands.types.content import ContentBlock, Message
from strands.types.tools import ToolResult


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


class TestStashKeys:
    """Tests for the ``<id>_<index>`` key a stash entry is stored under."""

    @pytest.mark.parametrize(
        ("block_id", "block_index"),
        [("tu-1", 0), ("call_12", 3), ("removed-0199-abc", 0)],
    )
    @pytest.mark.asyncio
    async def test_round_trips_an_id_and_index(self, stash, block_id, block_index):
        key = await stash.store(block_id, block_index, b"{}")
        assert _parse_stash_key(key) == (block_id, block_index)

    @pytest.mark.parametrize("key", ["tu-1", "tu-1_", "_0", "tu-1_x", "tu-1_1a"])
    def test_rejects_a_key_without_an_index(self, key):
        assert _parse_stash_key(key) is None


class TestEnsureStashed:
    """Tests for the reference an offload placeholder carries for the block it replaces."""

    @pytest.mark.asyncio
    async def test_references_a_tool_result_by_tool_use_id_and_any_other_block_by_position(self, stash):
        tool_result = ContentBlock(toolResult=ToolResult(toolUseId="tu-1", status="success", content=[{"text": "a"}]))
        message = Message(role="user", content=[ContentBlock(text="t"), tool_result], tracking_id="track-1")

        assert await stash.ensure_stashed(tool_result, message, 1) == "tu-1"
        assert await stash.ensure_stashed(message["content"][0], message, 0) == "track-1_0"
        assert await stash.take_snapshot() == {"tu-1_0": {"text": "a"}, "track-1_0": {"text": "t"}}

    @pytest.mark.asyncio
    async def test_leaves_an_entry_already_stored_under_the_reference_untouched(self, stash):
        await stash.store("track-1", 0, json.dumps({"text": "original"}).encode("utf-8"))
        message = Message(role="user", content=[ContentBlock(text="edited")], tracking_id="track-1")

        assert await stash.ensure_stashed(message["content"][0], message, 0) == "track-1_0"
        assert await stash.retrieve("track-1_0") == {"text": "original"}

    @pytest.mark.asyncio
    async def test_does_not_restash_a_tool_result_that_holds_a_placeholder(self, stash):
        placeholder = {"text": "[Dropped] [ref: tu-1]", "offloaded": {"method": "drop", "ref": "tu-1"}}
        tool_result = ContentBlock(toolResult=ToolResult(toolUseId="tu-1", status="success", content=[placeholder]))
        message = Message(role="user", content=[tool_result], tracking_id="track-1")

        assert await stash.ensure_stashed(tool_result, message, 0) == "tu-1"
        assert await stash.take_snapshot() == {}


class TestKeysOf:
    """Tests for the keys stored under one reference id."""

    @pytest.mark.asyncio
    async def test_returns_the_keys_in_index_order(self, stash):
        for block_index in (2, 0, 1):
            await stash.store("tu-1", block_index, b"{}")

        assert await stash.keys_of("tu-1") == ["tu-1_0", "tu-1_1", "tu-1_2"]

    @pytest.mark.asyncio
    async def test_leaves_out_ids_that_extend_this_one(self, stash):
        await stash.store("tool", 0, b"{}")
        await stash.store("tool_1", 0, b"{}")

        assert await stash.keys_of("tool") == ["tool_0"]
        assert await stash.keys_of("tool_1") == ["tool_1_0"]

    @pytest.mark.asyncio
    async def test_returns_nothing_for_an_unknown_id(self, stash):
        assert await stash.keys_of("tu-1") == []


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
        block = ContentBlock(image={"format": "png", "source": {"bytes": b"\x89PNG\r\n\x1a\n"}})
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

    @pytest.mark.asyncio
    async def test_keep_existing_leaves_stored_entries_untouched(self, stash):
        await stash.load_snapshot({"tu-1_0": {"text": "original result"}, "track-1_1": {"text": "original text"}})
        message = Message(
            role="user",
            content=[
                ContentBlock(
                    toolResult=ToolResult(
                        toolUseId="tu-1",
                        status="success",
                        content=[{"text": "preview result"}, {"text": "second result"}],
                    )
                ),
                ContentBlock(text="preview text"),
            ],
            tracking_id="track-1",
        )

        await stash.store_message(message, keep_existing=True)

        tru_entries = await stash.take_snapshot()
        exp_entries = {
            "tu-1_0": {"text": "original result"},
            "tu-1_1": {"text": "second result"},
            "track-1_1": {"text": "original text"},
        }
        assert tru_entries == exp_entries

    @pytest.mark.asyncio
    async def test_stashes_text_that_only_looks_like_a_placeholder(self, stash):
        message = Message(role="user", content=[ContentBlock(text="[Dropped] [ref: tu-1]")], tracking_id="track-1")

        await stash.store_message(message)

        assert await stash.take_snapshot() == {"track-1_0": {"text": "[Dropped] [ref: tu-1]"}}

    @pytest.mark.asyncio
    async def test_skips_a_placeholder_and_a_tool_result_that_holds_one_keeping_other_blocks(self, stash):
        message = Message(
            role="user",
            content=[
                ContentBlock(text="[Dropped] [ref: track-0_0]", offloaded={"method": "drop", "ref": "track-0_0"}),
                ContentBlock(
                    toolResult=ToolResult(
                        toolUseId="tu-1",
                        status="success",
                        content=[
                            {
                                "text": "[Truncated: 1 block, ~10,973 tokens]\n\nrow-1 [ref: tu-1]",
                                "offloaded": {"method": "truncate", "ref": "tu-1"},
                            },
                            {"image": {"format": "png", "source": {"bytes": b"img"}}},
                        ],
                    )
                ),
                ContentBlock(text="kept"),
            ],
            tracking_id="track-1",
        )

        await stash.store_message(message)

        assert await stash.take_snapshot() == {"track-1_2": {"text": "kept"}}


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

    @pytest.mark.asyncio
    async def test_keep_existing_does_not_write_when_existence_check_fails(self):
        stash = Stash(InMemoryStorage(), "s", "a")
        stash._storage.read = unittest.mock.AsyncMock(side_effect=RuntimeError("read failed"))
        stash._storage.write = unittest.mock.AsyncMock()
        block = ContentBlock(text="hello")
        message = Message(role="assistant", content=[block], tracking_id="track-1")

        await stash.store_message(message, keep_existing=True)

        stash._storage.write.assert_not_called()


class TestStorageTypeName:
    """Tests for storage_type_name property."""

    def test_returns_class_name_of_base_storage(self):
        storage = InMemoryStorage()
        stash = Stash(storage, "s", "a")
        assert stash.storage_type_name == "InMemoryStorage"


class TestTakeSnapshot:
    """Tests for take_snapshot — serializing all entries."""

    @pytest.mark.asyncio
    async def test_returns_empty_dict_when_no_entries(self, stash):
        result = await stash.take_snapshot()
        assert result == {}

    @pytest.mark.asyncio
    async def test_returns_all_stored_entries(self, stash):
        await stash.store("tool-1", 0, json.dumps({"text": "hello"}).encode("utf-8"))
        await stash.store("tool-2", 0, json.dumps({"text": "world"}).encode("utf-8"))
        result = await stash.take_snapshot()
        assert result == {"tool-1_0": {"text": "hello"}, "tool-2_0": {"text": "world"}}


class TestLoadSnapshot:
    """Tests for load_snapshot — restoring entries from a snapshot."""

    @pytest.mark.asyncio
    async def test_restores_entries(self, stash):
        entries = {"tool-1_0": {"text": "hello"}, "tool-2_0": {"text": "world"}}
        await stash.load_snapshot(entries)
        assert await stash.retrieve("tool-1_0") == {"text": "hello"}
        assert await stash.retrieve("tool-2_0") == {"text": "world"}

    @pytest.mark.asyncio
    async def test_round_trip(self, stash):
        await stash.store("tool-1", 0, json.dumps({"text": "original"}).encode("utf-8"))
        snapshot = await stash.take_snapshot()

        new_stash = Stash(InMemoryStorage(), "test-session", "test-agent")
        await new_stash.load_snapshot(snapshot)
        assert await new_stash.retrieve("tool-1_0") == {"text": "original"}


class TestClear:
    """Tests for clear — deleting all entries in the agent namespace."""

    @pytest.mark.asyncio
    async def test_deletes_all_entries(self, stash):
        await stash.store("tool-1", 0, json.dumps({"text": "a"}).encode("utf-8"))
        await stash.store("tool-2", 0, json.dumps({"text": "b"}).encode("utf-8"))
        await stash.clear()
        assert await stash.list() == []

    @pytest.mark.asyncio
    async def test_clear_on_empty_stash(self, stash):
        await stash.clear()
        assert await stash.list() == []


class TestClearSession:
    """Tests for clear_session — deleting all stash data for the session."""

    @pytest.mark.asyncio
    async def test_deletes_entries_across_agents(self):
        storage = InMemoryStorage()
        stash_a = Stash(storage, "sess-1", "agent-a")
        stash_b = Stash(storage, "sess-1", "agent-b")
        await stash_a.store("tool-1", 0, json.dumps({"text": "a"}).encode("utf-8"))
        await stash_b.store("tool-1", 0, json.dumps({"text": "b"}).encode("utf-8"))

        await stash_a.clear_session()

        assert await stash_a.list() == []
        assert await stash_b.list() == []

    @pytest.mark.asyncio
    async def test_does_not_affect_other_sessions(self):
        storage = InMemoryStorage()
        stash_s1 = Stash(storage, "sess-1", "agent-a")
        stash_s2 = Stash(storage, "sess-2", "agent-a")
        await stash_s1.store("tool-1", 0, json.dumps({"text": "s1"}).encode("utf-8"))
        await stash_s2.store("tool-1", 0, json.dumps({"text": "s2"}).encode("utf-8"))

        await stash_s1.clear_session()

        assert await stash_s1.list() == []
        assert await stash_s2.list() == ["tool-1_0"]

    @pytest.mark.asyncio
    async def test_prefix_boundary_does_not_broaden(self):
        """Clearing session 's1' must not affect session 's10'."""
        storage = InMemoryStorage()
        stash_s1 = Stash(storage, "s1", "agent-a")
        stash_s10 = Stash(storage, "s10", "agent-a")
        await stash_s1.store("tool-1", 0, json.dumps({"text": "s1"}).encode("utf-8"))
        await stash_s10.store("tool-1", 0, json.dumps({"text": "s10"}).encode("utf-8"))

        await stash_s1.clear_session()

        assert await stash_s1.list() == []
        assert await stash_s10.list() == ["tool-1_0"]


class TestCallerScopedRoot:
    """Tests for stashes rooted at a caller-scoped storage view."""

    @pytest.mark.asyncio
    async def test_view_is_exact_root(self):
        storage = InMemoryStorage()
        stash = Stash(storage.namespace("tenants/t1/research"), "sess-1", "agent-a", custom_stash_namespace=True)
        await stash.store("tool-1", 0, json.dumps({"text": "test"}).encode("utf-8"))

        assert await storage.list("") == ["tenants/t1/research/tool-1_0"]

    @pytest.mark.asyncio
    async def test_view_uses_per_agent_root_unless_allowed(self):
        storage = InMemoryStorage()
        stash = Stash(storage.namespace("tenant"), "sess-1", "agent-a")
        await stash.store("tool-1", 0, json.dumps({"text": "test"}).encode("utf-8"))

        assert await storage.list("") == ["tenant/context/sess-1/scopes/agent/agent-a/tool-1_0"]

    @pytest.mark.asyncio
    async def test_agents_in_different_sessions_sharing_a_view_read_each_others_entries(self):
        storage = InMemoryStorage()
        stash_a = Stash(storage.namespace("team"), "sess-1", "agent-a", custom_stash_namespace=True)
        stash_b = Stash(storage.namespace("team"), "sess-2", "agent-b", custom_stash_namespace=True)
        await stash_a.store("tool-1", 0, json.dumps({"text": "from a"}).encode("utf-8"))

        assert await stash_b.retrieve("tool-1_0") == {"text": "from a"}

    @pytest.mark.asyncio
    async def test_clear_session_keeps_shared_view(self):
        storage = InMemoryStorage()
        stash = Stash(storage.namespace("team"), "sess-1", "agent-a", custom_stash_namespace=True)
        await stash.store("tool-1", 0, json.dumps({"text": "shared"}).encode("utf-8"))

        await stash.clear_session()

        assert await storage.list("") == ["team/tool-1_0"]

"""Tests for the Archive class."""

import json
import unittest.mock

import pytest

from strands._context_manager.archive import Archive, _BytesEncoder, _parse_archive_key
from strands.storage.in_memory_storage import InMemoryStorage
from strands.types.content import ContentBlock, Message
from strands.types.tools import ToolResult


class TestStoreAndRetrieve:
    """Tests for store/retrieve round-tripping."""

    @pytest.mark.asyncio
    async def test_round_trips_text_content(self, archive):
        data = json.dumps({"text": "hello world"}).encode("utf-8")
        ref = await archive.store("tool-1", 0, data)
        result = await archive.retrieve(ref)
        assert result == {"text": "hello world"}

    @pytest.mark.asyncio
    async def test_round_trips_json_content(self, archive):
        data = json.dumps({"json": {"key": "value"}}).encode("utf-8")
        ref = await archive.store("tool-1", 0, data)
        result = await archive.retrieve(ref)
        assert result == {"json": {"key": "value"}}

    @pytest.mark.asyncio
    async def test_returns_none_for_unknown_reference(self, archive):
        result = await archive.retrieve("nonexistent")
        assert result is None

    @pytest.mark.asyncio
    async def test_deterministic_keys(self, archive):
        data = json.dumps({"text": "test"}).encode("utf-8")
        ref1 = await archive.store("tool-1", 0, data)
        ref2 = await archive.store("tool-1", 0, data)
        assert ref1 == ref2

    @pytest.mark.asyncio
    async def test_different_keys_for_different_ids(self, archive):
        data = json.dumps({"text": "test"}).encode("utf-8")
        ref1 = await archive.store("tool-1", 0, data)
        ref2 = await archive.store("tool-2", 0, data)
        assert ref1 != ref2

    @pytest.mark.asyncio
    async def test_different_keys_for_different_indices(self, archive):
        data = json.dumps({"text": "test"}).encode("utf-8")
        ref1 = await archive.store("tool-1", 0, data)
        ref2 = await archive.store("tool-1", 1, data)
        assert ref1 != ref2


class TestListAndDelete:
    """Tests for list and delete operations."""

    @pytest.mark.asyncio
    async def test_lists_stored_references(self, archive):
        data = json.dumps({"text": "test"}).encode("utf-8")
        await archive.store("tool-1", 0, data)
        await archive.store("tool-2", 0, data)
        keys = await archive.list()
        assert sorted(keys) == ["tool-1_0", "tool-2_0"]

    @pytest.mark.asyncio
    async def test_delete_removes_entry(self, archive):
        data = json.dumps({"text": "test"}).encode("utf-8")
        ref = await archive.store("tool-1", 0, data)
        await archive.delete(ref)
        result = await archive.retrieve(ref)
        assert result is None


class TestArchiveKeys:
    """Tests for the ``<id>_<index>`` key an archive entry is stored under."""

    @pytest.mark.parametrize(
        ("block_id", "block_index"),
        [("tu-1", 0), ("call_12", 3), ("removed-0199-abc", 0)],
    )
    @pytest.mark.asyncio
    async def test_round_trips_an_id_and_index(self, archive, block_id, block_index):
        key = await archive.store(block_id, block_index, b"{}")
        assert _parse_archive_key(key) == (block_id, block_index)

    @pytest.mark.parametrize("key", ["tu-1", "tu-1_", "_0", "tu-1_x", "tu-1_1a", "tu-1_²"])
    def test_rejects_a_key_without_an_index(self, key):
        assert _parse_archive_key(key) is None


class TestStoreRemoved:
    @staticmethod
    def _run(text: str) -> list[Message]:
        return [Message(role="assistant", content=[ContentBlock(text=text)])]

    @pytest.mark.asyncio
    async def test_gives_every_removal_its_own_reference(self, archive):
        first = await archive.store_removed(self._run("first"))
        second = await archive.store_removed(self._run("second"))

        assert first != second
        assert await archive.retrieve(f"{first}_0") == [{"role": "assistant", "content": [{"text": "first"}]}]
        assert await archive.retrieve(f"{second}_0") == [{"role": "assistant", "content": [{"text": "second"}]}]


class TestEnsureArchived:
    @pytest.mark.asyncio
    async def test_references_a_tool_result_by_tool_use_id_and_any_other_block_by_position(self, archive):
        tool_result = ContentBlock(toolResult=ToolResult(toolUseId="tu-1", status="success", content=[{"text": "a"}]))
        message = Message(role="user", content=[ContentBlock(text="t"), tool_result], tracking_id="track-1")

        assert await archive.ensure_archived(tool_result, message, 1) == "tu-1"
        assert await archive.ensure_archived(message["content"][0], message, 0) == "track-1_0"
        assert await archive.take_snapshot() == {"tu-1_0": {"text": "a"}, "track-1_0": {"text": "t"}}

    @pytest.mark.asyncio
    async def test_leaves_an_entry_already_stored_under_the_reference_untouched(self, archive):
        await archive.store("track-1", 0, json.dumps({"text": "original"}).encode("utf-8"))
        message = Message(role="user", content=[ContentBlock(text="edited")], tracking_id="track-1")

        assert await archive.ensure_archived(message["content"][0], message, 0) == "track-1_0"
        assert await archive.retrieve("track-1_0") == {"text": "original"}

    @pytest.mark.asyncio
    async def test_does_not_re_archive_a_tool_result_that_holds_a_placeholder(self, archive):
        placeholder = {"text": "[Dropped] [ref: tu-1]", "offloaded": {"method": "drop", "ref": "tu-1"}}
        tool_result = ContentBlock(toolResult=ToolResult(toolUseId="tu-1", status="success", content=[placeholder]))
        message = Message(role="user", content=[tool_result], tracking_id="track-1")

        assert await archive.ensure_archived(tool_result, message, 0) == "tu-1"
        assert await archive.take_snapshot() == {}


class TestKeysOf:
    @pytest.mark.asyncio
    async def test_returns_the_keys_in_index_order(self, archive):
        for block_index in (2, 0, 1):
            await archive.store("tu-1", block_index, b"{}")

        assert await archive.keys_of("tu-1") == ["tu-1_0", "tu-1_1", "tu-1_2"]

    @pytest.mark.asyncio
    async def test_leaves_out_ids_that_extend_this_one(self, archive):
        await archive.store("tool", 0, b"{}")
        await archive.store("tool_1", 0, b"{}")

        assert await archive.keys_of("tool") == ["tool_0"]
        assert await archive.keys_of("tool_1") == ["tool_1_0"]

    @pytest.mark.asyncio
    async def test_returns_nothing_for_an_unknown_id(self, archive):
        assert await archive.keys_of("tu-1") == []


class TestStoreMessage:
    """Tests for eager archiving of messages."""

    @pytest.mark.asyncio
    async def test_stores_tool_result_content(self, archive):
        block = ContentBlock(
            toolResult=ToolResult(
                toolUseId="tu-1",
                status="success",
                content=[{"text": "result data"}],
            )
        )
        message = Message(role="user", content=[block])
        await archive.store_message(message)
        result = await archive.retrieve("tu-1_0")
        assert result == {"text": "result data"}

    @pytest.mark.asyncio
    async def test_stores_text_blocks(self, archive):
        block = ContentBlock(text="hello world")
        message = Message(role="assistant", content=[block], tracking_id="track-1")
        await archive.store_message(message)
        result = await archive.retrieve("track-1_0")
        assert result == {"text": "hello world"}

    @pytest.mark.asyncio
    async def test_stores_image_block_with_bytes(self, archive):
        block = ContentBlock(image={"format": "png", "source": {"bytes": b"\x89PNG\r\n\x1a\n"}})
        message = Message(role="user", content=[block], tracking_id="track-img")
        await archive.store_message(message)
        result = await archive.retrieve("track-img_0")
        assert result is not None
        assert "image" in result

    @pytest.mark.asyncio
    async def test_skips_tool_use_blocks(self, archive):
        block = ContentBlock(toolUse={"toolUseId": "tu-1", "name": "test", "input": {}})
        message = Message(role="assistant", content=[block], tracking_id="track-1")
        await archive.store_message(message)
        keys = await archive.list()
        assert len(keys) == 0

    @pytest.mark.asyncio
    async def test_skips_tool_results_in_skip_set(self, archive):
        block = ContentBlock(
            toolResult=ToolResult(
                toolUseId="tu-skip",
                status="success",
                content=[{"text": "should skip"}],
            )
        )
        message = Message(role="user", content=[block])
        await archive.store_message(message, skip_tool_use_ids=frozenset({"tu-skip"}))
        result = await archive.retrieve("tu-skip_0")
        assert result is None

    @pytest.mark.asyncio
    async def test_keep_existing_leaves_stored_entries_untouched(self, archive):
        await archive.load_snapshot({"tu-1_0": {"text": "original result"}, "track-1_1": {"text": "original text"}})
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

        await archive.store_message(message, keep_existing=True)

        tru_entries = await archive.take_snapshot()
        exp_entries = {
            "tu-1_0": {"text": "original result"},
            "tu-1_1": {"text": "second result"},
            "track-1_1": {"text": "original text"},
        }
        assert tru_entries == exp_entries

    @pytest.mark.asyncio
    async def test_archives_text_that_only_looks_like_a_placeholder(self, archive):
        message = Message(role="user", content=[ContentBlock(text="[Dropped] [ref: tu-1]")], tracking_id="track-1")

        await archive.store_message(message)

        assert await archive.take_snapshot() == {"track-1_0": {"text": "[Dropped] [ref: tu-1]"}}

    @pytest.mark.asyncio
    async def test_skips_a_placeholder_and_a_tool_result_that_holds_one_keeping_other_blocks(self, archive):
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

        await archive.store_message(message)

        assert await archive.take_snapshot() == {"track-1_2": {"text": "kept"}}


class TestNamespacing:
    """Tests for storage namespace isolation."""

    @pytest.mark.asyncio
    async def test_archive_keys_are_namespaced(self):
        storage = InMemoryStorage()
        archive = Archive(storage, "sess-1", "agent-1")
        await archive.store("tool-1", 0, json.dumps({"text": "test"}).encode("utf-8"))
        raw_keys = await storage.list("")
        assert raw_keys == ["context/sess-1/scopes/agent/agent-1/tool-1_0"]

    @pytest.mark.asyncio
    async def test_different_agents_dont_conflict(self):
        storage = InMemoryStorage()
        archive_a = Archive(storage, "sess-1", "agent-a")
        archive_b = Archive(storage, "sess-1", "agent-b")
        data = json.dumps({"text": "test"}).encode("utf-8")
        await archive_a.store("tool-1", 0, data)
        await archive_b.store("tool-1", 0, data)
        keys_a = await archive_a.list()
        keys_b = await archive_b.list()
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
        archive = Archive(InMemoryStorage(), "s", "a")
        archive._storage.write = unittest.mock.AsyncMock(side_effect=RuntimeError("write failed"))
        block = ContentBlock(text="hello")
        message = Message(role="assistant", content=[block], tracking_id="track-1")
        await archive.store_message(message)

    @pytest.mark.asyncio
    async def test_logs_warning_on_tool_result_sub_block_store_failure(self):
        archive = Archive(InMemoryStorage(), "s", "a")
        archive._storage.write = unittest.mock.AsyncMock(side_effect=RuntimeError("write failed"))
        block = ContentBlock(
            toolResult=ToolResult(
                toolUseId="tu-1",
                status="success",
                content=[{"text": "data"}],
            )
        )
        message = Message(role="user", content=[block])
        await archive.store_message(message)

    @pytest.mark.asyncio
    async def test_keep_existing_does_not_write_when_existence_check_fails(self):
        archive = Archive(InMemoryStorage(), "s", "a")
        archive._storage.read = unittest.mock.AsyncMock(side_effect=RuntimeError("read failed"))
        archive._storage.write = unittest.mock.AsyncMock()
        block = ContentBlock(text="hello")
        message = Message(role="assistant", content=[block], tracking_id="track-1")

        await archive.store_message(message, keep_existing=True)

        archive._storage.write.assert_not_called()


class TestStorageTypeName:
    """Tests for storage_type_name property."""

    def test_returns_class_name_of_base_storage(self):
        storage = InMemoryStorage()
        archive = Archive(storage, "s", "a")
        assert archive.storage_type_name == "InMemoryStorage"


class TestTakeSnapshot:
    """Tests for take_snapshot — serializing all entries."""

    @pytest.mark.asyncio
    async def test_returns_empty_dict_when_no_entries(self, archive):
        result = await archive.take_snapshot()
        assert result == {}

    @pytest.mark.asyncio
    async def test_returns_all_stored_entries(self, archive):
        await archive.store("tool-1", 0, json.dumps({"text": "hello"}).encode("utf-8"))
        await archive.store("tool-2", 0, json.dumps({"text": "world"}).encode("utf-8"))
        result = await archive.take_snapshot()
        assert result == {"tool-1_0": {"text": "hello"}, "tool-2_0": {"text": "world"}}


class TestLoadSnapshot:
    """Tests for load_snapshot — restoring entries from a snapshot."""

    @pytest.mark.asyncio
    async def test_restores_entries(self, archive):
        entries = {"tool-1_0": {"text": "hello"}, "tool-2_0": {"text": "world"}}
        await archive.load_snapshot(entries)
        assert await archive.retrieve("tool-1_0") == {"text": "hello"}
        assert await archive.retrieve("tool-2_0") == {"text": "world"}

    @pytest.mark.asyncio
    async def test_round_trip(self, archive):
        await archive.store("tool-1", 0, json.dumps({"text": "original"}).encode("utf-8"))
        snapshot = await archive.take_snapshot()

        new_archive = Archive(InMemoryStorage(), "test-session", "test-agent")
        await new_archive.load_snapshot(snapshot)
        assert await new_archive.retrieve("tool-1_0") == {"text": "original"}


class TestClear:
    """Tests for clear — deleting all entries in the agent namespace."""

    @pytest.mark.asyncio
    async def test_deletes_all_entries(self, archive):
        await archive.store("tool-1", 0, json.dumps({"text": "a"}).encode("utf-8"))
        await archive.store("tool-2", 0, json.dumps({"text": "b"}).encode("utf-8"))
        await archive.clear()
        assert await archive.list() == []

    @pytest.mark.asyncio
    async def test_clear_on_empty_archive(self, archive):
        await archive.clear()
        assert await archive.list() == []


class TestClearSession:
    """Tests for clear_session — deleting all archive data for the session."""

    @pytest.mark.asyncio
    async def test_deletes_entries_across_agents(self):
        storage = InMemoryStorage()
        archive_a = Archive(storage, "sess-1", "agent-a")
        archive_b = Archive(storage, "sess-1", "agent-b")
        await archive_a.store("tool-1", 0, json.dumps({"text": "a"}).encode("utf-8"))
        await archive_b.store("tool-1", 0, json.dumps({"text": "b"}).encode("utf-8"))

        await archive_a.clear_session()

        assert await archive_a.list() == []
        assert await archive_b.list() == []

    @pytest.mark.asyncio
    async def test_does_not_affect_other_sessions(self):
        storage = InMemoryStorage()
        archive_s1 = Archive(storage, "sess-1", "agent-a")
        archive_s2 = Archive(storage, "sess-2", "agent-a")
        await archive_s1.store("tool-1", 0, json.dumps({"text": "s1"}).encode("utf-8"))
        await archive_s2.store("tool-1", 0, json.dumps({"text": "s2"}).encode("utf-8"))

        await archive_s1.clear_session()

        assert await archive_s1.list() == []
        assert await archive_s2.list() == ["tool-1_0"]

    @pytest.mark.asyncio
    async def test_prefix_boundary_does_not_broaden(self):
        """Clearing session 's1' must not affect session 's10'."""
        storage = InMemoryStorage()
        archive_s1 = Archive(storage, "s1", "agent-a")
        archive_s10 = Archive(storage, "s10", "agent-a")
        await archive_s1.store("tool-1", 0, json.dumps({"text": "s1"}).encode("utf-8"))
        await archive_s10.store("tool-1", 0, json.dumps({"text": "s10"}).encode("utf-8"))

        await archive_s1.clear_session()

        assert await archive_s1.list() == []
        assert await archive_s10.list() == ["tool-1_0"]


class TestCallerScopedRoot:
    """Tests for archives rooted at a caller-scoped storage view."""

    @pytest.mark.asyncio
    async def test_view_is_exact_root(self):
        storage = InMemoryStorage()
        archive = Archive(storage.namespace("tenants/t1/research"), "sess-1", "agent-a", custom_archive_namespace=True)
        await archive.store("tool-1", 0, json.dumps({"text": "test"}).encode("utf-8"))

        assert await storage.list("") == ["tenants/t1/research/tool-1_0"]

    @pytest.mark.asyncio
    async def test_view_uses_per_agent_root_unless_allowed(self):
        storage = InMemoryStorage()
        archive = Archive(storage.namespace("tenant"), "sess-1", "agent-a")
        await archive.store("tool-1", 0, json.dumps({"text": "test"}).encode("utf-8"))

        assert await storage.list("") == ["tenant/context/sess-1/scopes/agent/agent-a/tool-1_0"]

    @pytest.mark.asyncio
    async def test_agents_in_different_sessions_sharing_a_view_read_each_others_entries(self):
        storage = InMemoryStorage()
        archive_a = Archive(storage.namespace("team"), "sess-1", "agent-a", custom_archive_namespace=True)
        archive_b = Archive(storage.namespace("team"), "sess-2", "agent-b", custom_archive_namespace=True)
        await archive_a.store("tool-1", 0, json.dumps({"text": "from a"}).encode("utf-8"))

        assert await archive_b.retrieve("tool-1_0") == {"text": "from a"}

    @pytest.mark.asyncio
    async def test_clear_session_keeps_shared_view(self):
        storage = InMemoryStorage()
        archive = Archive(storage.namespace("team"), "sess-1", "agent-a", custom_archive_namespace=True)
        await archive.store("tool-1", 0, json.dumps({"text": "shared"}).encode("utf-8"))

        await archive.clear_session()

        assert await storage.list("") == ["team/tool-1_0"]

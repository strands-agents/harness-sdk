"""Tests for the ContextOffloader plugin."""

import json
import logging
import math
from unittest.mock import AsyncMock, MagicMock

import pytest

from strands.hooks.events import AfterToolCallEvent, BeforeModelCallEvent
from strands.types.tools import ToolContext, ToolUse
from strands.vended_plugins.context_offloader import (
    ContextOffloader,
    FileStorage,
    InMemoryStorage,
)
from tests.fixtures.sandbox import TestSandbox


@pytest.fixture
def storage():
    return InMemoryStorage()


@pytest.fixture
def plugin(storage):
    return ContextOffloader(
        storage=storage,
        max_result_tokens=25,
        preview_tokens=10,
        include_retrieval_tool=False,
    )


@pytest.fixture
def mock_agent(tmp_path):
    agent = MagicMock()
    agent.model = MagicMock()
    agent.model.count_tokens = AsyncMock(side_effect=_heuristic_count_tokens)
    # A real sandbox rooted at a temp dir so FileStorage.for_sandbox binds to a working
    # backend (mirrors the TS suite injecting a TestSandbox into the mock agent).
    agent.sandbox = TestSandbox(str(tmp_path))
    return agent


async def _heuristic_count_tokens(messages, **kwargs):
    """Heuristic token counter for tests: chars / 4."""
    total = 0
    for msg in messages:
        for block in msg.get("content", []):
            if "toolResult" in block:
                for content in block["toolResult"].get("content", []):
                    if "text" in content:
                        total += math.ceil(len(content["text"]) / 4)
                    elif "json" in content:
                        total += math.ceil(len(json.dumps(content["json"])) / 4)
            elif "text" in block:
                total += math.ceil(len(block["text"]) / 4)
    return total


def _make_event(
    agent, text_content, status="success", tool_use_id="tool_123", cancel_message=None, tool_name="test_tool"
):
    """Helper to create an AfterToolCallEvent with content."""
    if isinstance(text_content, str):
        content = [{"text": text_content}]
    else:
        content = text_content

    result = {
        "toolUseId": tool_use_id,
        "status": status,
        "content": content,
    }
    tool_use = {"toolUseId": tool_use_id, "name": tool_name, "input": {}}

    return AfterToolCallEvent(
        agent=agent,
        selected_tool=None,
        tool_use=tool_use,
        invocation_state={},
        result=result,
        cancel_message=cancel_message,
    )


class TestContextOffloader:
    def test_plugin_name(self, plugin):
        assert plugin.name == "context_offloader"

    def test_hooks_auto_discovered(self, plugin):
        assert len(plugin.hooks) == 2
        hook_names = {h.__name__ for h in plugin.hooks}
        assert "_handle_tool_result" in hook_names
        assert "_on_before_model_call" in hook_names

    def test_raises_on_non_positive_max_result_tokens(self):
        with pytest.raises(ValueError, match="max_result_tokens must be positive"):
            ContextOffloader(storage=InMemoryStorage(), max_result_tokens=0)
        with pytest.raises(ValueError, match="max_result_tokens must be positive"):
            ContextOffloader(storage=InMemoryStorage(), max_result_tokens=-1)

    def test_raises_on_negative_preview_tokens(self):
        with pytest.raises(ValueError, match="preview_tokens must be non-negative"):
            ContextOffloader(storage=InMemoryStorage(), preview_tokens=-1)

    def test_raises_on_preview_tokens_gte_max_result_tokens(self):
        with pytest.raises(ValueError, match="preview_tokens must be less than max_result_tokens"):
            ContextOffloader(storage=InMemoryStorage(), max_result_tokens=100, preview_tokens=100)
        with pytest.raises(ValueError, match="preview_tokens must be less than max_result_tokens"):
            ContextOffloader(storage=InMemoryStorage(), max_result_tokens=100, preview_tokens=200)

    @pytest.mark.asyncio
    async def test_offloads_oversized_text(self, plugin, storage, mock_agent):
        large_text = "a" * 200
        event = _make_event(mock_agent, large_text)

        await plugin._handle_tool_result(event)

        result_text = event.result["content"][0]["text"]
        assert "[Offloaded:" in result_text
        # Preview should be shorter than the full text
        assert len(result_text) < len(large_text) + 500  # preview + metadata < original + overhead

        # Verify stored content
        assert len(storage._store) == 1
        ref = list(storage._store.keys())[0]
        content, content_type = await storage.retrieve(ref)
        assert content == large_text.encode("utf-8")
        assert content_type == "text/plain"

    @pytest.mark.asyncio
    async def test_preserves_status_and_tool_use_id(self, plugin, mock_agent):
        event = _make_event(mock_agent, "x" * 200, status="error", tool_use_id="my_tool_456")

        await plugin._handle_tool_result(event)

        assert event.result["status"] == "error"
        assert event.result["toolUseId"] == "my_tool_456"

    @pytest.mark.asyncio
    async def test_under_threshold_passes_through(self, plugin, mock_agent):
        small_text = "x" * 50  # 12.5 tokens, under 25
        event = _make_event(mock_agent, small_text)
        original_content = event.result["content"]

        await plugin._handle_tool_result(event)

        assert event.result["content"] is original_content

    @pytest.mark.asyncio
    async def test_at_threshold_passes_through(self, plugin, mock_agent):
        exact_text = "x" * 100  # exactly 25 tokens
        event = _make_event(mock_agent, exact_text)
        original_content = event.result["content"]

        await plugin._handle_tool_result(event)

        assert event.result["content"] is original_content

    @pytest.mark.asyncio
    async def test_skips_cancelled_tool_calls(self, plugin, mock_agent):
        large_text = "x" * 200
        event = _make_event(mock_agent, large_text, cancel_message="tool cancelled by user")
        original_content = event.result["content"]

        await plugin._handle_tool_result(event)

        assert event.result["content"] is original_content

    @pytest.mark.asyncio
    async def test_skips_retrieve_tool_results_when_enabled(self, storage, mock_agent):
        plugin = ContextOffloader(storage=storage, max_result_tokens=25, preview_tokens=10, include_retrieval_tool=True)
        large_text = "x" * 200
        result = {"toolUseId": "tool_123", "status": "success", "content": [{"text": large_text}]}
        tool_use = {"toolUseId": "tool_123", "name": plugin.retrieve_offloaded_content.tool_name, "input": {}}
        event = AfterToolCallEvent(
            agent=mock_agent,
            selected_tool=None,
            tool_use=tool_use,
            invocation_state={},
            result=result,
        )
        await plugin._handle_tool_result(event)

        assert event.result["content"][0]["text"] == large_text

    @pytest.mark.asyncio
    async def test_does_not_skip_retrieve_tool_when_disabled(self, plugin, storage, mock_agent):
        large_text = "x" * 200
        result = {"toolUseId": "tool_123", "status": "success", "content": [{"text": large_text}]}
        tool_use = {"toolUseId": "tool_123", "name": "retrieve_offloaded_content", "input": {}}
        event = AfterToolCallEvent(
            agent=mock_agent,
            selected_tool=None,
            tool_use=tool_use,
            invocation_state={},
            result=result,
        )
        await plugin._handle_tool_result(event)

        # Tool is disabled, so the result should be offloaded normally
        assert "[Offloaded:" in event.result["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_image_only_content_passes_through(self, plugin, mock_agent):
        content = [{"image": {"format": "png", "source": {"bytes": b"fake"}}}]
        event = _make_event(mock_agent, content)
        original_content = event.result["content"]

        await plugin._handle_tool_result(event)

        assert event.result["content"] is original_content

    @pytest.mark.asyncio
    async def test_image_stored_and_placeholder_has_ref(self, plugin, storage, mock_agent):
        img_bytes = b"\x89PNG" + b"\x00" * 100
        content = [
            {"text": "x" * 200},
            {"image": {"format": "png", "source": {"bytes": img_bytes}}},
        ]
        event = _make_event(mock_agent, content)

        await plugin._handle_tool_result(event)

        # Should have preview + image placeholder
        assert len(event.result["content"]) == 2
        placeholder = event.result["content"][1]["text"]
        assert "[image: png, 104 bytes" in placeholder
        assert "ref:" in placeholder

        # Verify image was stored
        assert len(storage._store) == 2  # text + image
        img_ref = placeholder.split("ref: ")[1].rstrip("]")
        img_content, img_type = await storage.retrieve(img_ref)
        assert img_content == img_bytes
        assert img_type == "image/png"

    @pytest.mark.asyncio
    async def test_document_stored_and_placeholder_has_ref(self, plugin, storage, mock_agent):
        doc_bytes = b"%PDF-1.4" + b"\x00" * 100
        content = [
            {"text": "x" * 200},
            {"document": {"format": "pdf", "name": "report.pdf", "source": {"bytes": doc_bytes}}},
        ]
        event = _make_event(mock_agent, content)

        await plugin._handle_tool_result(event)

        assert len(event.result["content"]) == 2
        placeholder = event.result["content"][1]["text"]
        assert "[document: pdf, report.pdf, 108 bytes" in placeholder
        assert "ref:" in placeholder

        # Verify document was stored
        doc_ref = placeholder.split("ref: ")[1].rstrip("]")
        doc_content, doc_type = await storage.retrieve(doc_ref)
        assert doc_content == doc_bytes
        assert doc_type == "application/pdf"

    @pytest.mark.asyncio
    async def test_multiple_text_blocks_stored_separately(self, plugin, storage, mock_agent):
        content = [
            {"text": "a" * 60},
            {"text": "b" * 60},
        ]
        event = _make_event(mock_agent, content)

        await plugin._handle_tool_result(event)

        # Two text blocks stored separately
        assert len(storage._store) == 2
        refs = list(storage._store.keys())
        assert await storage.retrieve(refs[0]) == (b"a" * 60, "text/plain")
        assert await storage.retrieve(refs[1]) == (b"b" * 60, "text/plain")

    @pytest.mark.asyncio
    async def test_json_content_stored_as_json(self, plugin, storage, mock_agent):
        large_json = {"data": [{"id": i, "value": "x" * 20} for i in range(10)]}
        content = [{"json": large_json}]
        event = _make_event(mock_agent, content)

        await plugin._handle_tool_result(event)

        assert len(storage._store) == 1
        ref = list(storage._store.keys())[0]
        stored_content, content_type = await storage.retrieve(ref)
        assert content_type == "application/json"
        assert json.loads(stored_content) == large_json

    @pytest.mark.asyncio
    async def test_mixed_text_and_json(self, plugin, storage, mock_agent):
        content = [
            {"text": "a" * 60},
            {"json": {"key": "b" * 60}},
        ]
        event = _make_event(mock_agent, content)

        await plugin._handle_tool_result(event)

        # Both stored separately with correct types
        assert len(storage._store) == 2
        refs = list(storage._store.keys())
        assert (await storage.retrieve(refs[0]))[1] == "text/plain"
        assert (await storage.retrieve(refs[1]))[1] == "application/json"

    @pytest.mark.asyncio
    async def test_small_json_passes_through(self, plugin, mock_agent):
        content = [{"json": {"key": "value"}}]
        event = _make_event(mock_agent, content)
        original_content = event.result["content"]

        await plugin._handle_tool_result(event)

        assert event.result["content"] is original_content

    @pytest.mark.asyncio
    async def test_error_status_still_offloaded(self, plugin, mock_agent):
        large_text = "x" * 200
        event = _make_event(mock_agent, large_text, status="error")

        await plugin._handle_tool_result(event)

        assert "[Offloaded:" in event.result["content"][0]["text"]
        assert event.result["status"] == "error"

    @pytest.mark.asyncio
    async def test_storage_failure_keeps_original(self, mock_agent, caplog):
        failing_storage = MagicMock()
        failing_storage.store.side_effect = RuntimeError("disk full")

        plugin = ContextOffloader(
            storage=failing_storage,
            max_result_tokens=25,
            preview_tokens=10,
        )

        large_text = "x" * 200
        event = _make_event(mock_agent, large_text)

        with caplog.at_level(logging.WARNING):
            await plugin._handle_tool_result(event)

        assert event.result["content"][0]["text"] == large_text
        assert "failed to offload" in caplog.text

    @pytest.mark.asyncio
    async def test_partial_storage_failure_keeps_original(self, mock_agent, caplog):
        storage = MagicMock()
        call_count = 0

        def store_then_fail(key, content, content_type="text/plain"):
            nonlocal call_count
            call_count += 1
            if call_count > 1:
                raise RuntimeError("disk full on second block")
            return f"ref_{call_count}"

        storage.store.side_effect = store_then_fail

        plugin = ContextOffloader(storage=storage, max_result_tokens=25, preview_tokens=10)

        content = [
            {"text": "a" * 60},
            {"text": "b" * 60},
        ]
        event = _make_event(mock_agent, content)

        with caplog.at_level(logging.WARNING):
            await plugin._handle_tool_result(event)

        assert event.result["content"][0]["text"] == "a" * 60
        assert event.result["content"][1]["text"] == "b" * 60
        assert "failed to offload" in caplog.text

    @pytest.mark.asyncio
    async def test_empty_text_blocks_not_stored(self, plugin, storage, mock_agent):
        content = [
            {"text": ""},
            {"text": "x" * 200},
        ]
        event = _make_event(mock_agent, content)

        await plugin._handle_tool_result(event)

        # Empty text block is not in text_preview_parts but still iterated for storage
        # The non-empty block triggers offloading
        assert "[Offloaded:" in event.result["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_document_only_content_passes_through(self, plugin, mock_agent):
        content = [{"document": {"format": "pdf", "name": "report.pdf", "source": {"bytes": b"pdf"}}}]
        event = _make_event(mock_agent, content)
        original_content = event.result["content"]

        await plugin._handle_tool_result(event)

        assert event.result["content"] is original_content

    @pytest.mark.asyncio
    async def test_unknown_content_type_passed_through(self, plugin, mock_agent):
        unknown_block = {"custom_type": {"data": "something"}}
        content = [
            {"text": "x" * 200},
            unknown_block,
        ]
        event = _make_event(mock_agent, content)

        await plugin._handle_tool_result(event)

        # Unknown block should be passed through
        assert event.result["content"][-1] is unknown_block

    @pytest.mark.asyncio
    async def test_all_content_types_mixed(self, plugin, storage, mock_agent):
        large_json = {"rows": [{"id": i} for i in range(20)]}
        img_bytes = b"\x89PNG" + b"\x00" * 100
        doc_bytes = b"%PDF" + b"\x00" * 200
        content = [
            {"text": "a" * 60},
            {"json": large_json},
            {"image": {"format": "png", "source": {"bytes": img_bytes}}},
            {"document": {"format": "pdf", "name": "report.pdf", "source": {"bytes": doc_bytes}}},
        ]
        event = _make_event(mock_agent, content)

        await plugin._handle_tool_result(event)

        result_content = event.result["content"]
        # Preview + image placeholder + document placeholder = 3 blocks
        assert len(result_content) == 3
        assert "[Offloaded:" in result_content[0]["text"]
        assert "[image: png" in result_content[1]["text"]
        assert "[document: pdf, report.pdf" in result_content[2]["text"]

        # All 4 blocks stored
        assert len(storage._store) == 4

    @pytest.mark.asyncio
    async def test_image_without_bytes_kept_in_place(self, plugin, storage, mock_agent):
        content = [
            {"text": "x" * 200},
            {"image": {"format": "png", "source": {}}},
        ]
        event = _make_event(mock_agent, content)

        await plugin._handle_tool_result(event)

        # Only text stored; the image had no bytes to offload so it is left
        # in place rather than replaced with a misleading ``0 bytes`` placeholder.
        # See https://github.com/strands-agents/harness-sdk/issues/4017
        assert len(storage._store) == 1
        result_content = event.result["content"]
        # [0] = preview text, [1] = the original image block (kept as-is)
        assert "image" in result_content[1]
        assert result_content[1]["image"] == {"format": "png", "source": {}}
        assert not any("0 bytes" in (b.get("text", "")) for b in result_content)

    @pytest.mark.asyncio
    async def test_document_without_bytes_kept_in_place(self, plugin, storage, mock_agent):
        # Non-bytes document source (location/text/content) — mirrors issue #4017
        # where the offloader would replace a 5,200-char document with a
        # ``[document: txt, contract, 0 bytes]`` placeholder.
        doc_block = {
            "document": {
                "format": "txt",
                "name": "contract",
                "source": {"location": {"uri": "s3://bucket/contract.txt"}},
            }
        }
        content = [
            {"text": "x" * 200},
            doc_block,
        ]
        event = _make_event(mock_agent, content)

        await plugin._handle_tool_result(event)

        # Only text stored; the document is preserved verbatim.
        assert len(storage._store) == 1
        result_content = event.result["content"]
        assert "document" in result_content[1]
        assert result_content[1]["document"] == doc_block["document"]
        assert not any("[document:" in (b.get("text", "")) for b in result_content)

    @pytest.mark.asyncio
    async def test_mixed_bytes_and_non_bytes_blocks(self, plugin, storage, mock_agent):
        # Bytes document gets stored + ref emitted; non-bytes document is
        # preserved; image without bytes is preserved. Verify the three paths
        # coexist in a single tool result.
        img_bytes = b"\x89PNG" + b"\x00" * 100
        doc_bytes = b"%PDF-1.4" + b"\x00" * 100
        doc_location = {
            "document": {
                "format": "txt",
                "name": "contract",
                "source": {"location": {"uri": "s3://bucket/contract.txt"}},
            }
        }
        content = [
            {"text": "a" * 400},  # 100 tokens > 25 max_result_tokens threshold
            {"image": {"format": "png", "source": {"bytes": img_bytes}}},
            {"document": {"format": "pdf", "name": "report.pdf", "source": {"bytes": doc_bytes}}},
            doc_location,
        ]
        event = _make_event(mock_agent, content)

        await plugin._handle_tool_result(event)

        # text + image + document (bytes) stored; the non-bytes document is preserved.
        assert len(storage._store) == 3

        result_content = event.result["content"]
        # [0] = preview, [1] = image placeholder, [2] = document placeholder,
        # [3] = the original non-bytes document block (kept as-is)
        assert "[Offloaded:" in result_content[0]["text"]
        assert "[image: png" in result_content[1]["text"]
        assert "[document: pdf, report.pdf" in result_content[2]["text"]
        assert result_content[3] == doc_location


class TestRetrievalTool:
    @pytest.fixture
    def storage(self):
        return InMemoryStorage()

    @pytest.fixture
    def plugin(self, storage):
        return ContextOffloader(storage=storage, max_result_tokens=25, preview_tokens=10, include_retrieval_tool=True)

    @pytest.fixture
    def mock_agent(self):
        return MagicMock()

    @pytest.fixture
    def tool_context(self, mock_agent):
        tool_use = ToolUse(toolUseId="retrieve_1", name="retrieve_offloaded_content", input={})
        return ToolContext(tool_use=tool_use, agent=mock_agent, invocation_state={})

    def test_retrieval_tool_registered_when_enabled(self, plugin):
        tool_names = [t.tool_name for t in plugin.tools]
        assert "retrieve_offloaded_content" in tool_names

    def test_retrieval_tool_registered_by_default(self):
        plugin = ContextOffloader(storage=InMemoryStorage())
        plugin.init_agent(MagicMock())
        tool_names = [t.tool_name for t in plugin.tools]
        assert "retrieve_offloaded_content" in tool_names

    def test_retrieval_tool_not_registered_when_disabled(self):
        plugin = ContextOffloader(storage=InMemoryStorage(), include_retrieval_tool=False)
        plugin.init_agent(MagicMock())
        tool_names = [t.tool_name for t in plugin.tools]
        assert "retrieve_offloaded_content" not in tool_names

    @pytest.mark.asyncio
    async def test_retrieve_text_content(self, plugin, storage, tool_context):
        ref = await storage.store("key_1", b"hello world", "text/plain")
        result = await plugin.retrieve_offloaded_content(reference=ref, tool_context=tool_context)
        assert result == "hello world"

    @pytest.mark.asyncio
    async def test_retrieve_json_content(self, plugin, storage, tool_context):
        ref = await storage.store("key_1", b'{"key": "value"}', "application/json")
        result = await plugin.retrieve_offloaded_content(reference=ref, tool_context=tool_context)
        assert result["content"][0]["json"] == {"key": "value"}

    @pytest.mark.asyncio
    async def test_retrieve_large_text_returns_full_content(self, plugin, storage, tool_context):
        large_text = "a" * 50_000
        ref = await storage.store("key_1", large_text.encode("utf-8"), "text/plain")
        result = await plugin.retrieve_offloaded_content(reference=ref, tool_context=tool_context)
        assert result == large_text

    @pytest.mark.asyncio
    async def test_retrieve_missing_reference(self, plugin, tool_context):
        with pytest.raises(ValueError, match="reference not found: nonexistent"):
            await plugin.retrieve_offloaded_content(reference="nonexistent", tool_context=tool_context)

    @pytest.mark.asyncio
    async def test_retrieve_image_content(self, plugin, storage, tool_context):
        img_bytes = b"\x89PNG\x00\x00"
        ref = await storage.store("key_1", img_bytes, "image/png")
        result = await plugin.retrieve_offloaded_content(reference=ref, tool_context=tool_context)
        assert result["status"] == "success"
        assert result["content"][0]["image"]["format"] == "png"
        assert result["content"][0]["image"]["source"]["bytes"] == img_bytes

    @pytest.mark.asyncio
    async def test_retrieve_document_content(self, plugin, storage, tool_context):
        doc_bytes = b"%PDF-1.4 content"
        ref = await storage.store("key_1", doc_bytes, "application/pdf")
        result = await plugin.retrieve_offloaded_content(reference=ref, tool_context=tool_context)
        assert result["status"] == "success"
        assert result["content"][0]["document"]["format"] == "pdf"
        assert result["content"][0]["document"]["source"]["bytes"] == doc_bytes


class TestRetrievalToolSearch:
    """Tests for the search/grep functionality of the retrieval tool."""

    @pytest.fixture
    def storage(self):
        return InMemoryStorage()

    @pytest.fixture
    def plugin(self, storage):
        return ContextOffloader(storage=storage, max_result_tokens=25, preview_tokens=10, include_retrieval_tool=True)

    @pytest.fixture
    def mock_agent(self):
        return MagicMock()

    @pytest.fixture
    def tool_context(self, mock_agent):
        tool_use = ToolUse(toolUseId="retrieve_1", name="retrieve_offloaded_content", input={})
        return ToolContext(tool_use=tool_use, agent=mock_agent, invocation_state={})

    @pytest.mark.asyncio
    async def test_finds_matching_lines_with_context(self, plugin, storage, tool_context):
        content = "\n".join(f"line {i + 1}" for i in range(20))
        ref = await storage.store("k1", content.encode("utf-8"), "text/plain")

        result = await plugin.retrieve_offloaded_content(
            reference=ref, pattern="line 10", context_lines=2, tool_context=tool_context
        )

        assert "1 match for /line 10/" in result
        assert "> 10| line 10" in result
        assert "   8| line 8" in result
        assert "  12| line 12" in result

    @pytest.mark.asyncio
    async def test_returns_line_range_without_pattern(self, plugin, storage, tool_context):
        content = "\n".join(f"line {i + 1}" for i in range(50))
        ref = await storage.store("k1", content.encode("utf-8"), "text/plain")

        result = await plugin.retrieve_offloaded_content(
            reference=ref, line_range={"start": 5, "end": 10}, tool_context=tool_context
        )

        assert "[Lines 5-10 of 50]" in result
        assert "  5| line 5" in result
        assert " 10| line 10" in result
        assert "line 4" not in result
        assert "line 11" not in result

    @pytest.mark.asyncio
    async def test_searches_within_line_range(self, plugin, storage, tool_context):
        content = "\n".join(f"item {i + 1}" for i in range(30))
        ref = await storage.store("k1", content.encode("utf-8"), "text/plain")

        result = await plugin.retrieve_offloaded_content(
            reference=ref,
            pattern="item 1",
            line_range={"start": 10, "end": 20},
            context_lines=0,
            tool_context=tool_context,
        )

        assert "in lines 10-20" in result
        assert "> 10| item 10" in result
        assert "> 11| item 11" in result
        assert "> 1|" not in result

    @pytest.mark.asyncio
    async def test_respects_custom_context_lines(self, plugin, storage, tool_context):
        content = "\n".join(f"line {i + 1}" for i in range(20))
        ref = await storage.store("k1", content.encode("utf-8"), "text/plain")

        result = await plugin.retrieve_offloaded_content(
            reference=ref, pattern="line 10", context_lines=0, tool_context=tool_context
        )

        assert "> 10| line 10" in result
        assert "line 9" not in result
        assert "line 11" not in result

    @pytest.mark.asyncio
    async def test_raises_for_binary_content(self, plugin, storage, tool_context):
        ref = await storage.store("k1", b"\x89PNG", "image/png")

        with pytest.raises(ValueError, match=r"cannot search binary content \(image/png\)"):
            await plugin.retrieve_offloaded_content(reference=ref, pattern="test", tool_context=tool_context)

    @pytest.mark.asyncio
    async def test_falls_back_to_literal_on_invalid_regex(self, plugin, storage, tool_context):
        content = "foo (bar\nbaz\nfoo (bar again"
        ref = await storage.store("k1", content.encode("utf-8"), "text/plain")

        result = await plugin.retrieve_offloaded_content(
            reference=ref, pattern="foo (bar", context_lines=0, tool_context=tool_context
        )

        assert "2 matches" in result
        assert "> 1| foo (bar" in result
        assert "> 3| foo (bar again" in result

    @pytest.mark.asyncio
    async def test_raises_for_missing_reference(self, plugin, tool_context):
        with pytest.raises(ValueError, match="reference not found: nonexistent"):
            await plugin.retrieve_offloaded_content(reference="nonexistent", pattern="test", tool_context=tool_context)

    @pytest.mark.asyncio
    async def test_searches_json_content(self, plugin, storage, tool_context):
        json_str = '{\n  "name": "test",\n  "items": [\n    1,\n    2,\n    3\n  ]\n}'
        ref = await storage.store("k1", json_str.encode("utf-8"), "application/json")

        result = await plugin.retrieve_offloaded_content(
            reference=ref, pattern="items", context_lines=1, tool_context=tool_context
        )

        assert "1 match for /items/" in result
        assert "items" in result

    @pytest.mark.asyncio
    async def test_reports_no_matches(self, plugin, storage, tool_context):
        content = "hello\nworld\n"
        ref = await storage.store("k1", content.encode("utf-8"), "text/plain")

        result = await plugin.retrieve_offloaded_content(
            reference=ref, pattern="nonexistent", tool_context=tool_context
        )

        assert "No matches found for pattern 'nonexistent'" in result

    @pytest.mark.asyncio
    async def test_truncates_when_too_many_matches(self, storage, tool_context):
        plugin = ContextOffloader(
            storage=storage,
            max_result_tokens=50,
            preview_tokens=10,
            include_retrieval_tool=True,
        )
        content = "\n".join(f"match line {i + 1}" for i in range(500))
        ref = await storage.store("k1", content.encode("utf-8"), "text/plain")

        result = await plugin.retrieve_offloaded_content(
            reference=ref, pattern="match", context_lines=0, tool_context=tool_context
        )

        assert "output truncated, narrow your search" in result
        assert len(result) < len(content)

    @pytest.mark.asyncio
    async def test_merges_overlapping_context(self, plugin, storage, tool_context):
        content = "\n".join(f"line {i + 1}" for i in range(10))
        ref = await storage.store("k1", content.encode("utf-8"), "text/plain")

        result = await plugin.retrieve_offloaded_content(
            reference=ref, pattern="line [45]", context_lines=2, tool_context=tool_context
        )

        assert "2 matches" in result
        assert "---" not in result

    @pytest.mark.asyncio
    async def test_line_range_start_beyond_content(self, plugin, storage, tool_context):
        content = "line 1\nline 2\nline 3"
        ref = await storage.store("k1", content.encode("utf-8"), "text/plain")

        with pytest.raises(ValueError, match=r"beyond content length \(3 lines\)"):
            await plugin.retrieve_offloaded_content(
                reference=ref, line_range={"start": 100, "end": 200}, tool_context=tool_context
            )

    @pytest.mark.asyncio
    async def test_clamps_line_range_end(self, plugin, storage, tool_context):
        content = "line 1\nline 2\nline 3"
        ref = await storage.store("k1", content.encode("utf-8"), "text/plain")

        result = await plugin.retrieve_offloaded_content(
            reference=ref, line_range={"start": 2, "end": 100}, tool_context=tool_context
        )

        assert "[Lines 2-3 of 3]" in result
        assert "line 2" in result
        assert "line 3" in result

    @pytest.mark.asyncio
    async def test_returns_first_n_lines_with_only_context_lines(self, storage, tool_context):
        plugin = ContextOffloader(
            storage=storage, max_result_tokens=2500, preview_tokens=10, include_retrieval_tool=True
        )
        content = "\n".join(f"line {i + 1}" for i in range(20))
        ref = await storage.store("k1", content.encode("utf-8"), "text/plain")

        result = await plugin.retrieve_offloaded_content(reference=ref, context_lines=10, tool_context=tool_context)

        assert "[Lines 1-10 of 20]" in result
        assert "line 1" in result
        assert "line 10" in result
        assert "line 11" not in result

    @pytest.mark.asyncio
    async def test_full_retrieval_without_search_params(self, plugin, storage, tool_context):
        content = "hello world"
        ref = await storage.store("k1", content.encode("utf-8"), "text/plain")

        result = await plugin.retrieve_offloaded_content(reference=ref, tool_context=tool_context)

        assert result == "hello world"


class TestRetrievalToolErrorStatus:
    """Retrieval failures surface as tool results with status "error" (#3493).

    A failure reported as status "success" is indistinguishable to the model from
    content that was retrieved successfully.
    """

    @pytest.fixture
    def storage(self):
        return InMemoryStorage()

    @pytest.fixture
    def plugin(self, storage):
        return ContextOffloader(storage=storage, max_result_tokens=25, preview_tokens=10, include_retrieval_tool=True)

    @pytest.fixture
    def mock_agent(self):
        return MagicMock()

    @staticmethod
    async def _tool_result(plugin, mock_agent, alist, tool_input):
        """Invoke the tool the way the event loop does and return the tool result the model sees."""
        tool_use = ToolUse(toolUseId="retrieve_1", name="retrieve_offloaded_content", input=tool_input)
        events = await alist(plugin.retrieve_offloaded_content.stream(tool_use, {"agent": mock_agent}))
        return events[-1].tool_result

    @pytest.mark.asyncio
    async def test_missing_reference_reports_error_status(self, plugin, mock_agent, alist):
        tru_result = await self._tool_result(plugin, mock_agent, alist, {"reference": "nope"})

        exp_result = {
            "toolUseId": "retrieve_1",
            "status": "error",
            "content": [{"text": "Error: reference not found: nope"}],
        }
        assert tru_result == exp_result

    @pytest.mark.asyncio
    async def test_binary_content_search_reports_error_status(self, plugin, storage, mock_agent, alist):
        ref = await storage.store("k1", b"\x89PNG", "image/png")

        tru_result = await self._tool_result(plugin, mock_agent, alist, {"reference": ref, "pattern": "test"})

        exp_result = {
            "toolUseId": "retrieve_1",
            "status": "error",
            "content": [
                {
                    "text": (
                        "Error: cannot search binary content (image/png). "
                        "Omit pattern/line_range/context_lines to retrieve the full content."
                    )
                }
            ],
        }
        assert tru_result == exp_result

    @pytest.mark.asyncio
    async def test_out_of_range_line_range_reports_error_status(self, plugin, storage, mock_agent, alist):
        ref = await storage.store("k1", b"line 1\nline 2", "text/plain")

        tru_result = await self._tool_result(
            plugin, mock_agent, alist, {"reference": ref, "line_range": {"start": 100, "end": 200}}
        )

        exp_result = {
            "toolUseId": "retrieve_1",
            "status": "error",
            "content": [{"text": "Error: line_range.start (100) is beyond content length (2 lines)."}],
        }
        assert tru_result == exp_result

    @pytest.mark.asyncio
    async def test_successful_retrieval_reports_success_status(self, plugin, storage, mock_agent, alist):
        ref = await storage.store("k1", b"hello world", "text/plain")

        tru_result = await self._tool_result(plugin, mock_agent, alist, {"reference": ref})

        exp_result = {"toolUseId": "retrieve_1", "status": "success", "content": [{"text": "hello world"}]}
        assert tru_result == exp_result

    @pytest.mark.asyncio
    async def test_search_without_matches_reports_success_status(self, plugin, storage, mock_agent, alist):
        """A search that finds nothing has succeeded — only genuine failures report an error."""
        ref = await storage.store("k1", b"hello\nworld", "text/plain")

        tru_result = await self._tool_result(plugin, mock_agent, alist, {"reference": ref, "pattern": "absent"})

        assert tru_result["status"] == "success"
        assert "No matches found for pattern 'absent'" in tru_result["content"][0]["text"]


class TestInlineGuidance:
    @pytest.fixture
    def storage(self):
        return InMemoryStorage()

    @pytest.fixture
    def mock_agent(self):
        agent = MagicMock()
        agent.model = MagicMock()
        agent.model.count_tokens = AsyncMock(side_effect=_heuristic_count_tokens)
        return agent

    @pytest.mark.asyncio
    async def test_guidance_mentions_retrieval_tool_when_enabled(self, storage, mock_agent):
        plugin = ContextOffloader(storage=storage, max_result_tokens=25, preview_tokens=10, include_retrieval_tool=True)
        event = _make_event(mock_agent, "x" * 200)
        await plugin._handle_tool_result(event)
        result_text = event.result["content"][0]["text"]
        assert "retrieve_offloaded_content" in result_text
        assert "pattern" in result_text
        assert "line_range" in result_text

    @pytest.mark.asyncio
    async def test_guidance_does_not_mention_retrieval_tool_when_disabled(self, storage, mock_agent):
        plugin = ContextOffloader(
            storage=storage, max_result_tokens=25, preview_tokens=10, include_retrieval_tool=False
        )
        event = _make_event(mock_agent, "x" * 200)
        await plugin._handle_tool_result(event)
        result_text = event.result["content"][0]["text"]
        assert "retrieve_offloaded_content" not in result_text
        assert "available tools" in result_text


class TestActionableReferences:
    """Tests that storage-specific references appear in the offloaded preview."""

    @pytest.mark.asyncio
    async def test_file_storage_path_in_preview(self, tmp_path, mock_agent):
        storage = FileStorage(artifact_dir=str(tmp_path / "artifacts"))
        plugin = ContextOffloader(storage=storage, max_result_tokens=25, preview_tokens=10)
        event = _make_event(mock_agent, "a" * 200)

        await plugin._handle_tool_result(event)

        result_text = event.result["content"][0]["text"]
        assert str(tmp_path / "artifacts") in result_text

    @pytest.mark.asyncio
    async def test_file_storage_image_placeholder_has_path(self, tmp_path, mock_agent):
        storage = FileStorage(artifact_dir=str(tmp_path / "artifacts"))
        plugin = ContextOffloader(storage=storage, max_result_tokens=25, preview_tokens=10)
        img_bytes = b"\x89PNG" + b"\x00" * 100
        content = [
            {"text": "x" * 200},
            {"image": {"format": "png", "source": {"bytes": img_bytes}}},
        ]
        event = _make_event(mock_agent, content)

        await plugin._handle_tool_result(event)

        placeholder = event.result["content"][1]["text"]
        assert str(tmp_path / "artifacts") in placeholder

    @pytest.mark.asyncio
    async def test_inmemory_storage_opaque_reference_in_preview(self, mock_agent):
        storage = InMemoryStorage()
        plugin = ContextOffloader(storage=storage, max_result_tokens=25, preview_tokens=10)
        event = _make_event(mock_agent, "a" * 200)

        await plugin._handle_tool_result(event)

        result_text = event.result["content"][0]["text"]
        assert "mem_" in result_text


class TestBeforeModelCallHook:
    @staticmethod
    def _make_event(cycle_count):
        agent = MagicMock()
        agent.event_loop_metrics.cycle_count = cycle_count
        return BeforeModelCallEvent(agent=agent, invocation_state={})

    @pytest.mark.asyncio
    async def test_calls_evict_with_cycle_count(self):
        storage = InMemoryStorage(evict_after_turns=5)
        plugin = ContextOffloader(storage=storage, max_result_tokens=25, preview_tokens=10)

        await plugin._on_before_model_call(self._make_event(7))

        assert storage._current_cycle == 7

    @pytest.mark.asyncio
    async def test_does_not_crash_on_storage_without_evict(self):
        storage = MagicMock(spec=["store", "retrieve"])
        plugin = ContextOffloader(storage=storage, max_result_tokens=25, preview_tokens=10)

        await plugin._on_before_model_call(self._make_event(1))

    @pytest.mark.asyncio
    async def test_eviction_triggered_via_hook(self):
        storage = InMemoryStorage(evict_after_turns=2)
        plugin = ContextOffloader(storage=storage, max_result_tokens=25, preview_tokens=10)

        ref = await storage.store("key_1", b"content")

        # stored at cycle 0, evict at cycle 3: threshold = 3 - 2 = 1, 0 < 1 → evicted
        await plugin._on_before_model_call(self._make_event(3))
        with pytest.raises(KeyError):
            await storage.retrieve(ref)


class TestUnifiedStorage:
    """Tests for the unified Storage code path (framing, eviction, per-agent scoping)."""

    @pytest.fixture
    def unified_storage(self):
        from strands.storage import InMemoryStorage as UnifiedInMemory

        return UnifiedInMemory()

    @pytest.fixture
    def unified_plugin(self, unified_storage):
        return ContextOffloader(
            storage=unified_storage,
            max_result_tokens=25,
            preview_tokens=10,
            include_retrieval_tool=False,
            evict_after_cycles=3,
        )

    @pytest.fixture
    def unified_mock_agent(self):
        agent = MagicMock()
        agent.model = MagicMock()
        agent.model.count_tokens = AsyncMock(side_effect=_heuristic_count_tokens)
        agent.sandbox = None
        agent.event_loop_metrics.cycle_count = 1
        return agent

    @pytest.mark.asyncio
    async def test_frame_unframe_round_trip(self):
        from strands.vended_plugins.context_offloader.plugin import _frame_content, _unframe_content

        data = b"hello world"
        content_type = "text/plain"
        frame = _frame_content(data, content_type)
        result_data, result_type = _unframe_content(frame)
        assert result_data == data
        assert result_type == content_type

    @pytest.mark.asyncio
    async def test_frame_unframe_binary(self):
        from strands.vended_plugins.context_offloader.plugin import _frame_content, _unframe_content

        data = bytes(range(256))
        content_type = "image/png"
        frame = _frame_content(data, content_type)
        result_data, result_type = _unframe_content(frame)
        assert result_data == data
        assert result_type == content_type

    def test_unframe_truncated_frame_raises(self):
        from strands.vended_plugins.context_offloader.plugin import _unframe_content

        with pytest.raises(ValueError, match="at least 2 bytes"):
            _unframe_content(b"\x00")

    def test_unframe_corrupt_length_raises(self):
        from strands.vended_plugins.context_offloader.plugin import _unframe_content

        # Header claims 255 bytes of content-type but frame is only 4 bytes
        with pytest.raises(ValueError, match="exceeds frame size"):
            _unframe_content(b"\x00\xff\x41\x42")

    @pytest.mark.asyncio
    async def test_offloads_via_unified_storage(self, unified_plugin, unified_storage, unified_mock_agent):
        large_text = "a" * 200
        event = _make_event(unified_mock_agent, large_text)

        await unified_plugin._handle_tool_result(event)

        result_text = event.result["content"][0]["text"]
        assert "[Offloaded:" in result_text
        # Verify content was stored (namespaced under "offloader/")
        keys = await unified_storage.list("")
        assert len(keys) == 1
        assert keys[0].startswith("offloader/")

    @pytest.mark.asyncio
    async def test_retrieve_via_unified_storage(self, unified_storage, unified_mock_agent):
        plugin = ContextOffloader(
            storage=unified_storage,
            max_result_tokens=25,
            preview_tokens=10,
            include_retrieval_tool=True,
        )
        large_text = "hello world " * 50
        event = _make_event(unified_mock_agent, large_text)
        await plugin._handle_tool_result(event)

        # Extract reference from the offloaded result
        result_text = event.result["content"][0]["text"]
        ref_line = [line for line in result_text.split("\n") if "tool_123_0" in line][0]
        ref = ref_line.strip().split(" ")[0]

        tool_context = MagicMock(spec=ToolContext)
        tool_context.agent = unified_mock_agent
        content = await plugin.retrieve_offloaded_content(reference=ref, tool_context=tool_context)
        assert "hello world" in content

    @pytest.mark.asyncio
    async def test_eviction_with_unified_storage(self, unified_storage, unified_mock_agent):
        plugin = ContextOffloader(
            storage=unified_storage,
            max_result_tokens=25,
            preview_tokens=10,
            include_retrieval_tool=False,
            evict_after_cycles=3,
        )

        # Offload at cycle 1
        unified_mock_agent.event_loop_metrics.cycle_count = 1
        event = _make_event(unified_mock_agent, "x" * 200)
        await plugin._handle_tool_result(event)

        keys_before = await unified_storage.list("")
        assert len(keys_before) == 1

        # Cycle 3: not yet stale (stored at 1, threshold = 3-3 = 0, 1 >= 0)
        bmc_event = BeforeModelCallEvent(agent=unified_mock_agent, invocation_state={})
        unified_mock_agent.event_loop_metrics.cycle_count = 3
        await plugin._on_before_model_call(bmc_event)
        assert len(await unified_storage.list("")) == 1

        # Cycle 5: stale (stored at 1, threshold = 5-3 = 2, 1 < 2)
        unified_mock_agent.event_loop_metrics.cycle_count = 5
        await plugin._on_before_model_call(bmc_event)
        assert len(await unified_storage.list("")) == 0

    @pytest.mark.asyncio
    async def test_retrieve_refreshes_eviction_cycle_unified(self, unified_storage, unified_mock_agent):
        """Retrieving offloaded content refreshes its stored cycle for unified Storage
        backends so actively-retrieved entries survive eviction, mirroring
        InMemoryStorage.retrieve's last-access refresh."""
        plugin = ContextOffloader(
            storage=unified_storage,
            max_result_tokens=25,
            preview_tokens=10,
            include_retrieval_tool=True,
            evict_after_cycles=3,
        )

        # Offload at cycle 1 (stored_cycle == 1)
        unified_mock_agent.event_loop_metrics.cycle_count = 1
        event = _make_event(unified_mock_agent, "hello world " * 50)
        await plugin._handle_tool_result(event)

        # Extract the reference from the offloaded placeholder
        result_text = event.result["content"][0]["text"]
        ref_line = [line for line in result_text.split("\n") if "tool_123_0" in line][0]
        ref = ref_line.strip().split(" ")[0]

        # Cycle 3: retrieve -> must refresh stored_cycle to 3
        unified_mock_agent.event_loop_metrics.cycle_count = 3
        tool_context = MagicMock(spec=ToolContext)
        tool_context.agent = unified_mock_agent
        content = await plugin.retrieve_offloaded_content(reference=ref, tool_context=tool_context)
        assert "hello world" in content

        # Cycle 5: without the refresh, stored_cycle=1 < threshold (5-3=2) -> evicted.
        # With the refresh, stored_cycle=3 >= 2 -> survives.
        bmc_event = BeforeModelCallEvent(agent=unified_mock_agent, invocation_state={})
        unified_mock_agent.event_loop_metrics.cycle_count = 5
        await plugin._on_before_model_call(bmc_event)
        assert len(await unified_storage.list("")) == 1, (
            "actively-retrieved entry must survive eviction for unified Storage backends"
        )
        # And remains retrievable
        content_again = await plugin.retrieve_offloaded_content(reference=ref, tool_context=tool_context)
        assert "hello world" in content_again

    @pytest.mark.asyncio
    async def test_eviction_scoped_per_agent(self, unified_storage):
        plugin = ContextOffloader(
            storage=unified_storage,
            max_result_tokens=25,
            preview_tokens=10,
            include_retrieval_tool=False,
            evict_after_cycles=2,
        )

        agent_a = MagicMock()
        agent_a.model = MagicMock()
        agent_a.model.count_tokens = AsyncMock(side_effect=_heuristic_count_tokens)
        agent_a.sandbox = None
        agent_a.event_loop_metrics.cycle_count = 1

        agent_b = MagicMock()
        agent_b.model = MagicMock()
        agent_b.model.count_tokens = AsyncMock(side_effect=_heuristic_count_tokens)
        agent_b.sandbox = None
        agent_b.event_loop_metrics.cycle_count = 1

        # Agent A stores at cycle 1
        event_a = _make_event(agent_a, "a" * 200, tool_use_id="tool_a")
        await plugin._handle_tool_result(event_a)

        # Agent B stores at cycle 1
        event_b = _make_event(agent_b, "b" * 200, tool_use_id="tool_b")
        await plugin._handle_tool_result(event_b)

        assert len(await unified_storage.list("")) == 2

        # Evict agent A at cycle 4 (stored at 1, threshold = 4-2 = 2, 1 < 2)
        agent_a.event_loop_metrics.cycle_count = 4
        bmc_a = BeforeModelCallEvent(agent=agent_a, invocation_state={})
        await plugin._on_before_model_call(bmc_a)

        # Agent A's entry evicted, agent B's remains
        keys = await unified_storage.list("")
        assert len(keys) == 1
        assert "tool_b" in keys[0]

    @pytest.mark.asyncio
    async def test_eviction_disabled_when_none(self, unified_storage, unified_mock_agent):
        plugin = ContextOffloader(
            storage=unified_storage,
            max_result_tokens=25,
            preview_tokens=10,
            include_retrieval_tool=False,
            evict_after_cycles=None,
        )

        unified_mock_agent.event_loop_metrics.cycle_count = 1
        event = _make_event(unified_mock_agent, "x" * 200)
        await plugin._handle_tool_result(event)

        # Even at a very high cycle count, nothing is evicted
        unified_mock_agent.event_loop_metrics.cycle_count = 1000
        bmc = BeforeModelCallEvent(agent=unified_mock_agent, invocation_state={})
        await plugin._on_before_model_call(bmc)
        assert len(await unified_storage.list("")) == 1

    @pytest.mark.asyncio
    async def test_eviction_debug_log_on_delete_failure(self, unified_mock_agent, caplog):

        from strands.storage import InMemoryStorage as UnifiedInMemory

        storage = UnifiedInMemory()
        plugin = ContextOffloader(
            storage=storage,
            max_result_tokens=25,
            preview_tokens=10,
            include_retrieval_tool=False,
            evict_after_cycles=2,
        )

        # Offload at cycle 1
        unified_mock_agent.event_loop_metrics.cycle_count = 1
        event = _make_event(unified_mock_agent, "x" * 200)
        await plugin._handle_tool_result(event)

        # Make the underlying storage's delete fail
        async def failing_delete(key):
            raise RuntimeError("delete failed")

        storage.delete = failing_delete

        unified_mock_agent.event_loop_metrics.cycle_count = 5
        bmc = BeforeModelCallEvent(agent=unified_mock_agent, invocation_state={})
        with caplog.at_level(logging.DEBUG, logger="strands.vended_plugins.context_offloader.plugin"):
            await plugin._on_before_model_call(bmc)

        assert "failed to evict" in caplog.text

    @pytest.mark.asyncio
    async def test_storage_auto_namespaced(self, unified_storage):
        plugin = ContextOffloader(
            storage=unified_storage,
            max_result_tokens=25,
            preview_tokens=10,
        )
        # Internal storage should be namespaced under "offloader/"
        from strands.storage.storage import _NAMESPACED

        assert getattr(plugin._storage, "_namespaced", None) is _NAMESPACED

    @pytest.mark.asyncio
    async def test_pre_namespaced_storage_not_double_namespaced(self):
        from strands.storage import InMemoryStorage as UnifiedInMemory
        from strands.storage.storage import _NamespacedStorage

        raw = UnifiedInMemory()
        pre_namespaced = _NamespacedStorage(raw, "custom")
        plugin = ContextOffloader(
            storage=pre_namespaced,
            max_result_tokens=25,
            preview_tokens=10,
        )
        # Should use the pre-namespaced storage as-is
        assert plugin._storage is pre_namespaced

    def test_raises_on_invalid_evict_after_cycles(self):
        with pytest.raises(ValueError, match="evict_after_cycles must be a positive integer"):
            ContextOffloader(
                storage=MagicMock(spec=["store", "retrieve"]),
                max_result_tokens=25,
                preview_tokens=10,
                evict_after_cycles=0,
            )
        with pytest.raises(ValueError, match="evict_after_cycles must be a positive integer"):
            ContextOffloader(
                storage=MagicMock(spec=["store", "retrieve"]),
                max_result_tokens=25,
                preview_tokens=10,
                evict_after_cycles=-1,
            )


class TestShouldOffloadCallback:
    """Tests for the should_offload callback parameter."""

    @pytest.fixture
    def storage(self):
        return InMemoryStorage()

    @pytest.fixture
    def mock_agent(self):
        agent = MagicMock()
        agent.model = MagicMock()
        agent.model.count_tokens = AsyncMock(side_effect=_heuristic_count_tokens)
        return agent

    @pytest.mark.asyncio
    async def test_callback_receives_tool_name_and_token_count(self, storage, mock_agent):
        received_args = []

        def capture_args(tool_name, token_count, **kwargs):
            received_args.append((tool_name, token_count))
            return True

        plugin = ContextOffloader(
            storage=storage,
            max_result_tokens=25,
            preview_tokens=10,
            include_retrieval_tool=False,
            should_offload=capture_args,
        )
        event = _make_event(mock_agent, "x" * 200, tool_name="my_tool")

        await plugin._handle_tool_result(event)

        assert len(received_args) == 1
        assert received_args[0][0] == "my_tool"
        assert received_args[0][1] == 50

    @pytest.mark.asyncio
    async def test_callback_returning_true_offloads(self, storage, mock_agent):
        plugin = ContextOffloader(
            storage=storage,
            max_result_tokens=25,
            preview_tokens=10,
            include_retrieval_tool=False,
            should_offload=lambda name, tokens, **kwargs: True,
        )
        event = _make_event(mock_agent, "x" * 200, tool_name="large_tool")

        await plugin._handle_tool_result(event)

        assert "[Offloaded:" in event.result["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_callback_returning_false_skips_offload(self, storage, mock_agent):
        plugin = ContextOffloader(
            storage=storage,
            max_result_tokens=25,
            preview_tokens=10,
            include_retrieval_tool=False,
            should_offload=lambda name, tokens, **kwargs: False,
        )
        large_text = "x" * 200
        event = _make_event(mock_agent, large_text, tool_name="search_tool")

        await plugin._handle_tool_result(event)

        assert event.result["content"][0]["text"] == large_text
        assert len(storage._store) == 0

    @pytest.mark.asyncio
    async def test_callback_filters_by_tool_name(self, storage, mock_agent):
        plugin = ContextOffloader(
            storage=storage,
            max_result_tokens=25,
            preview_tokens=10,
            include_retrieval_tool=False,
            should_offload=lambda name, tokens, **kwargs: name == "get_document_text",
        )
        large_text = "x" * 200

        event1 = _make_event(mock_agent, large_text, tool_use_id="t1", tool_name="get_document_text")
        await plugin._handle_tool_result(event1)
        assert "[Offloaded:" in event1.result["content"][0]["text"]

        event2 = _make_event(mock_agent, large_text, tool_use_id="t2", tool_name="search_opensearch")
        await plugin._handle_tool_result(event2)
        assert event2.result["content"][0]["text"] == large_text

    @pytest.mark.asyncio
    async def test_none_callback_offloads_all(self, storage, mock_agent):
        plugin = ContextOffloader(
            storage=storage,
            max_result_tokens=25,
            preview_tokens=10,
            include_retrieval_tool=False,
            should_offload=None,
        )
        event = _make_event(mock_agent, "x" * 200, tool_name="any_tool")

        await plugin._handle_tool_result(event)

        assert "[Offloaded:" in event.result["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_callback_not_called_when_under_threshold(self, storage, mock_agent):
        call_count = {"n": 0}

        def counting_callback(name, tokens, **kwargs):
            call_count["n"] += 1
            return True

        plugin = ContextOffloader(
            storage=storage,
            max_result_tokens=25,
            preview_tokens=10,
            include_retrieval_tool=False,
            should_offload=counting_callback,
        )
        event = _make_event(mock_agent, "short", tool_name="small_tool")

        await plugin._handle_tool_result(event)

        assert call_count["n"] == 0

    @pytest.mark.asyncio
    async def test_raising_callback_falls_back_to_offload(self, storage, mock_agent):
        def boom(tool_name, token_count, **kwargs):
            raise RuntimeError("boom")

        plugin = ContextOffloader(
            storage=storage,
            max_result_tokens=25,
            preview_tokens=10,
            include_retrieval_tool=False,
            should_offload=boom,
        )
        event = _make_event(mock_agent, "x" * 200, tool_name="my_tool")

        await plugin._handle_tool_result(event)

        assert "[Offloaded:" in event.result["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_async_callback_returning_false_skips_offload(self, storage, mock_agent):
        async def never(tool_name, token_count, **kwargs):
            return False

        plugin = ContextOffloader(
            storage=storage,
            max_result_tokens=25,
            preview_tokens=10,
            include_retrieval_tool=False,
            should_offload=never,
        )
        large_text = "x" * 200
        event = _make_event(mock_agent, large_text, tool_name="search_tool")

        await plugin._handle_tool_result(event)

        assert event.result["content"][0]["text"] == large_text
        assert len(storage._store) == 0

    @pytest.mark.asyncio
    async def test_async_callback_returning_true_offloads(self, storage, mock_agent):
        async def always(tool_name, token_count, **kwargs):
            return True

        plugin = ContextOffloader(
            storage=storage,
            max_result_tokens=25,
            preview_tokens=10,
            include_retrieval_tool=False,
            should_offload=always,
        )
        event = _make_event(mock_agent, "x" * 200, tool_name="large_tool")

        await plugin._handle_tool_result(event)

        assert "[Offloaded:" in event.result["content"][0]["text"]

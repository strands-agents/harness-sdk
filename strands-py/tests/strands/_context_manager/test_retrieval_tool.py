"""Tests for the retrieve_context tool."""

import json

import pytest

from strands._context_manager.retrieval_tool import (
    RETRIEVAL_TOOL_NAME,
    _block_text,
    _create_retrieval_tool,
    _track_retrieval_tool_use_ids,
)
from strands.types.content import ContentBlock, Message
from strands.types.tools import ToolUse

_IMAGE = {"image": {"format": "png", "source": {"bytes": "UE5HX0RBVEE="}}}
"""An image as the stash holds it, its bytes base64-encoded."""


def _encode(value):
    return json.dumps(value).encode("utf-8")


async def _store(stash, block_id, block_index, value):
    return await stash.store(block_id, block_index, _encode(value))


async def _invoke(stash, inputs, max_result_tokens=None):
    tool = _create_retrieval_tool(stash, max_result_tokens)
    return await tool._tool_func({"toolUseId": "t1", "input": inputs})


def _text(result, index=0):
    return result["content"][index]["text"]


class TestRetrievalTool:
    def test_has_the_correct_tool_name(self, stash):
        assert _create_retrieval_tool(stash).tool_name == RETRIEVAL_TOOL_NAME

    @pytest.mark.asyncio
    async def test_retrieves_full_text_content(self, stash):
        reference = await _store(stash, "tool-1", 0, {"text": "hello world\nline two"})

        result = await _invoke(stash, {"reference": reference})

        assert result["status"] == "success"
        assert result["content"] == [{"text": "hello world\nline two"}]

    @pytest.mark.asyncio
    async def test_searches_with_pattern(self, stash):
        lines = "\n".join(f"line {index + 1}: {'ERROR' if index % 3 == 0 else 'ok'}" for index in range(20))
        reference = await _store(stash, "tool-1", 0, {"text": lines})

        result = await _invoke(stash, {"reference": reference, "pattern": "ERROR"})

        assert result["status"] == "success"
        assert "ERROR" in _text(result)
        assert "match" in _text(result)

    @pytest.mark.asyncio
    async def test_returns_line_range(self, stash):
        lines = "\n".join(f"line {index + 1}" for index in range(50))
        reference = await _store(stash, "tool-1", 0, {"text": lines})

        result = await _invoke(stash, {"reference": reference, "line_range": {"start": 5, "end": 10}})

        assert result["status"] == "success"
        assert "line 5" in _text(result)
        assert "line 10" in _text(result)
        assert "line 11" not in _text(result)

    @pytest.mark.asyncio
    async def test_returns_error_for_unknown_reference(self, stash):
        result = await _invoke(stash, {"reference": "[ref: nonexistent]"})

        assert result["status"] == "error"
        assert _text(result) == (
            'Error: reference not found: [ref: nonexistent]. Pass only the <id> from the placeholder\'s "[ref: <id>]".'
        )

    @pytest.mark.asyncio
    async def test_ignores_whitespace_around_the_reference(self, stash):
        await _store(stash, "tool-1", 0, {"text": "original"})

        result = await _invoke(stash, {"reference": " tool-1 "})

        assert result["content"] == [{"text": "original"}]

    @pytest.mark.asyncio
    async def test_returns_stored_text_that_only_looks_like_a_placeholder(self, stash):
        await _store(stash, "tool-1", 0, {"text": "[Dropped] [ref: tool-2]"})

        result = await _invoke(stash, {"reference": "tool-1"})

        assert result["content"] == [{"text": "[Dropped] [ref: tool-2]"}]

    @pytest.mark.asyncio
    async def test_restores_image_content_as_media(self, stash):
        reference = await _store(stash, "tool-img", 0, _IMAGE)

        result = await _invoke(stash, {"reference": reference})

        assert result["content"] == [{"image": {"format": "png", "source": {"bytes": b"PNG_DATA"}}}]

    @pytest.mark.asyncio
    async def test_restores_document_content_as_media(self, stash):
        document = {"document": {"format": "pdf", "source": {"bytes": "UERGX0RBVEE="}}}
        reference = await _store(stash, "tool-doc", 0, document)

        result = await _invoke(stash, {"reference": reference})

        assert result["content"] == [{"document": {"format": "pdf", "source": {"bytes": b"PDF_DATA"}}}]

    @pytest.mark.asyncio
    async def test_retrieves_json_content_as_a_parsed_object(self, stash):
        json_value = {"key": "value", "nested": [1, 2, 3]}
        reference = await _store(stash, "tool-json", 0, {"json": json_value})

        result = await _invoke(stash, {"reference": reference})

        assert result["content"] == [{"json": json_value}]

    @pytest.mark.asyncio
    async def test_returns_error_when_searching_non_text_content(self, stash):
        reference = await _store(stash, "tool-img", 0, _IMAGE)

        result = await _invoke(stash, {"reference": reference, "pattern": "test"})

        assert result["status"] == "error"
        assert "cannot search non-text content" in _text(result)

    @pytest.mark.asyncio
    async def test_truncates_text_longer_than_the_result_budget(self, stash):
        reference = await _store(stash, "tool-1", 0, {"text": "x" * 50_000})

        result = await _invoke(stash, {"reference": reference}, max_result_tokens=10)

        assert result["status"] == "success"
        assert _text(result) == f"{'x' * 40}\n\n[truncated]"


class TestToolResultReferencedByItsToolUseId:
    async def _store_items(self, stash):
        await _store(stash, "tool-1", 2, {"text": "third ERROR"})
        await _store(stash, "tool-1", 0, {"text": "first"})
        await _store(stash, "tool-1", 1, {"json": {"count": 2}})
        await _store(stash, "tool-10", 0, {"text": "another tool"})

    @pytest.mark.asyncio
    async def test_returns_every_stored_item_in_index_order(self, stash):
        await self._store_items(stash)

        result = await _invoke(stash, {"reference": "tool-1"})

        assert result["content"] == [{"text": "first"}, {"json": {"count": 2}}, {"text": "third ERROR"}]

    @pytest.mark.asyncio
    async def test_leaves_out_the_textual_items_after_the_one_that_exhausts_the_budget(self, stash):
        await _store(stash, "tool-1", 0, {"text": "a" * 30})
        await _store(stash, "tool-1", 1, {"text": "b" * 30})
        await _store(stash, "tool-1", 2, {"text": "c" * 5})

        result = await _invoke(stash, {"reference": "tool-1"}, max_result_tokens=10)

        assert result["content"] == [{"text": "a" * 30}, {"text": f"{'b' * 10}\n\n[truncated]"}]

    @pytest.mark.asyncio
    async def test_returns_media_as_media_and_cuts_only_the_text(self, stash):
        await _store(stash, "tool-1", 0, _IMAGE)
        await _store(stash, "tool-1", 1, {"text": "x" * 100})

        result = await _invoke(stash, {"reference": "tool-1"}, max_result_tokens=10)

        assert result["content"][0] == {"image": {"format": "png", "source": {"bytes": b"PNG_DATA"}}}
        assert result["content"][1] == {"text": f"{'x' * 40}\n\n[truncated]"}

    @pytest.mark.asyncio
    async def test_searches_across_the_items_text(self, stash):
        await self._store_items(stash)

        result = await _invoke(stash, {"reference": "tool-1", "pattern": "ERROR"})

        assert "third ERROR" in _text(result)
        assert "another tool" not in _text(result)

    @pytest.mark.asyncio
    async def test_resolves_an_id_before_an_exact_key_whose_stem_is_another_id(self, stash):
        await _store(stash, "tool", 0, {"text": "tool item 0"})
        await _store(stash, "tool", 1, {"text": "tool item 1"})
        await _store(stash, "tool_1", 0, {"text": "tool_1 item 0"})
        await _store(stash, "tool_1", 1, {"text": "tool_1 item 1"})

        by_id = await _invoke(stash, {"reference": "tool_1"})
        by_key = await _invoke(stash, {"reference": "tool_1_1"})

        assert by_id["content"] == [{"text": "tool_1 item 0"}, {"text": "tool_1 item 1"}]
        assert by_key["content"] == [{"text": "tool_1 item 1"}]

    @pytest.mark.asyncio
    async def test_matches_the_id_exactly_when_ids_contain_underscores_and_digits(self, stash):
        await _store(stash, "call", 0, {"text": "bare"})
        await _store(stash, "call_12", 0, {"text": "twelve"})

        assert (await _invoke(stash, {"reference": "call"}))["content"] == [{"text": "bare"}]
        assert (await _invoke(stash, {"reference": "call_12"}))["content"] == [{"text": "twelve"}]

    @pytest.mark.asyncio
    @pytest.mark.parametrize("extra_input", [{}, {"pattern": "Dropped"}])
    async def test_refuses_to_serve_a_stored_placeholder_as_the_original(self, stash, extra_input):
        """A stashed placeholder is never served as its original (#5620)."""
        placeholder = {"text": "[Dropped] [ref: tool-1]", "offloaded": {"method": "drop", "ref": "tool-1"}}
        await _store(stash, "tool-1", 0, placeholder)

        result = await _invoke(stash, {"reference": "tool-1", **extra_input})

        assert result["status"] == "error"
        assert _text(result) == "Error: original content for reference tool-1 is no longer available"


class TestRemovedMessages:
    REMOVED = [
        {"role": "user", "content": [{"text": "alpha"}], "tracking_id": "r0"},
        {
            "role": "assistant",
            "content": [{"toolUse": {"toolUseId": "t", "name": "x", "input": {}}}],
            "tracking_id": "r1",
        },
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "t",
                        "status": "success",
                        "content": [{"text": "beta ERROR"}, {"json": 1}],
                    }
                }
            ],
            "tracking_id": "r2",
        },
    ]

    @pytest.mark.asyncio
    async def test_returns_the_stored_messages_as_role_markers_and_their_content(self, stash):
        await _store(stash, "removed-m1", 0, self.REMOVED)

        result = await _invoke(stash, {"reference": "removed-m1"})

        assert result["content"] == [
            {"text": "\n---\n[user]"},
            {"text": "alpha"},
            {"text": "\n---\n[assistant]"},
            {"text": "[tool call: x] {}"},
            {"text": "\n---\n[user]"},
            {"text": "[tool result: x]"},
            {"text": "beta ERROR"},
            {"text": "1"},
        ]

    @pytest.mark.asyncio
    async def test_searches_the_stored_messages_text(self, stash):
        await _store(stash, "removed-m1", 0, self.REMOVED)

        result = await _invoke(stash, {"reference": "removed-m1", "pattern": "ERROR"})

        assert "[1 match for /ERROR/]" in _text(result)
        assert "> 2| beta ERROR" in _text(result)

    @pytest.mark.asyncio
    async def test_returns_media_in_the_stored_messages_as_media_and_cuts_only_their_text(self, stash):
        messages = [{"role": "user", "content": [_IMAGE, {"text": "x" * 100}]}]
        await _store(stash, "removed-m1", 0, messages)

        result = await _invoke(stash, {"reference": "removed-m1"}, max_result_tokens=10)

        marker = "\n---\n[user]"
        assert result["content"][0] == {"text": marker}
        assert result["content"][1] == {"image": {"format": "png", "source": {"bytes": b"PNG_DATA"}}}
        assert result["content"][2] == {"text": f"{'x' * (40 - len(marker))}\n\n[truncated]"}


class TestInvalidLineRange:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("line_range", [{"end": 2}, {"start": "abc", "end": 2}])
    async def test_returns_error_for_a_malformed_line_range(self, stash, line_range):
        reference = await _store(stash, "tool-1", 0, {"text": "line 1\nline 2"})

        result = await _invoke(stash, {"reference": reference, "line_range": line_range})

        assert result["status"] == "error"
        assert "invalid line_range" in _text(result)

    @pytest.mark.asyncio
    async def test_returns_error_for_an_out_of_range_span(self, stash):
        reference = await _store(stash, "tool-1", 0, {"text": "line 1\nline 2\nline 3"})

        result = await _invoke(stash, {"reference": reference, "line_range": {"start": 100, "end": 5}})

        assert result["status"] == "error"


class TestBlockText:
    """Tests for the searchable text a block holds."""

    def test_reads_a_text_block(self):
        assert _block_text({"text": "hello"}) == "hello"

    def test_renders_json_as_text(self):
        assert _block_text({"json": {"key": "val"}}) == '{\n  "key": "val"\n}'

    def test_joins_a_tool_results_items(self):
        block = {"toolResult": {"toolUseId": "t", "status": "success", "content": [{"text": "a"}, {"text": "b"}]}}
        assert _block_text(block) == "a\nb"

    def test_joins_cited_text(self):
        block = {"citationsContent": {"content": [{"text": "cited"}]}}
        assert _block_text(block) == "cited"

    def test_returns_none_for_non_text_content(self):
        assert _block_text(_IMAGE) is None


class TestTrackRetrievalToolUseIds:
    def test_tracks_retrieve_context_tool_use_ids(self):
        skip_set: set[str] = set()
        message = Message(
            role="assistant",
            content=[ContentBlock(toolUse=ToolUse(toolUseId="tu-ret", name=RETRIEVAL_TOOL_NAME, input={}))],
        )

        _track_retrieval_tool_use_ids(message, skip_set)

        assert skip_set == {"tu-ret"}

    def test_ignores_non_retrieval_tool_uses(self):
        skip_set: set[str] = set()
        message = Message(
            role="assistant",
            content=[ContentBlock(toolUse=ToolUse(toolUseId="tu-other", name="bash", input={}))],
        )

        _track_retrieval_tool_use_ids(message, skip_set)

        assert skip_set == set()

    def test_ignores_user_messages(self):
        skip_set: set[str] = set()

        _track_retrieval_tool_use_ids(Message(role="user", content=[ContentBlock(text="hello")]), skip_set)

        assert skip_set == set()

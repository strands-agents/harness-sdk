"""Tests for the retrieve_context tool."""

import json

import pytest

from strands._context_manager.retrieval_tool import (
    RETRIEVAL_TOOL_NAME,
    _block_text,
    _create_retrieval_tool,
    _retrieval_calls_before,
)
from strands.types.content import ContentBlock, Message
from strands.types.tools import ToolUse

_IMAGE = {"image": {"format": "png", "source": {"bytes": "UE5HX0RBVEE="}}}
"""An image as the archive holds it, its bytes base64-encoded."""


def _encode(value):
    return json.dumps(value).encode("utf-8")


async def _store(archive, block_id, block_index, value):
    return await archive.store(block_id, block_index, _encode(value))


async def _invoke(archive, inputs, max_result_tokens=None):
    tool = _create_retrieval_tool(archive, max_result_tokens)
    return await tool._tool_func({"toolUseId": "t1", "input": inputs})


def _text(result, index=0):
    return result["content"][index]["text"]


class TestRetrievalTool:
    def test_has_the_correct_tool_name(self, archive):
        assert _create_retrieval_tool(archive).tool_name == RETRIEVAL_TOOL_NAME

    @pytest.mark.asyncio
    async def test_retrieves_full_text_content(self, archive):
        reference = await _store(archive, "tool-1", 0, {"text": "hello world\nline two"})

        result = await _invoke(archive, {"reference": reference})

        assert result["status"] == "success"
        assert result["content"] == [{"text": "hello world\nline two"}]

    @pytest.mark.asyncio
    async def test_searches_with_pattern(self, archive):
        lines = "\n".join(f"line {index + 1}: {'ERROR' if index % 3 == 0 else 'ok'}" for index in range(20))
        reference = await _store(archive, "tool-1", 0, {"text": lines})

        result = await _invoke(archive, {"reference": reference, "pattern": "ERROR"})

        assert result["status"] == "success"
        assert "ERROR" in _text(result)
        assert "match" in _text(result)

    @pytest.mark.asyncio
    async def test_searches_with_no_surrounding_context(self, archive):
        lines = "\n".join(f"line {index + 1}: {'ERROR' if index % 3 == 0 else 'ok'}" for index in range(20))
        reference = await _store(archive, "tool-1", 0, {"text": lines})

        result = await _invoke(archive, {"reference": reference, "pattern": "ERROR", "context_lines": 0})

        assert result["status"] == "success"
        assert "ERROR" in _text(result)
        assert "ok" not in _text(result)

    @pytest.mark.asyncio
    async def test_returns_line_range(self, archive):
        lines = "\n".join(f"line {index + 1}" for index in range(50))
        reference = await _store(archive, "tool-1", 0, {"text": lines})

        result = await _invoke(archive, {"reference": reference, "line_range": {"start": 5, "end": 10}})

        assert result["status"] == "success"
        assert "line 5" in _text(result)
        assert "line 10" in _text(result)
        assert "line 11" not in _text(result)

    @pytest.mark.asyncio
    async def test_returns_error_for_unknown_reference(self, archive):
        result = await _invoke(archive, {"reference": "[ref: nonexistent]"})

        assert result["status"] == "error"
        assert _text(result) == (
            'Error: reference not found: [ref: nonexistent]. Pass only the <id> from the placeholder\'s "[ref: <id>]".'
        )

    @pytest.mark.asyncio
    async def test_ignores_whitespace_around_the_reference(self, archive):
        await _store(archive, "tool-1", 0, {"text": "original"})

        result = await _invoke(archive, {"reference": " tool-1 "})

        assert result["content"] == [{"text": "original"}]

    @pytest.mark.asyncio
    async def test_returns_stored_text_that_only_looks_like_a_placeholder(self, archive):
        await _store(archive, "tool-1", 0, {"text": "[Dropped] [ref: tool-2]"})

        result = await _invoke(archive, {"reference": "tool-1"})

        assert result["content"] == [{"text": "[Dropped] [ref: tool-2]"}]

    @pytest.mark.asyncio
    async def test_restores_image_content_as_media(self, archive):
        reference = await _store(archive, "tool-img", 0, _IMAGE)

        result = await _invoke(archive, {"reference": reference})

        assert result["content"] == [{"image": {"format": "png", "source": {"bytes": b"PNG_DATA"}}}]

    @pytest.mark.asyncio
    async def test_restores_document_content_as_media(self, archive):
        document = {"document": {"format": "pdf", "source": {"bytes": "UERGX0RBVEE="}}}
        reference = await _store(archive, "tool-doc", 0, document)

        result = await _invoke(archive, {"reference": reference})

        assert result["content"] == [{"document": {"format": "pdf", "source": {"bytes": b"PDF_DATA"}}}]

    @pytest.mark.asyncio
    async def test_retrieves_json_content_as_a_parsed_object(self, archive):
        json_value = {"key": "value", "nested": [1, 2, 3]}
        reference = await _store(archive, "tool-json", 0, {"json": json_value})

        result = await _invoke(archive, {"reference": reference})

        assert result["content"] == [{"json": json_value}]

    @pytest.mark.asyncio
    async def test_returns_error_when_searching_non_text_content(self, archive):
        reference = await _store(archive, "tool-img", 0, _IMAGE)

        result = await _invoke(archive, {"reference": reference, "pattern": "test"})

        assert result["status"] == "error"
        assert "cannot search non-text content" in _text(result)

    @pytest.mark.asyncio
    async def test_truncates_text_longer_than_the_result_budget(self, archive):
        reference = await _store(archive, "tool-1", 0, {"text": "x" * 50_000})

        result = await _invoke(archive, {"reference": reference}, max_result_tokens=10)

        assert result["status"] == "success"
        assert _text(result) == f"{'x' * 40}\n\n[truncated]"


class TestToolResultReferencedByItsToolUseId:
    async def _store_items(self, archive):
        await _store(archive, "tool-1", 2, {"text": "third ERROR"})
        await _store(archive, "tool-1", 0, {"text": "first"})
        await _store(archive, "tool-1", 1, {"json": {"count": 2}})
        await _store(archive, "tool-10", 0, {"text": "another tool"})

    @pytest.mark.asyncio
    async def test_returns_every_stored_item_in_index_order(self, archive):
        await self._store_items(archive)

        result = await _invoke(archive, {"reference": "tool-1"})

        assert result["content"] == [{"text": "first"}, {"json": {"count": 2}}, {"text": "third ERROR"}]

    @pytest.mark.asyncio
    async def test_leaves_out_the_textual_items_after_the_one_that_exhausts_the_budget(self, archive):
        await _store(archive, "tool-1", 0, {"text": "a" * 30})
        await _store(archive, "tool-1", 1, {"text": "b" * 30})
        await _store(archive, "tool-1", 2, {"text": "c" * 5})

        result = await _invoke(archive, {"reference": "tool-1"}, max_result_tokens=10)

        assert result["content"] == [{"text": "a" * 30}, {"text": f"{'b' * 10}\n\n[truncated]"}]

    @pytest.mark.asyncio
    async def test_returns_media_as_media_and_cuts_only_the_text(self, archive):
        await _store(archive, "tool-1", 0, _IMAGE)
        await _store(archive, "tool-1", 1, {"text": "x" * 100})

        result = await _invoke(archive, {"reference": "tool-1"}, max_result_tokens=10)

        assert result["content"][0] == {"image": {"format": "png", "source": {"bytes": b"PNG_DATA"}}}
        assert result["content"][1] == {"text": f"{'x' * 40}\n\n[truncated]"}

    @pytest.mark.asyncio
    async def test_searches_across_the_items_text(self, archive):
        await self._store_items(archive)

        result = await _invoke(archive, {"reference": "tool-1", "pattern": "ERROR"})

        assert "third ERROR" in _text(result)
        assert "another tool" not in _text(result)

    @pytest.mark.asyncio
    async def test_resolves_an_id_before_an_exact_key_whose_stem_is_another_id(self, archive):
        await _store(archive, "tool", 0, {"text": "tool item 0"})
        await _store(archive, "tool", 1, {"text": "tool item 1"})
        await _store(archive, "tool_1", 0, {"text": "tool_1 item 0"})
        await _store(archive, "tool_1", 1, {"text": "tool_1 item 1"})

        by_id = await _invoke(archive, {"reference": "tool_1"})
        by_key = await _invoke(archive, {"reference": "tool_1_1"})

        assert by_id["content"] == [{"text": "tool_1 item 0"}, {"text": "tool_1 item 1"}]
        assert by_key["content"] == [{"text": "tool_1 item 1"}]

    @pytest.mark.asyncio
    async def test_matches_the_id_exactly_when_ids_contain_underscores_and_digits(self, archive):
        await _store(archive, "call", 0, {"text": "bare"})
        await _store(archive, "call_12", 0, {"text": "twelve"})

        assert (await _invoke(archive, {"reference": "call"}))["content"] == [{"text": "bare"}]
        assert (await _invoke(archive, {"reference": "call_12"}))["content"] == [{"text": "twelve"}]

    @pytest.mark.asyncio
    @pytest.mark.parametrize("extra_input", [{}, {"pattern": "Dropped"}])
    async def test_refuses_to_serve_a_stored_placeholder_as_the_original(self, archive, extra_input):
        """An archived placeholder is never served as its original (#5620)."""
        placeholder = {"text": "[Dropped] [ref: tool-1]", "offloaded": {"method": "drop", "ref": "tool-1"}}
        await _store(archive, "tool-1", 0, placeholder)

        result = await _invoke(archive, {"reference": "tool-1", **extra_input})

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
    async def test_returns_the_stored_messages_as_role_markers_and_their_content(self, archive):
        await _store(archive, "removed-m1", 0, self.REMOVED)

        result = await _invoke(archive, {"reference": "removed-m1"})

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
    async def test_searches_the_stored_messages_text(self, archive):
        await _store(archive, "removed-m1", 0, self.REMOVED)

        result = await _invoke(archive, {"reference": "removed-m1", "pattern": "ERROR"})

        assert "[1 match for /ERROR/]" in _text(result)
        assert "> 2| beta ERROR" in _text(result)

    @pytest.mark.asyncio
    async def test_returns_media_in_the_stored_messages_as_media_and_cuts_only_their_text(self, archive):
        messages = [{"role": "user", "content": [_IMAGE, {"text": "x" * 100}]}]
        await _store(archive, "removed-m1", 0, messages)

        result = await _invoke(archive, {"reference": "removed-m1"}, max_result_tokens=10)

        marker = "\n---\n[user]"
        assert result["content"][0] == {"text": marker}
        assert result["content"][1] == {"image": {"format": "png", "source": {"bytes": b"PNG_DATA"}}}
        assert result["content"][2] == {"text": f"{'x' * (40 - len(marker))}\n\n[truncated]"}


class TestInvalidLineRange:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("line_range", [{"end": 2}, {"start": "abc", "end": 2}])
    async def test_returns_error_for_a_malformed_line_range(self, archive, line_range):
        reference = await _store(archive, "tool-1", 0, {"text": "line 1\nline 2"})

        result = await _invoke(archive, {"reference": reference, "line_range": line_range})

        assert result["status"] == "error"
        assert "invalid line_range" in _text(result)

    @pytest.mark.asyncio
    async def test_returns_error_for_an_out_of_range_span(self, archive):
        reference = await _store(archive, "tool-1", 0, {"text": "line 1\nline 2\nline 3"})

        result = await _invoke(archive, {"reference": reference, "line_range": {"start": 100, "end": 5}})

        assert result["status"] == "error"


class TestBlockText:
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


class TestRetrievalCallsBefore:
    """Tests for the retrieval calls a message answers, whose results the archive leaves out."""

    @staticmethod
    def _call(tool_use_id: str, name: str) -> Message:
        tool_use = ToolUse(toolUseId=tool_use_id, name=name, input={})
        return Message(role="assistant", content=[ContentBlock(toolUse=tool_use)])

    def test_reads_the_retrieval_calls_of_the_message_before(self):
        messages = [
            self._call("tu-ret", RETRIEVAL_TOOL_NAME),
            Message(role="user", content=[ContentBlock(text="result")]),
        ]

        assert _retrieval_calls_before(messages, 1) == frozenset({"tu-ret"})

    def test_ignores_calls_to_other_tools(self):
        messages = [self._call("tu-other", "bash"), Message(role="user", content=[ContentBlock(text="result")])]

        assert _retrieval_calls_before(messages, 1) == frozenset()

    def test_reads_no_further_back_than_the_message_before(self):
        messages = [
            self._call("tu-ret", RETRIEVAL_TOOL_NAME),
            Message(role="user", content=[ContentBlock(text="result")]),
            Message(role="assistant", content=[ContentBlock(text="done")]),
        ]

        assert _retrieval_calls_before(messages, 2) == frozenset()

    @pytest.mark.parametrize("index", [0, 3, -1])
    def test_holds_nothing_outside_the_history(self, index):
        messages = [self._call("tu-ret", RETRIEVAL_TOOL_NAME), Message(role="user", content=[])]

        assert _retrieval_calls_before(messages, index) == frozenset()

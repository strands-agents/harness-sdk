"""Integration tests for stash + offload strategies."""

import json
import re
import unittest.mock

import pytest

from strands._context_manager.retrieval_tool import _create_retrieval_tool
from strands._context_manager.stash import Stash
from strands._context_manager.strategies.offload import Offload
from strands._context_manager.strategies.offload.drop import DROPPED_MARKER
from strands._context_manager.types import ContextState
from strands.storage.in_memory_storage import InMemoryStorage
from strands.types.content import ContentBlock, Message, Messages
from strands.types.tools import ToolResult, ToolUse


def _make_stream_events(text: str):
    async def gen(*args, **kwargs):
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": text}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}
        yield {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}}}

    return gen


@pytest.fixture
def stash():
    return Stash(InMemoryStorage(), "test-session", "test-agent")


@pytest.fixture
def mock_agent():
    agent = unittest.mock.MagicMock()
    agent.model = unittest.mock.AsyncMock()
    agent.model.count_tokens = unittest.mock.AsyncMock(return_value=5000)
    agent.model.estimate_utilization = unittest.mock.MagicMock(return_value=0.9)
    agent.model.stream = _make_stream_events("Summary of content.")
    agent.messages = []
    return agent


class TestTruncateWithStash:
    """Tests for truncate strategy with stash enabled."""

    @pytest.mark.asyncio
    async def test_includes_stash_ref_in_truncated_text(self, mock_agent, stash):
        strategy = Offload.truncate("*", {"preview_tokens": 100}).when(threshold=200)
        strategy._stash = stash
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="a" * 50000)], tracking_id="track-1"),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5, stash=stash)
        assert await strategy.apply(context) is True
        text = messages[1]["content"][0]["text"]
        assert "[Stashed]" in text
        assert "ref:" in text

    @pytest.mark.asyncio
    async def test_includes_stash_ref_in_truncated_tool_result(self, mock_agent, stash):
        strategy = Offload.truncate("tool_results", {"preview_tokens": 100}).when(threshold=200)
        strategy._stash = stash
        assistant_msg = Message(
            role="assistant",
            content=[ContentBlock(toolUse=ToolUse(toolUseId="tu-1", name="bash", input={}))],
        )
        user_msg = Message(
            role="user",
            content=[
                ContentBlock(
                    toolResult=ToolResult(
                        toolUseId="tu-1",
                        status="success",
                        content=[{"text": "x" * 10000}],
                    )
                )
            ],
        )
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            assistant_msg,
            user_msg,
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5, stash=stash)
        assert await strategy.apply(context) is True
        result_text = messages[2]["content"][0]["toolResult"]["content"][0]["text"]
        assert "[Stashed]" in result_text

    @pytest.mark.asyncio
    async def test_no_stash_ref_without_stash(self, mock_agent):
        strategy = Offload.truncate("*", {"preview_tokens": 100}).when(threshold=200)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="a" * 50000)], tracking_id="track-1"),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        assert await strategy.apply(context) is True
        text = messages[1]["content"][0]["text"]
        assert "[Stashed]" not in text


class TestDropWithStash:
    """Tests for drop strategy with stash enabled."""

    @pytest.mark.asyncio
    async def test_includes_stash_ref_in_dropped_marker(self, mock_agent, stash):
        strategy = Offload.drop("*").when(threshold=100)
        strategy._stash = stash
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="x" * 10000)], tracking_id="track-1"),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5, stash=stash)
        assert await strategy.apply(context) is True
        text = messages[1]["content"][0]["text"]
        assert DROPPED_MARKER in text
        assert "ref:" in text

    @pytest.mark.asyncio
    async def test_includes_stash_ref_in_dropped_tool_result(self, mock_agent, stash):
        strategy = Offload.drop("tool_results").when(threshold=100)
        strategy._stash = stash
        assistant_msg = Message(
            role="assistant",
            content=[ContentBlock(toolUse=ToolUse(toolUseId="tu-1", name="bash", input={}))],
        )
        user_msg = Message(
            role="user",
            content=[
                ContentBlock(
                    toolResult=ToolResult(
                        toolUseId="tu-1",
                        status="success",
                        content=[{"text": "x" * 10000}],
                    )
                )
            ],
        )
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            assistant_msg,
            user_msg,
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5, stash=stash)
        assert await strategy.apply(context) is True
        result_text = messages[2]["content"][0]["toolResult"]["content"][0]["text"]
        assert DROPPED_MARKER in result_text
        assert "ref:" in result_text


class TestEagerStashing:
    """Tests for eager stashing via storeMessage."""

    @pytest.mark.asyncio
    async def test_persists_tool_result_on_arrival(self, stash):
        block = ContentBlock(
            toolResult=ToolResult(
                toolUseId="tu-1",
                status="success",
                content=[{"text": "important data"}],
            )
        )
        message = Message(role="user", content=[block])
        await stash.store_message(message)
        result = await stash.retrieve("tu-1_0")
        assert result is not None
        assert result["text"] == "important data"

    @pytest.mark.asyncio
    async def test_persists_text_blocks_on_arrival(self, stash):
        block = ContentBlock(text="assistant response")
        message = Message(role="assistant", content=[block], tracking_id="track-1")
        await stash.store_message(message)
        result = await stash.retrieve("track-1_0")
        assert result is not None


class TestRetrievalLoopPrevention:
    """Tests for preventing offload of retrieve_context results."""

    @pytest.mark.asyncio
    async def test_does_not_offload_retrieve_context_results_when_stash_active(self, mock_agent, stash):
        strategy = Offload.drop("tool_results").when(threshold=100)
        strategy._stash = stash
        assistant_msg = Message(
            role="assistant",
            content=[ContentBlock(toolUse=ToolUse(toolUseId="tu-ret", name="retrieve_context", input={}))],
        )
        user_msg = Message(
            role="user",
            content=[
                ContentBlock(
                    toolResult=ToolResult(
                        toolUseId="tu-ret",
                        status="success",
                        content=[{"text": "x" * 10000}],
                    )
                )
            ],
        )
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            assistant_msg,
            user_msg,
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5, stash=stash)
        assert await strategy.apply(context) is False

    @pytest.mark.asyncio
    async def test_does_offload_retrieve_context_results_without_stash(self, mock_agent):
        strategy = Offload.drop("tool_results").when(threshold=100)
        assistant_msg = Message(
            role="assistant",
            content=[ContentBlock(toolUse=ToolUse(toolUseId="tu-ret", name="retrieve_context", input={}))],
        )
        user_msg = Message(
            role="user",
            content=[
                ContentBlock(
                    toolResult=ToolResult(
                        toolUseId="tu-ret",
                        status="success",
                        content=[{"text": "x" * 10000}],
                    )
                )
            ],
        )
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            assistant_msg,
            user_msg,
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        assert await strategy.apply(context) is True


class TestSummarizeWithStash:
    """Tests for summarize strategy with stash enabled."""

    @pytest.mark.asyncio
    async def test_includes_stash_ref_in_summarized_tool_result(self, mock_agent, stash):
        strategy = Offload.summarize("tool_results").when(threshold=100)
        strategy._stash = stash
        assistant_msg = Message(
            role="assistant",
            content=[ContentBlock(toolUse=ToolUse(toolUseId="tu-1", name="bash", input={}))],
        )
        user_msg = Message(
            role="user",
            content=[
                ContentBlock(
                    toolResult=ToolResult(
                        toolUseId="tu-1",
                        status="success",
                        content=[{"text": "x" * 10000}],
                    )
                )
            ],
        )
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            assistant_msg,
            user_msg,
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5, stash=stash)
        assert await strategy.apply(context) is True
        result_text = messages[2]["content"][0]["toolResult"]["content"][0]["text"]
        assert "[Summarized:" in result_text
        assert "ref:" in result_text

    @pytest.mark.asyncio
    async def test_includes_stash_ref_in_media_offload_marker(self, mock_agent, stash):
        strategy = Offload.summarize("*").when(threshold=100)
        strategy._stash = stash
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(
                role="user",
                content=[ContentBlock(image={"format": "png", "source": {"bytes": b"img"}})],
                tracking_id="track-1",
            ),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5, stash=stash)
        assert await strategy.apply(context) is True
        text = messages[1]["content"][0]["text"]
        assert "[Summarized:" in text
        assert "ref:" in text


class TestStashRefRoundTrip:
    """Tests proving that a ref left by a strategy resolves via the retrieval tool."""

    @pytest.mark.asyncio
    async def test_truncated_ref_resolves_via_retrieval_tool(self, mock_agent, stash):
        original_text = "x" * 50_000
        strategy = Offload.truncate("tool_results", {"preview_tokens": 100}).when(threshold=200)
        strategy._stash = stash

        assistant_msg = Message(
            role="assistant",
            content=[ContentBlock(toolUse=ToolUse(toolUseId="tu-1", name="bash", input={}))],
        )
        user_msg = Message(
            role="user",
            content=[
                ContentBlock(
                    toolResult=ToolResult(
                        toolUseId="tu-1",
                        status="success",
                        content=[{"text": original_text}],
                    )
                )
            ],
        )
        await stash.store_message(user_msg)

        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            assistant_msg,
            user_msg,
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5, stash=stash)
        await strategy.apply(context)

        result_text = messages[2]["content"][0]["toolResult"]["content"][0]["text"]
        ref_match = re.search(r"ref: ([^\s\]]+)", result_text)
        assert ref_match is not None
        ref = ref_match.group(1)

        tool = _create_retrieval_tool(stash, max_result_tokens=100_000)
        retrieval_result = await tool._tool_func({"toolUseId": "t-ret", "input": {"reference": ref}})
        assert retrieval_result["status"] == "success"
        parsed = json.loads(retrieval_result["content"][0]["text"])
        assert parsed["text"] == original_text

"""Tests for the SummarizeStrategy."""

import unittest.mock

import pytest

from strands._context_manager.strategies.offload import Offload
from strands._context_manager.types import ContextState
from strands.types.content import ContentBlock, Message, Messages
from strands.types.tools import ToolResult


def _make_stream_events(text: str):
    """Create async generator of stream events."""

    async def gen(*args, **kwargs):
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": text}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}
        yield {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}}}

    return gen


def _make_empty_stream():
    """Create async generator that returns an empty response."""

    async def gen(*args, **kwargs):
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": ""}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}
        yield {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 0, "totalTokens": 10}}}

    return gen


@pytest.fixture
def mock_agent():
    agent = unittest.mock.MagicMock()
    agent.model = unittest.mock.AsyncMock()
    agent.model.supports_compaction = False
    agent.model.count_tokens = unittest.mock.AsyncMock(return_value=5000)
    agent.model.estimate_utilization = unittest.mock.MagicMock(return_value=0.9)
    agent.model.stream = _make_stream_events("Summary of content.")
    agent.aux_model = agent.model
    agent.messages = []
    return agent


class TestSummarizeStrategyPerBlock:
    """Tests for per-block summarization."""

    @pytest.mark.asyncio
    async def test_summarizes_large_tool_result(self, mock_agent):
        strategy = Offload.summarize("tool_results").when(threshold=100)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(
                role="user",
                content=[
                    ContentBlock(
                        toolResult=ToolResult(
                            toolUseId="t1",
                            status="success",
                            content=[{"text": "x" * 10000}],
                        )
                    )
                ],
            ),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        assert await strategy.apply(context) is True
        result_text = messages[1]["content"][0]["toolResult"]["content"][0]["text"]
        assert "[Summarized:" in result_text
        assert "Summary of content." in result_text

    @pytest.mark.asyncio
    async def test_summarizes_large_text_block(self, mock_agent):
        strategy = Offload.summarize("*").when(threshold=100)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="a" * 10000)]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        assert await strategy.apply(context) is True
        assert "[Summarized:" in messages[1]["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_skips_when_no_model(self):
        agent = unittest.mock.MagicMock()
        agent.aux_model = None
        strategy = Offload.summarize("*").when(threshold=100)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="a" * 10000)]),
        ]
        context = ContextState(messages=messages, agent=agent, utilization=0.5)
        assert await strategy.apply(context) is False

    @pytest.mark.asyncio
    async def test_returns_none_when_summary_empty_for_tool_result(self, mock_agent):
        mock_agent.model.stream = _make_empty_stream()
        strategy = Offload.summarize("tool_results").when(threshold=100)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(
                role="user",
                content=[
                    ContentBlock(
                        toolResult=ToolResult(
                            toolUseId="t1",
                            status="success",
                            content=[{"text": "x" * 10000}],
                        )
                    )
                ],
            ),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        assert await strategy.apply(context) is False

    @pytest.mark.asyncio
    async def test_returns_none_when_summary_empty_for_text_block(self, mock_agent):
        mock_agent.model.stream = _make_empty_stream()
        strategy = Offload.summarize("*").when(threshold=100)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="x" * 10000)]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        assert await strategy.apply(context) is False

    @pytest.mark.asyncio
    async def test_replaces_media_block_with_marker(self, mock_agent):
        strategy = Offload.summarize("*").when(threshold=100)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(
                role="user",
                content=[ContentBlock(image={"format": "png", "source": {"bytes": b"img"}})],
            ),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        assert await strategy.apply(context) is True
        assert "[Summarized:" in messages[1]["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_falls_back_to_offloaded_when_media_summary_empty(self, mock_agent):
        mock_agent.model.stream = _make_empty_stream()
        strategy = Offload.summarize("*").when(threshold=100)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(
                role="user",
                content=[ContentBlock(image={"format": "png", "source": {"bytes": b"img"}})],
            ),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        assert await strategy.apply(context) is True
        assert "[Offloaded:" in messages[1]["content"][0]["text"]


class TestSummarizeStrategyMessageLevel:
    """Tests for message-level summarization — only tests unique to SummarizeStrategy."""

    @pytest.mark.asyncio
    async def test_summarizes_oldest_batch(self, mock_agent):
        strategy = Offload.summarize("*").when(utilization=0.8)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="old1")]),
            Message(role="user", content=[ContentBlock(text="old2")]),
            Message(role="assistant", content=[ContentBlock(text="old3")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        assert await strategy.apply(context) is True
        all_text = " ".join(block.get("text", "") for msg in messages for block in msg["content"])
        assert "[Summarized:" in all_text

    @pytest.mark.asyncio
    async def test_inserts_summary_and_removes_originals(self, mock_agent):
        strategy = Offload.summarize("*").when(utilization=0.8)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="old1")]),
            Message(role="user", content=[ContentBlock(text="old2")]),
            Message(role="assistant", content=[ContentBlock(text="old3")]),
            Message(role="user", content=[ContentBlock(text="old4")]),
            Message(role="assistant", content=[ContentBlock(text="old5")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        assert await strategy.apply(context) is True
        summary_texts = [
            block.get("text", "")
            for msg in messages
            for block in msg["content"]
            if "[Summarized:" in block.get("text", "")
        ]
        assert len(summary_texts) >= 1
        assert "5,000 tokens" in summary_texts[0]
        assert messages[0]["content"][0]["text"] == "pin"
        for idx in range(len(messages) - 1):
            assert messages[idx]["role"] != messages[idx + 1]["role"]

    @pytest.mark.asyncio
    async def test_preserves_alternation(self, mock_agent):
        strategy = Offload.summarize("*").when(utilization=0.8)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="a1")]),
            Message(role="user", content=[ContentBlock(text="u2")]),
            Message(role="assistant", content=[ContentBlock(text="a2")]),
            Message(role="user", content=[ContentBlock(text="u3")]),
            Message(role="assistant", content=[ContentBlock(text="a3")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        await strategy.apply(context)
        for idx in range(len(messages) - 1):
            assert messages[idx]["role"] != messages[idx + 1]["role"]

    @pytest.mark.asyncio
    async def test_no_model_returns_false(self):
        agent = unittest.mock.MagicMock()
        agent.aux_model = None
        strategy = Offload.summarize("*").when(utilization=0.8)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="old")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]
        context = ContextState(messages=messages, agent=agent, utilization=0.9)
        assert await strategy.apply(context) is False

    @pytest.mark.asyncio
    async def test_summary_returns_none_falls_back_to_false(self, mock_agent):
        mock_agent.model.stream = _make_empty_stream()
        strategy = Offload.summarize("*").when(utilization=0.8)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="old1")]),
            Message(role="user", content=[ContentBlock(text="old2")]),
            Message(role="assistant", content=[ContentBlock(text="old3")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        assert await strategy.apply(context) is False


def _reasoning(text: str) -> Message:
    return Message(
        role="assistant",
        content=[
            ContentBlock(reasoningContent={"reasoningText": {"text": "thinking", "signature": "s"}}),
            ContentBlock(text=text),
        ],
    )


@pytest.fixture
def compaction_agent(mock_agent):
    mock_agent.model.supports_compaction = True
    mock_agent.model.compact = unittest.mock.AsyncMock(
        return_value=Message(role="assistant", content=[ContentBlock(text="Compacted", signature="sig-1")])
    )
    mock_agent.system_prompt_content = None
    mock_agent.tool_registry.get_all_tool_specs.return_value = []
    return mock_agent


class TestSummarizeStrategyCompaction:
    @pytest.mark.asyncio
    async def test_provider_summary_replaces_the_prefix(self, compaction_agent):
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=2)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="first")]),
            Message(role="assistant", content=[ContentBlock(text="old1")]),
            Message(role="user", content=[ContentBlock(text="old2")]),
            _reasoning("old3"),
            Message(role="user", content=[ContentBlock(text="recent")]),
            _reasoning("recent-reply"),
        ]
        compaction_agent.messages = messages
        context = ContextState(messages=messages, agent=compaction_agent, utilization=0.9)

        assert await strategy.apply(context) is True

        tru_messages = messages
        exp_messages = [
            Message(role="assistant", content=[ContentBlock(text="Compacted", signature="sig-1")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
            _reasoning("recent-reply"),
        ]
        assert tru_messages == exp_messages
        compacted = compaction_agent.model.compact.call_args.args[0]
        assert [msg["content"][-1]["text"] for msg in compacted] == ["first", "old1", "old2", "old3"]

    @pytest.mark.asyncio
    async def test_provider_summary_keeps_the_pending_user_turn(self, compaction_agent):
        strategy = Offload.summarize("*").when(utilization=0.8)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="first")]),
            Message(role="assistant", content=[ContentBlock(text="old1")]),
            Message(role="user", content=[ContentBlock(text="old2")]),
            Message(role="assistant", content=[ContentBlock(text="old3")]),
            Message(role="user", content=[ContentBlock(text="pending question")]),
        ]
        compaction_agent.messages = messages
        context = ContextState(messages=messages, agent=compaction_agent, utilization=0.9)

        assert await strategy.apply(context) is True

        compacted = compaction_agent.model.compact.call_args.args[0]
        assert [msg["content"][0]["text"] for msg in compacted] == ["first", "old1", "old2", "old3"]
        assert messages == [
            Message(role="assistant", content=[ContentBlock(text="Compacted", signature="sig-1")]),
            Message(role="user", content=[ContentBlock(text="pending question")]),
        ]

    @pytest.mark.asyncio
    async def test_provider_summary_declines_when_keeping_the_last_message_splits_a_tool_pair(self, compaction_agent):
        strategy = Offload.summarize("*").when(utilization=0.8)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="first")]),
            Message(role="assistant", content=[ContentBlock(text="old1")]),
            Message(role="user", content=[ContentBlock(text="old2")]),
            Message(
                role="assistant",
                content=[ContentBlock(toolUse={"toolUseId": "t1", "name": "tool", "input": {}})],
            ),
            Message(
                role="user",
                content=[ContentBlock(toolResult={"toolUseId": "t1", "status": "success", "content": []})],
            ),
        ]
        compaction_agent.messages = messages
        context = ContextState(messages=messages, agent=compaction_agent, utilization=0.9)

        await strategy.apply(context)

        compaction_agent.model.compact.assert_not_called()

    @pytest.mark.asyncio
    async def test_provider_summary_merges_with_following_assistant_turn(self, compaction_agent):
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="first")]),
            Message(role="assistant", content=[ContentBlock(text="old1")]),
            Message(role="user", content=[ContentBlock(text="old2")]),
            Message(role="assistant", content=[ContentBlock(text="recent-reply")]),
        ]
        compaction_agent.messages = messages
        context = ContextState(messages=messages, agent=compaction_agent, utilization=0.9)

        assert await strategy.apply(context) is True

        assert messages == [
            Message(
                role="assistant",
                content=[ContentBlock(text="Compacted", signature="sig-1"), ContentBlock(text="recent-reply")],
            )
        ]

    @pytest.mark.asyncio
    async def test_falls_back_to_client_summary_and_strips_kept_reasoning(self, compaction_agent):
        compaction_agent.model.compact = unittest.mock.AsyncMock(return_value=None)
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=2)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="first")]),
            Message(role="assistant", content=[ContentBlock(text="old1")]),
            Message(role="user", content=[ContentBlock(text="old2")]),
            Message(role="assistant", content=[ContentBlock(text="old3")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
            _reasoning("recent-reply"),
        ]
        compaction_agent.messages = messages
        context = ContextState(messages=messages, agent=compaction_agent, utilization=0.9)

        assert await strategy.apply(context) is True

        assert messages[0]["content"][0]["text"] == "first"
        assert any("[Summarized:" in block.get("text", "") for msg in messages for block in msg["content"])
        assert messages[-1] == Message(role="assistant", content=[ContentBlock(text="recent-reply")])

    @pytest.mark.asyncio
    async def test_pinned_message_in_prefix_skips_provider_compaction(self, compaction_agent):
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="first")]),
            Message(role="assistant", content=[ContentBlock(text="pinned")], metadata={"custom": {"pinned": True}}),
            Message(role="user", content=[ContentBlock(text="old2")]),
            Message(role="assistant", content=[ContentBlock(text="old3")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]
        compaction_agent.messages = messages
        context = ContextState(messages=messages, agent=compaction_agent, utilization=0.9)

        assert await strategy.apply(context) is True

        compaction_agent.model.compact.assert_not_called()
        assert any("[Summarized:" in block.get("text", "") for msg in messages for block in msg["content"])

    @pytest.mark.asyncio
    async def test_dedicated_summarization_model_skips_provider_compaction(self, compaction_agent):
        summarizer = unittest.mock.AsyncMock()
        summarizer.stream = compaction_agent.model.stream
        summarizer.count_tokens = unittest.mock.AsyncMock(return_value=10)
        strategy = Offload.summarize("*", {"model": summarizer}).when(utilization=0.8, preserve_recent=1)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="first")]),
            Message(role="assistant", content=[ContentBlock(text="old1")]),
            Message(role="user", content=[ContentBlock(text="old2")]),
            Message(role="assistant", content=[ContentBlock(text="old3")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]
        compaction_agent.messages = messages
        context = ContextState(messages=messages, agent=compaction_agent, utilization=0.9)

        assert await strategy.apply(context) is True

        compaction_agent.model.compact.assert_not_called()

    @pytest.mark.asyncio
    async def test_pinned_first_message_skips_provider_compaction(self, compaction_agent):
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="first")], metadata={"custom": {"pinned": True}}),
            Message(role="assistant", content=[ContentBlock(text="old1")]),
            Message(role="user", content=[ContentBlock(text="old2")]),
            Message(role="assistant", content=[ContentBlock(text="old3")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]
        compaction_agent.messages = messages
        context = ContextState(messages=messages, agent=compaction_agent, utilization=0.9)

        assert await strategy.apply(context) is True

        compaction_agent.model.compact.assert_not_called()
        assert messages[0]["content"][0]["text"] == "first"

    @pytest.mark.asyncio
    async def test_per_block_strategy_leaves_signed_summary_untouched(self, compaction_agent):
        strategy = Offload.summarize("*").when(threshold=10)
        summary = Message(role="assistant", content=[ContentBlock(text="Compacted " * 100, signature="sig-1")])
        messages: Messages = [summary, Message(role="user", content=[ContentBlock(text="recent " * 100)])]
        compaction_agent.messages = messages
        context = ContextState(messages=messages, agent=compaction_agent, utilization=0.9)

        await strategy.apply(context)

        assert messages[0]["content"] == [ContentBlock(text="Compacted " * 100, signature="sig-1")]

    @pytest.mark.asyncio
    async def test_compaction_error_falls_back_to_client_summary(self, compaction_agent):
        compaction_agent.model.compact = unittest.mock.AsyncMock(side_effect=RuntimeError("compaction unavailable"))
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="first")]),
            Message(role="assistant", content=[ContentBlock(text="old1")]),
            Message(role="user", content=[ContentBlock(text="old2")]),
            Message(role="assistant", content=[ContentBlock(text="old3")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]
        compaction_agent.messages = messages
        context = ContextState(messages=messages, agent=compaction_agent, utilization=0.9)

        assert await strategy.apply(context) is True

        assert messages[0]["content"][0]["text"] == "first"
        assert any("[Summarized:" in block.get("text", "") for msg in messages for block in msg["content"])

"""Tests for the SummarizeStrategy."""

import unittest.mock

import pytest

from strands._context_manager.methods.summarize import SUMMARIZE_CONVERSATION_INSTRUCTION
from strands._context_manager.strategies.offload import Offload
from strands._context_manager.types import ContextState
from strands.types.content import ContentBlock, Message, Messages
from strands.types.tools import ToolResult, ToolUse


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
    agent.model.count_tokens = unittest.mock.AsyncMock(return_value=5000)
    agent.model.estimate_utilization = unittest.mock.MagicMock(return_value=0.9)
    agent.model.stream = _make_stream_events("Summary of content.")
    agent.aux_model = agent.model
    agent.messages = []
    agent.system_prompt_content = [{"text": "You are the agent."}]
    agent._cancel_signal = None
    agent.tool_registry.get_all_tool_specs.return_value = [{"name": "calc", "description": "d", "inputSchema": {}}]
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
    async def test_replays_history_prefix_with_agent_prompt_and_tools(self, mock_agent):
        seen: list = []

        def stream(messages, tool_specs, system_prompt, **kwargs):
            seen.append((messages, tool_specs, system_prompt))
            return _make_stream_events("Summary of content.")()

        mock_agent.model.stream = stream
        strategy = Offload.summarize("*").when(utilization=0.8)
        tool_use = ContentBlock(toolUse=ToolUse(toolUseId="t1", name="calc", input={}))
        tool_result = ContentBlock(toolResult=ToolResult(toolUseId="t1", status="success", content=[{"text": "42"}]))
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[tool_use]),
            Message(role="user", content=[tool_result]),
            Message(role="assistant", content=[ContentBlock(text="old")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]
        history = [Message(role=m["role"], content=list(m["content"])) for m in messages[:4]]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        assert await strategy.apply(context) is True

        request, tool_specs, system_prompt = seen[0]
        assert request == [
            *history,
            Message(role="user", content=[ContentBlock(text=SUMMARIZE_CONVERSATION_INSTRUCTION)]),
        ]
        assert tool_specs == mock_agent.tool_registry.get_all_tool_specs.return_value
        assert system_prompt == "You are the agent."

    @pytest.mark.asyncio
    async def test_batch_uses_agent_model_not_aux_model(self, mock_agent):
        aux_model = unittest.mock.AsyncMock()
        aux_model.stream = _make_stream_events("aux summary")
        mock_agent.aux_model = aux_model
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
        assert "Summary of content." in all_text
        assert "aux summary" not in all_text

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


class TestRepeatedSummarizationKeepsMessageZeroVerbatim:
    """Regression test for https://github.com/strands-agents/harness-sdk/issues/4685."""

    @pytest.mark.asyncio
    async def test_summaries_stay_out_of_pinned_message_zero(self, mock_agent):
        strategy = Offload.summarize("*").when(utilization=0.7, preserve_recent=4)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="task")], metadata={"custom": {"pinned": True}})
        ]
        for index in range(30):
            tool_use = ToolUse(toolUseId=f"t{index}", name="read", input={})
            tool_result = ToolResult(toolUseId=f"t{index}", status="success", content=[{"text": "x"}])
            messages.append(Message(role="assistant", content=[ContentBlock(toolUse=tool_use)]))
            messages.append(Message(role="user", content=[ContentBlock(toolResult=tool_result)]))
            await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9))
        assert messages[0] == Message(
            role="user", content=[ContentBlock(text="task")], metadata={"custom": {"pinned": True}}
        )
        summaries = [b for msg in messages for b in msg["content"] if b.get("text", "").startswith("[Summarized:")]
        assert len(summaries) == 1

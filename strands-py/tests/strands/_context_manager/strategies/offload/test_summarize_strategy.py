"""Tests for the SummarizeStrategy."""

import asyncio
import threading
import unittest.mock

import pytest

from strands import Agent, tool
from strands._context_manager.strategies.offload import Offload
from strands._context_manager.types import ContextManagerConfig, ContextState
from strands.hooks import AfterInvocationEvent
from strands.types.content import ContentBlock, Message, Messages
from strands.types.tools import ToolResult
from tests.fixtures.mocked_model_provider import MockedModelProvider


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
    agent.cancel_signal = threading.Event()
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


def _tool_result_message(tool_use_id: str, text: str) -> Message:
    return Message(
        role="user",
        content=[
            ContentBlock(toolResult=ToolResult(toolUseId=tool_use_id, status="success", content=[{"text": text}]))
        ],
    )


def _gated_stream(gate: asyncio.Event, text: str = "Summary of content."):
    async def stream(*args, **kwargs):
        await gate.wait()
        async for event in _make_stream_events(text)():
            yield event

    return stream


class TestSummarizeStrategyBackground:
    """Tests for background (deferred) summarization."""

    def test_rejects_utilization_condition(self):
        with pytest.raises(ValueError, match="per-block"):
            Offload.summarize("tool_results", {"background": True}).when(utilization=0.8)

    @pytest.mark.asyncio
    async def test_apply_defers_then_commits_once_the_summary_is_ready(self, mock_agent):
        gate = asyncio.Event()
        mock_agent.model.stream = _gated_stream(gate)
        strategy = Offload.summarize("tool_results", {"background": True}).when(threshold=100)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            _tool_result_message("t1", "x" * 10000),
        ]
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)

        assert await strategy.apply(context) is False
        assert messages[1]["content"][0]["toolResult"]["content"] == [{"text": "x" * 10000}]

        gate.set()
        await asyncio.sleep(0)

        assert await strategy.apply(context) is True
        tru_content = messages[1]["content"][0]["toolResult"]["content"]
        exp_content = [{"text": "[Summarized: tool result, ~5,000 tokens]\n\nSummary of content."}]
        assert tru_content == exp_content

    @pytest.mark.asyncio
    async def test_overflow_pass_waits_for_the_batch(self, mock_agent):
        gate = asyncio.Event()
        gate.set()
        mock_agent.model.stream = _gated_stream(gate)
        strategy = Offload.summarize("tool_results", {"background": True}).when(threshold=100)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            _tool_result_message("t1", "x" * 10000),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=1.1, overflow=True)

        assert await strategy.apply(context) is True
        assert "Summary of content." in messages[1]["content"][0]["toolResult"]["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_flush_applies_the_batch_before_returning(self, mock_agent):
        gate = asyncio.Event()
        mock_agent.model.stream = _gated_stream(gate)
        strategy = Offload.summarize("tool_results", {"background": True}).when(threshold=100)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            _tool_result_message("t1", "x" * 10000),
        ]
        mock_agent.messages = messages
        await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.5))
        asyncio.get_running_loop().call_later(0.01, gate.set)

        assert await strategy.flush(mock_agent) is True
        assert "Summary of content." in messages[1]["content"][0]["toolResult"]["content"][0]["text"]

    def test_init_skips_the_eager_hook(self, mock_agent):
        mock_agent.hooks = unittest.mock.MagicMock()
        Offload.summarize("tool_results", {"background": True}).when(threshold=100).init(mock_agent)
        Offload.summarize("tool_results").when(threshold=100).init(mock_agent)

        assert mock_agent.hooks.add_callback.call_count == 1


@tool
def fetch_report() -> str:
    """Return a large report."""
    return "report " * 2000


class _GatedSummarizer(MockedModelProvider):
    """Summarizer that waits for the gate before producing its summary."""

    def __init__(self, gate: asyncio.Event) -> None:
        super().__init__([Message(role="assistant", content=[ContentBlock(text="Report summary.")])])
        self.gate = gate
        self.calls = 0

    async def stream(self, *args, **kwargs):
        self.calls += 1
        await self.gate.wait()
        async for event in super().stream(*args, **kwargs):
            yield event


class _MainModel(MockedModelProvider):
    """Main model that opens the summarizer gate when its final call starts."""

    def __init__(self, gate: asyncio.Event) -> None:
        super().__init__(
            [
                Message(
                    role="assistant",
                    content=[ContentBlock(toolUse={"toolUseId": "t1", "name": "fetch_report", "input": {}})],
                ),
                Message(role="assistant", content=[ContentBlock(text="Done.")]),
            ]
        )
        self.gate = gate
        self.summary_pending_at_final_call: bool | None = None

    async def stream(self, messages, *args, **kwargs):
        if self.index == 1:
            tool_result_text = messages[2]["content"][0]["toolResult"]["content"][0]["text"]
            self.summary_pending_at_final_call = "[Summarized:" not in tool_result_text
            self.gate.set()
        async for event in super().stream(messages, *args, **kwargs):
            yield event


def _background_agent(gate: asyncio.Event, summarizer: MockedModelProvider) -> tuple[Agent, _MainModel]:
    main_model = _MainModel(gate)
    strategy = Offload.summarize("tool_results", {"background": True, "model": summarizer}).when(threshold=100)
    agent = Agent(
        model=main_model,
        tools=[fetch_report],
        context_manager=ContextManagerConfig(strategies=[strategy], stash=False),
        callback_handler=None,
    )
    return agent, main_model


class TestSummarizeStrategyBackgroundWithAgent:
    """End-to-end background summarization through the agent loop."""

    @pytest.mark.asyncio
    async def test_model_call_proceeds_while_summary_is_pending_and_commits_before_return(self):
        gate = asyncio.Event()
        summarizer = _GatedSummarizer(gate)
        agent, main_model = _background_agent(gate, summarizer)
        observed_at_default_order: list[str] = []

        async def observer(event: AfterInvocationEvent) -> None:
            observed_at_default_order.append(event.agent.messages[2]["content"][0]["toolResult"]["content"][0]["text"])

        agent.add_hook(observer, AfterInvocationEvent)

        result = await agent.invoke_async("Summarize the report")

        assert result.stop_reason == "end_turn"
        assert main_model.summary_pending_at_final_call is True
        assert summarizer.calls == 1
        tru_tool_result = agent.messages[2]["content"][0]["toolResult"]
        exp_tool_result = {
            "toolUseId": "t1",
            "status": "success",
            "content": [{"text": "[Summarized: tool result, ~3,500 tokens]\n\nReport summary."}],
        }
        assert tru_tool_result == exp_tool_result
        assert observed_at_default_order == [exp_tool_result["content"][0]["text"]]

    def test_sync_entry_point_commits_summary_before_returning(self):
        gate = asyncio.Event()
        gate.set()
        summarizer = _GatedSummarizer(gate)
        agent, _ = _background_agent(gate, summarizer)

        result = agent("Summarize the report")

        assert result.stop_reason == "end_turn"
        assert summarizer.calls == 1
        tru_text = agent.messages[2]["content"][0]["toolResult"]["content"][0]["text"]
        exp_text = "[Summarized: tool result, ~3,500 tokens]\n\nReport summary."
        assert tru_text == exp_text

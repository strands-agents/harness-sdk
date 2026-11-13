"""Tests for the SummarizeStrategy."""

import logging
import threading
import unittest.mock
from typing import Any

import pytest

from strands._context_manager.placeholder import (
    REMOVED_MESSAGES,
    format_offloaded,
    format_summarized,
    offload_placeholder,
)
from strands._context_manager.strategies.offload import Offload
from strands._context_manager.strategies.offload.summarize import BLOCK_SUMMARY_INSTRUCTIONS
from strands._context_manager.types import ContextState
from strands.agent.invocation_context import _create_invocation_context
from strands.models import Model, SummarizeResult
from strands.models._summarize import _SUMMARIZE_GUARD, DEFAULT_SUMMARIZE_INSTRUCTIONS
from strands.types.content import ContentBlock, Message, Messages
from strands.types.event_loop import Usage
from strands.types.tools import ToolResult, ToolUse
from tests.fixtures.context_manager_helpers import (
    heuristic_count_tokens,
    heuristic_model,
    make_agent,
    make_context,
    make_tool_result_message,
)

AGENT_PROMPT = [{"text": "You are a coding agent."}]
AGENT_TOOLS = [{"name": "shell", "description": "Run a command", "inputSchema": {"json": {}}}]
LARGE_TEXT = "x" * (2500 * 4 + 100)
STREAM_USAGE = {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}
INSTRUCTIONS = ContentBlock(text=f"{_SUMMARIZE_GUARD}\n\n{DEFAULT_SUMMARIZE_INSTRUCTIONS}")


def _stream_events(text: str, on_delta: Any = None):
    """A ``stream`` implementation replying with ``text``, calling ``on_delta`` once the text was streamed."""

    async def stream(*args: Any, **kwargs: Any):
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": text}}}
        if on_delta is not None:
            on_delta()
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}
        yield {"metadata": {"usage": STREAM_USAGE}}

    return stream


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


def _base_summarize(model):
    """Return a mock ``summarize`` that runs the base implementation on ``model``."""

    async def summarize(messages, **kwargs):
        return await Model.summarize(model, messages, **kwargs)

    return unittest.mock.AsyncMock(side_effect=summarize)


def _replay_kwargs(agent, instructions: str | None = None) -> dict:
    """Return the keyword arguments a run summary passes to ``summarize()`` for ``agent``."""
    return {
        "tool_specs": AGENT_TOOLS,
        "system_prompt": "You are a coding agent.",
        "system_prompt_content": AGENT_PROMPT,
        "instructions": instructions,
        "cancel_signal": agent._cancel_signal,
        "agent_metadata": agent._metadata,
    }


def _marker(summary: str, tokens: int = 5000) -> ContentBlock:
    """The placeholder a summarized run leaves, over the 5,000 tokens the mocked count reports."""
    return offload_placeholder("summarize", format_summarized(REMOVED_MESSAGES, tokens, summary), None, tokens)


def _summary(text: str, provider: str | None = None) -> SummarizeResult:
    return SummarizeResult(content=[ContentBlock(summary={"provider": provider, "text": text})])


def _tool_result_messages() -> Messages:
    tool_result = ToolResult(toolUseId="t1", status="success", content=[{"text": "x" * 10000}])
    return [_text("user", "task"), Message(role="user", content=[ContentBlock(toolResult=tool_result)])]


def _summarized_tool_result(summary: str) -> Message:
    placeholder = offload_placeholder("summarize", format_summarized("tool result", 5000, summary), None, 5000)
    tool_result = ToolResult(toolUseId="t1", status="success", content=[placeholder])
    return Message(role="user", content=[ContentBlock(toolResult=tool_result)])


def _per_block(config: Any = None):
    return Offload.summarize("tool_results", config).when(block_threshold=100)


def _mock_agent(
    messages: Messages,
    *,
    server_side_summary: bool = False,
    system_prompt: Any = AGENT_PROMPT,
) -> tuple[unittest.mock.MagicMock, unittest.mock.MagicMock]:
    """An agent on a :func:`_base_model`, with a system prompt, a tool, a cancel signal and agent metadata."""
    model = _base_model(server_side_summary)
    agent = make_agent(messages, model)
    agent.system_prompt_content = system_prompt
    agent.tool_registry.get_all_tool_specs.return_value = AGENT_TOOLS
    return agent, model


def _mock_summarize() -> unittest.mock.AsyncMock:
    """A ``summarize`` mock replying with a client-side summary."""
    return unittest.mock.AsyncMock(return_value=_summary("Summary of multimodal content"))


def _context(messages: Messages, utilization: float = 0.5, **members: Any) -> ContextState:
    """A context whose model counts tokens heuristically and replies with a mocked ``summarize``."""
    model = heuristic_model(**{"summarize": _mock_summarize(), **members})
    return make_context(messages, utilization=utilization, model=model)


def _agent_context(messages: Messages, agent: Any, utilization: float, request: Any = None) -> ContextState:
    """A context over an agent :func:`_mock_agent` built."""
    return ContextState(messages=messages, agent=agent, utilization=utilization, invocation_context=request)


def _per_message():
    return Offload.summarize("*").when(context_utilization="80%", preserve_recent=1)


def _pinned(text: str) -> Message:
    return Message(role="user", content=[ContentBlock(text=text)], metadata={"custom": {"pinned": True}})


def _server_side_messages() -> Messages:
    return [
        _text("user", "task"),
        _text("assistant", "old1"),
        _text("user", "old2"),
        _text("assistant", "old3"),
        _text("user", "recent"),
    ]


def _size_filtered():
    return Offload.summarize("*").when(context_utilization="50%", block_threshold=100, preserve_recent=1)


def _size_filtered_messages() -> Messages:
    """A history where only message 3 is over a 100-token ``block_threshold``."""
    return [
        _text("user", "task"),
        _text("assistant", "small a1"),
        _text("user", "small u2"),
        _text("assistant", "BIG " * 200),
        _text("user", "small u4"),
        _text("assistant", "small a5"),
        _text("user", "last"),
    ]


def _text(role: str, text: str) -> Message:
    return Message(role=role, content=[ContentBlock(text=text)])


def _texts(messages: Messages) -> list[list[str]]:
    """The text of every block, message by message."""
    return [[block["text"] for block in message["content"]] for message in messages]


def _base_model(server_side_summary: bool = False, text: str = "Summary of content.") -> unittest.mock.MagicMock:
    """A model whose ``summarize`` runs the base implementation over a stream replying ``text``."""
    model = heuristic_model(count_tokens=unittest.mock.AsyncMock(return_value=5000))
    model.stream = unittest.mock.MagicMock(side_effect=_stream_events(text))
    model.summarize = _base_summarize(model)
    model.get_config = unittest.mock.MagicMock(return_value={"model_id": "claude-haiku-5-5"})
    model.model_info.capabilities.server_side_summary = server_side_summary
    return model


@pytest.fixture
def mock_agent():
    agent = unittest.mock.MagicMock()
    agent.model = unittest.mock.AsyncMock()
    agent.model.count_tokens = unittest.mock.AsyncMock(return_value=5000)
    agent.model.estimate_utilization = unittest.mock.MagicMock(return_value=0.9)
    agent.model.stream = _make_stream_events("Summary of content.")
    agent.model.summarize = _base_summarize(agent.model)
    agent.aux_model = agent.model
    agent.messages = []
    agent.system_prompt_content = AGENT_PROMPT
    agent.tool_registry.get_all_tool_specs.return_value = AGENT_TOOLS
    agent._cancel_signal = threading.Event()
    return agent


class TestSummarizeStrategyPerBlock:
    """Tests for per-block summarization."""

    @pytest.mark.asyncio
    async def test_summarizes_large_tool_result(self, mock_agent):
        strategy = Offload.summarize("tool_results").when(block_threshold=100)
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
        strategy = Offload.summarize("assistant_text").when(block_threshold=100)
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
        strategy = Offload.summarize("assistant_text").when(block_threshold=100)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="a" * 10000)]),
        ]
        context = ContextState(messages=messages, agent=agent, utilization=0.5)
        assert await strategy.apply(context) is False

    @pytest.mark.asyncio
    async def test_returns_none_when_summary_empty_for_tool_result(self, mock_agent):
        mock_agent.model.stream = _make_empty_stream()
        strategy = Offload.summarize("tool_results").when(block_threshold=100)
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
        strategy = Offload.summarize("assistant_text").when(block_threshold=100)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="x" * 10000)]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        assert await strategy.apply(context) is False

    @pytest.mark.asyncio
    async def test_keeps_block_and_continues_pass_when_summarization_fails(self, mock_agent, caplog):
        summary_stream = _make_stream_events("Summary of content.")
        calls = iter([RuntimeError("rejected"), None])

        def stream(*args, **kwargs):
            error = next(calls)
            if error:
                raise error
            return summary_stream(*args, **kwargs)

        mock_agent.model.stream = stream
        strategy = Offload.summarize("tool_results").when(block_threshold=100)

        def tool_result_message(tool_use_id: str) -> Message:
            tool_result = ToolResult(toolUseId=tool_use_id, status="success", content=[{"text": "x" * 10000}])
            return Message(role="user", content=[ContentBlock(toolResult=tool_result)])

        messages: Messages = [tool_result_message("call_1"), tool_result_message("call_2")]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)

        with caplog.at_level(logging.WARNING):
            assert await strategy.apply(context) is True
        assert messages[0]["content"][0]["toolResult"]["content"][0]["text"] == "x" * 10000
        assert "[Summarized:" in messages[1]["content"][0]["toolResult"]["content"][0]["text"]
        assert "error=<rejected>" in caplog.text

    @pytest.mark.asyncio
    async def test_stops_sending_requests_after_a_cancel(self, mock_agent):
        calls = []

        async def cancelling_stream(*args, **kwargs):
            calls.append(args)
            yield {"messageStart": {"role": "assistant"}}
            mock_agent._cancel_signal.set()
            yield {"contentBlockStart": {"start": {}}}
            yield {"contentBlockDelta": {"delta": {"text": "partial"}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}

        mock_agent.model.stream = cancelling_stream
        strategy = Offload.summarize("tool_results").when(block_threshold=100)

        def tool_result_message(tool_use_id: str) -> Message:
            tool_result = ToolResult(toolUseId=tool_use_id, status="success", content=[{"text": "x" * 10000}])
            return Message(role="user", content=[ContentBlock(toolResult=tool_result)])

        messages: Messages = [tool_result_message(f"call_{index}") for index in range(5)]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)

        assert await strategy.apply(context) is False
        assert len(calls) == 1
        assert messages == [tool_result_message(f"call_{index}") for index in range(5)]

    @pytest.mark.asyncio
    async def test_skips_a_run_summary_once_cancelled(self, mock_agent):
        mock_agent._cancel_signal.set()
        mock_agent.model.stream = unittest.mock.Mock()
        messages = TestServerSideSummary._messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(context_utilization="80%", preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is False

        mock_agent.model.stream.assert_not_called()
        assert messages == TestServerSideSummary._messages()

    @pytest.mark.asyncio
    async def test_places_only_the_first_summary_block(self):
        messages = _tool_result_messages()
        agent, model = _mock_agent(messages)
        model.summarize = unittest.mock.AsyncMock(
            return_value=SummarizeResult(content=[*_summary("first").content, *_summary("second").content])
        )

        assert await _per_block().apply(_agent_context(messages, agent, 0.5)) is True

        assert messages[1] == _summarized_tool_result("first")


def _reasoning() -> ContentBlock:
    return ContentBlock(reasoningContent={"reasoningText": {"text": "think", "signature": "sig"}})


def _replay_messages() -> Messages:
    return [
        _text("user", "task"),
        Message(role="assistant", content=[_reasoning(), ContentBlock(text="old1")]),
        _text("user", "old2"),
        _text("assistant", "old3"),
        _text("user", "recent"),
    ]

    @pytest.mark.parametrize(
        ("media", "kind", "summarize"),
        [
            ({"video": {"format": "mp4", "source": {"bytes": b"\x00" * 4000}}}, "video", _mock_summarize()),
            (
                {"image": {"format": "png", "source": {"bytes": b"\x00" * 4000}}},
                "image",
                unittest.mock.AsyncMock(side_effect=RuntimeError("images unsupported")),
            ),
        ],
        ids=["a video block is offloaded without summarizing it", "a media block whose summarization failed"],
    )
    @pytest.mark.asyncio
    async def test_offloads_media_it_cannot_summarize(self, caplog, media, kind, summarize):
        messages = [_text("user", "task"), Message(role="user", content=[ContentBlock(**media)]), _text("user", "last")]
        model = heuristic_model(summarize=summarize)
        strategy = Offload.summarize("media", {"model": model}).when(context_utilization="50%", block_threshold=10)
        tokens = heuristic_count_tokens([messages[1]])

        with caplog.at_level(logging.WARNING):
            assert await strategy.apply(_context(messages, 0.9)) is True

        assert messages[1]["content"] == [
            offload_placeholder("summarize", format_offloaded(tokens, kind), None, tokens)
        ]
        assert (kind == "video") is not summarize.await_count


class TestSummarizeStrategyMessageLevel:
    """Tests for message-level summarization — only tests unique to SummarizeStrategy."""

    @pytest.mark.asyncio
    async def test_summarizes_the_oldest_run(self, mock_agent):
        strategy = Offload.summarize("*").when(context_utilization="80%")
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
        strategy = Offload.summarize("*").when(context_utilization="80%")
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
        strategy = Offload.summarize("*").when(context_utilization="80%")
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
        strategy = Offload.summarize("*").when(context_utilization="80%")
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
        strategy = Offload.summarize("*").when(context_utilization="80%")
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
        strategy = Offload.summarize("*").when(context_utilization="70%", preserve_recent=4)
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


class TestSummarizationWithToolCalls:
    """Regression test for https://github.com/strands-agents/harness-sdk/issues/5291."""

    @pytest.mark.asyncio
    async def test_replays_tool_calls_in_a_single_model_call(self, mock_agent):
        tru_calls: list[tuple] = []
        summary_stream = _make_stream_events("Listed the files")

        def recording_stream(messages, tool_specs, system_prompt, **kwargs):
            tru_calls.append((messages, tool_specs, kwargs["system_prompt_content"]))
            return summary_stream(messages, **kwargs)

        mock_agent.model.stream = recording_stream
        strategy = Offload.summarize("*").when(context_utilization="70%", preserve_recent=2)
        tool_use = ToolUse(toolUseId="call_1", name="shell", input={"command": "ls"})
        tool_result = ToolResult(toolUseId="call_1", status="success", content=[{"text": "a.ts b.ts"}])
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="fix the build")]),
            Message(role="assistant", content=[ContentBlock(toolUse=tool_use)]),
            Message(role="user", content=[ContentBlock(toolResult=tool_result)]),
            Message(role="assistant", content=[ContentBlock(text="done")]),
            Message(role="user", content=[ContentBlock(text="next")]),
        ]
        mock_agent.messages = messages

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True
        exp_calls = [
            (
                [
                    Message(role="user", content=[ContentBlock(text="fix the build")]),
                    Message(role="assistant", content=[ContentBlock(toolUse=tool_use)]),
                    Message(role="user", content=[ContentBlock(toolResult=tool_result), INSTRUCTIONS]),
                ],
                AGENT_TOOLS,
                AGENT_PROMPT,
            )
        ]
        assert tru_calls == exp_calls


class TestRunSummaryReplaysTheAgentRequest:
    """Tests that a batched summary replays the agent's own request."""

    @staticmethod
    def _messages() -> Messages:
        return [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(
                role="assistant",
                content=[
                    ContentBlock(reasoningContent={"reasoningText": {"text": "think", "signature": "sig"}}),
                    ContentBlock(text="old1"),
                ],
            ),
            Message(role="user", content=[ContentBlock(text="old2")]),
            Message(role="assistant", content=[ContentBlock(text="old3")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]

    @pytest.mark.asyncio
    async def test_sends_the_history_prefix_with_the_agent_prompt_and_tools(self, mock_agent):
        messages = self._messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(context_utilization="80%", preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        call = mock_agent.model.summarize.await_args
        assert call.args[0] == self._messages()[:4]
        assert call.kwargs == {
            "tool_specs": AGENT_TOOLS,
            "system_prompt": "You are a coding agent.",
            "system_prompt_content": AGENT_PROMPT,
            "instructions": None,
            "cancel_signal": mock_agent._cancel_signal,
            "agent_metadata": mock_agent._metadata,
        }

    @pytest.mark.asyncio
    async def test_summarizes_each_side_of_a_kept_pin_on_its_own(self):
        messages = [
            _text("user", "task"),
            _text("assistant", "old1"),
            _pinned("pin"),
            _text("assistant", "old3"),
            _text("user", "recent"),
        ]
        agent, model = _mock_agent(messages)

        assert await _per_message().apply(_agent_context(messages, agent, 0.9)) is True

        # The later run goes first, so removing it leaves the earlier run's position unchanged.
        assert [call.args[0] for call in model.summarize.await_args_list] == [
            [_text("user", "task"), _text("assistant", "old3")],
            [_text("user", "task"), _text("assistant", "old1")],
        ]
        assert model.summarize.await_args_list[0].kwargs == _replay_kwargs(agent)
        assert messages == [
            _text("user", "task"),
            Message(role="assistant", content=[_marker("Summary of content.")]),
            _pinned("pin"),
            Message(role="assistant", content=[_marker("Summary of content.")]),
            _text("user", "recent"),
        ]

    @pytest.mark.asyncio
    async def test_sends_only_the_messages_a_block_threshold_selected(self):
        messages = [
            _text("user", "task"),
            _text("assistant", "big1"),
            _text("user", "question"),
            _text("assistant", "big2"),
            _text("user", "recent"),
        ]
        agent, model = _mock_agent(messages)
        model.count_tokens = unittest.mock.AsyncMock(
            side_effect=lambda counted: (
                5000
                if any("big" in block.get("text", "") for message in counted for block in message["content"])
                else 10
            )
        )
        strategy = Offload.summarize("*").when(context_utilization="80%", block_threshold=100)

        assert await strategy.apply(_agent_context(messages, agent, 0.9)) is True

        assert [call.args[0] for call in model.summarize.await_args_list] == [
            [_text("user", "task"), _text("assistant", "big2")],
            [_text("user", "task"), _text("assistant", "big1")],
        ]
        assert model.summarize.await_args_list[0].kwargs == _replay_kwargs(agent)
        assert messages == [
            _text("user", "task"),
            Message(role="assistant", content=[_marker("Summary of content.")]),
            _text("user", "question"),
            Message(role="assistant", content=[_marker("Summary of content.")]),
            _text("user", "recent"),
        ]

    @pytest.mark.asyncio
    async def test_replays_the_prefix_as_sent_when_it_holds_adjacent_same_role_messages(self, mock_agent):
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(role="user", content=[ContentBlock(text="more task")]),
            Message(role="assistant", content=[ContentBlock(text="old1")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(context_utilization="80%", preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        assert mock_agent.model.summarize.await_args == unittest.mock.call(
            [
                Message(role="user", content=[ContentBlock(text="task")]),
                Message(role="user", content=[ContentBlock(text="more task")]),
                Message(role="assistant", content=[ContentBlock(text="old1")]),
            ],
            **_replay_kwargs(mock_agent),
        )

    @pytest.mark.asyncio
    async def test_leaves_reasoning_out_of_a_run_that_is_not_the_history_prefix(self):
        messages = [
            _text("user", "task"),
            Message(role="assistant", content=[_reasoning(), ContentBlock(text="old1")]),
            _pinned("pin"),
            Message(role="assistant", content=[_reasoning(), ContentBlock(text="old3")]),
            _text("user", "recent"),
        ]
        agent, model = _mock_agent(messages)

        assert await _per_message().apply(_agent_context(messages, agent, 0.9)) is True

        assert [call.args[0] for call in model.summarize.await_args_list] == [
            [_text("user", "task"), _text("assistant", "old3")],
            [_text("user", "task"), Message(role="assistant", content=[_reasoning(), ContentBlock(text="old1")])],
        ]

    @pytest.mark.asyncio
    async def test_sends_no_system_prompt_for_an_agent_without_one(self, mock_agent):
        mock_agent.system_prompt_content = None
        mock_agent.model.stream = unittest.mock.MagicMock(side_effect=_make_stream_events("Summary of content."))
        messages = self._messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(context_utilization="80%", preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        call = mock_agent.model.stream.call_args
        assert call.args[2] is None
        assert call.kwargs["system_prompt_content"] is None

    @pytest.mark.asyncio
    async def test_leaves_the_history_unchanged_when_cancelled_mid_summary(self, mock_agent):
        async def cancelling_stream(*args, **kwargs):
            yield {"messageStart": {"role": "assistant"}}
            yield {"contentBlockStart": {"start": {}}}
            yield {"contentBlockDelta": {"delta": {"text": "partial"}}}
            mock_agent._cancel_signal.set()
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}

        mock_agent.model.stream = cancelling_stream
        messages = self._messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(context_utilization="80%", preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is False

        assert messages == self._messages()

    @pytest.mark.asyncio
    async def test_leaves_reasoning_out_for_a_model_other_than_the_agent_model(self, mock_agent):
        aux_model = unittest.mock.AsyncMock()
        aux_model.count_tokens = unittest.mock.AsyncMock(return_value=5000)
        aux_model.summarize = unittest.mock.AsyncMock(return_value=_summary("aux summary"))
        aux_model.model_info.capabilities.server_side_summary = False
        mock_agent.aux_model = aux_model
        messages = self._messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(context_utilization="80%", preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        exp_request = self._messages()[:4]
        exp_request[1] = Message(role="assistant", content=[ContentBlock(text="old1")])
        assert aux_model.summarize.await_args.args[0] == exp_request

    @pytest.mark.asyncio
    async def test_leaves_the_history_unchanged_when_the_reply_holds_no_text(self, mock_agent, caplog):
        mock_agent.model.summarize = unittest.mock.AsyncMock(return_value=SummarizeResult())
        messages = self._messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(context_utilization="80%", preserve_recent=1)

        with caplog.at_level(logging.WARNING):
            assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is False

        assert messages == self._messages()
        assert "summary held no text" in caplog.text


class TestServerSideSummary:
    """Tests for summarizing through a model's server-side summary."""

    @staticmethod
    def _messages() -> Messages:
        return [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(role="assistant", content=[ContentBlock(text="old1")]),
            Message(role="user", content=[ContentBlock(text="old2")]),
            Message(role="assistant", content=[ContentBlock(text="old3")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]

    @pytest.mark.asyncio
    async def test_replaces_opening_run_with_server_side_summary(self, mock_agent):
        mock_agent.model.model_info.capabilities.server_side_summary = True
        summary = ContentBlock(summary={"provider": "anthropic", "text": "compacted"})
        mock_agent.model.summarize = unittest.mock.AsyncMock(return_value=SummarizeResult(content=[summary]))
        messages = self._messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(context_utilization="80%", preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        sent = mock_agent.model.summarize.call_args.args[0]
        assert [block["text"] for message in sent for block in message["content"]] == ["task", "old1", "old2", "old3"]
        assert messages == [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(role="assistant", content=[summary]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]

    @pytest.mark.asyncio
    async def test_places_a_summary_without_a_provider_as_a_client_side_marker(self, mock_agent):
        mock_agent.model.model_info.capabilities.server_side_summary = True
        mock_agent.model.summarize = unittest.mock.AsyncMock(return_value=_summary("written client-side"))
        messages = self._messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(context_utilization="80%", preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        mock_agent.model.count_tokens.assert_awaited_once_with(self._messages()[1:4])
        assert messages == [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(
                role="assistant",
                content=[_marker("written client-side")],
            ),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]

    @pytest.mark.asyncio
    async def test_falls_back_to_client_side_when_a_pin_is_summarized(self, caplog):
        messages = [
            _text("user", "task"),
            _text("assistant", "old1"),
            _pinned("pin"),
            _text("assistant", "old3"),
            _text("user", "recent"),
        ]
        agent, model = _mock_agent(messages, server_side_summary=True)
        model.summarize = unittest.mock.AsyncMock(return_value=_summary("compacted", "anthropic"))

        with caplog.at_level(logging.WARNING):
            assert await _per_message().apply(_agent_context(messages, agent, 0.9)) is True

        assert "pinned=<1> | server-side summary does not support pinned messages" in caplog.text
        # The pin splits the removable messages into two runs, and each run gets its own summary.
        assert model.summarize.await_count == 2
        assert messages == [
            _text("user", "task"),
            Message(role="assistant", content=[_marker("compacted")]),
            _pinned("pin"),
            Message(role="assistant", content=[_marker("compacted")]),
            _text("user", "recent"),
        ]

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("agent_supports", "aux_supports"),
        [pytest.param(False, True, id="agent_model_unsupported"), pytest.param(True, False, id="aux_unsupported")],
    )
    async def test_requires_both_models_to_support_server_side_summary(self, mock_agent, agent_supports, aux_supports):
        aux_model = unittest.mock.AsyncMock()
        aux_model.count_tokens = unittest.mock.AsyncMock(return_value=5000)
        aux_model.stream = _make_stream_events("Summary of content.")
        aux_model.summarize = _base_summarize(aux_model)
        aux_model.model_info.capabilities.server_side_summary = aux_supports
        mock_agent.aux_model = aux_model
        mock_agent.model.model_info.capabilities.server_side_summary = agent_supports
        messages = self._messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(context_utilization="80%", preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        assert messages == [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(role="assistant", content=[_marker("Summary of content.")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("summarize_result", "log"),
        [
            pytest.param(
                {"side_effect": RuntimeError("overloaded")}, "error=<overloaded> | summarization failed", id="error"
            ),
            pytest.param({"return_value": SummarizeResult()}, "summary held no text", id="empty"),
        ],
    )
    async def test_a_failed_server_side_summary_leaves_the_history_unchanged(
        self, mock_agent, caplog, summarize_result, log
    ):
        mock_agent.model.model_info.capabilities.server_side_summary = True
        mock_agent.model.summarize = unittest.mock.AsyncMock(**summarize_result)
        messages = self._messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(context_utilization="80%", preserve_recent=1)

        with caplog.at_level(logging.WARNING):
            assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is False

        mock_agent.model.summarize.assert_awaited_once()
        assert messages == self._messages()
        assert log in caplog.text

    @pytest.mark.asyncio
    async def test_warns_that_a_client_side_summary_drops_kept_thinking(self, mock_agent, caplog):
        mock_agent.model.model_info.capabilities.server_side_summary = True
        mock_agent.model.summarize = unittest.mock.AsyncMock(return_value=_summary("written client-side"))
        messages = self._messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(context_utilization="80%", preserve_recent=1)

        with caplog.at_level(logging.WARNING):
            assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        assert messages == [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(role="assistant", content=[_marker("written client-side")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]
        assert "thinking blocks kept after it will be dropped" in caplog.text

    @pytest.mark.asyncio
    async def test_sends_an_earlier_server_side_summary_with_the_opening_messages(self, mock_agent):
        mock_agent.model.model_info.capabilities.server_side_summary = True
        earlier = ContentBlock(summary={"provider": "anthropic", "text": "fact"})
        mock_agent.model.summarize = unittest.mock.AsyncMock(return_value=_summary("compacted", "anthropic"))
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(role="assistant", content=[earlier]),
            Message(role="user", content=[ContentBlock(text="old1")]),
            Message(role="assistant", content=[ContentBlock(text="old2")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(context_utilization="80%", preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        mock_agent.model.summarize.assert_awaited_once_with(
            [
                Message(role="user", content=[ContentBlock(text="task")]),
                Message(role="assistant", content=[earlier]),
                Message(role="user", content=[ContentBlock(text="old1")]),
                Message(role="assistant", content=[ContentBlock(text="old2")]),
            ],
            **_replay_kwargs(mock_agent),
        )
        assert messages == [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(role="assistant", content=[ContentBlock(summary={"provider": "anthropic", "text": "compacted"})]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]


class TestClientSideSummariesUseModelSummarize:
    """Tests that client-side summaries are written by Model.summarize."""

    @pytest.mark.asyncio
    async def test_a_provider_override_writes_client_side_summaries(self):
        messages = _tool_result_messages()
        agent, model = _mock_agent(messages)
        model.summarize = unittest.mock.AsyncMock(return_value=_summary("provider summary"))

        assert await _per_block().apply(_agent_context(messages, agent, 0.5)) is True

        assert messages[1] == _summarized_tool_result("provider summary")
        call = model.summarize.await_args_list[0]
        assert call.args[0] == self._block_request("[tool result]", "x" * 10000)
        assert "tool_specs" not in call.kwargs
        assert "system_prompt" not in call.kwargs

    @pytest.mark.asyncio
    async def test_a_server_side_model_writes_block_summaries_as_text(self):
        messages = _tool_result_messages()
        agent, model = _mock_agent(messages, server_side_summary=True)
        model.summarize = unittest.mock.AsyncMock(return_value=_summary("compacted", "anthropic"))

        assert await _per_block().apply(_agent_context(messages, agent, 0.5)) is True

        assert model.summarize.await_count == 1
        assert messages[1] == _summarized_tool_result("compacted")

    @pytest.mark.asyncio
    async def test_a_failed_per_message_summary_leaves_the_history_unchanged(self, caplog):
        messages = _server_side_messages()
        agent, model = _mock_agent(messages)
        model.summarize = unittest.mock.AsyncMock(side_effect=RuntimeError("throttled"))

        with caplog.at_level(logging.WARNING):
            assert await _per_message().apply(_agent_context(messages, agent, 0.9)) is False

        assert messages == _server_side_messages()
        assert "error=<throttled> | summarization failed" in caplog.text

    @pytest.mark.asyncio
    async def test_a_block_summary_sends_a_tool_result_after_its_tool_name(self, mock_agent):
        tool_use = ContentBlock(toolUse=ToolUse(toolUseId="t1", name="read_file", input={"path": "a.py"}))
        messages = _tool_result_messages()
        messages.insert(1, Message(role="assistant", content=[tool_use]))
        tool_result = messages[2]["content"][0]
        mock_agent.messages = messages
        strategy = Offload.summarize("tool_results").when(block_threshold=100)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.5)) is True

        assert mock_agent.model.summarize.await_args.args[0] == [
            Message(
                role="user",
                content=[
                    ContentBlock(text="<content>"),
                    ContentBlock(text="[tool result: read_file]"),
                    ContentBlock(text=tool_result["toolResult"]["content"][0]["text"]),
                    ContentBlock(text="</content>"),
                ],
            )
        ]

    @pytest.mark.asyncio
    async def test_a_custom_system_prompt_reaches_client_side_summaries(self, mock_agent):
        mock_agent.model.summarize = unittest.mock.AsyncMock(return_value=_summary("provider summary"))
        messages = _tool_result_messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("tool_results", {"system_prompt": "Be very brief."}).when(block_threshold=100)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.5)) is True

        assert mock_agent.model.summarize.await_args.kwargs["instructions"] == "Be very brief."

    @pytest.mark.asyncio
    async def test_a_custom_system_prompt_reaches_run_summaries(self, mock_agent):
        mock_agent.model.summarize = unittest.mock.AsyncMock(return_value=_summary("provider summary"))
        messages = TestServerSideSummary._messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("*", {"system_prompt": "Be very brief."}).when(
            context_utilization="80%", preserve_recent=1
        )

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        mock_agent.model.summarize.assert_awaited_once_with(
            TestServerSideSummary._messages()[:4], **_replay_kwargs(mock_agent, "Be very brief.")
        )

    @pytest.mark.asyncio
    async def test_a_block_summary_sends_the_block_instructions_without_a_system_prompt(self, mock_agent):
        messages = _tool_result_messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("tool_results").when(block_threshold=100)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.5)) is True

        assert mock_agent.model.summarize.await_args.kwargs == {
            "instructions": BLOCK_SUMMARY_INSTRUCTIONS,
            "cancel_signal": mock_agent._cancel_signal,
            "agent_metadata": mock_agent._metadata,
        }

    @pytest.mark.asyncio
    @pytest.mark.parametrize("server_side_summary", [False, True])
    async def test_a_block_summary_adds_its_usage_to_the_request(self, mock_agent, server_side_summary):
        mock_agent.model.model_info.capabilities.server_side_summary = server_side_summary
        messages = _tool_result_messages()
        mock_agent.messages = messages
        request = _create_invocation_context()
        strategy = Offload.summarize("tool_results").when(block_threshold=100)

        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5, invocation_context=request)
        assert await strategy.apply(context) is True

        assert request.usage == {"turns_taken": 0, "inputTokens": 10, "outputTokens": 5, "totalTokens": 15}

    @pytest.mark.asyncio
    async def test_a_per_message_summary_adds_its_usage_to_the_request(self, mock_agent):
        messages = TestServerSideSummary._messages()
        mock_agent.messages = messages
        request = _create_invocation_context()
        strategy = Offload.summarize("*").when(context_utilization="80%", preserve_recent=1)

        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9, invocation_context=request)
        assert await strategy.apply(context) is True

        assert request.usage == {"turns_taken": 0, "inputTokens": 10, "outputTokens": 5, "totalTokens": 15}

    @pytest.mark.asyncio
    @pytest.mark.parametrize("content", [[ContentBlock(summary={"provider": "anthropic", "text": "compacted"})], []])
    async def test_a_server_side_summary_adds_its_usage_to_the_request(self, mock_agent, content):
        mock_agent.model.model_info.capabilities.server_side_summary = True
        usage = Usage(inputTokens=100, outputTokens=20, totalTokens=120)
        mock_agent.model.summarize = unittest.mock.AsyncMock(return_value=SummarizeResult(content, usage))
        messages = TestServerSideSummary._messages()
        mock_agent.messages = messages
        request = _create_invocation_context()
        strategy = Offload.summarize("*").when(context_utilization="80%", preserve_recent=1)

        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9, invocation_context=request)
        assert await strategy.apply(context) is bool(content)

        assert request.usage == {"turns_taken": 0, "inputTokens": 100, "outputTokens": 20, "totalTokens": 120}

    @pytest.mark.asyncio
    async def test_warns_when_summarize_returns_no_text(self, mock_agent, caplog):
        mock_agent.model.summarize = unittest.mock.AsyncMock(return_value=SummarizeResult())
        messages = _tool_result_messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("tool_results").when(block_threshold=100)

        with caplog.at_level(logging.WARNING):
            assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.5)) is False

        assert "summary held no text" in caplog.text
        assert messages == _tool_result_messages()

    @staticmethod
    def _block_request(label: str, content: str) -> Messages:
        """The self-contained request one block's summary sends."""
        return [
            Message(
                role="user",
                content=[
                    ContentBlock(text="<content>"),
                    ContentBlock(text=label),
                    ContentBlock(text=content),
                    ContentBlock(text="</content>"),
                ],
            )
        ]

    @pytest.mark.asyncio
    async def test_a_block_summary_labels_a_failed_tool_result_with_its_status(self):
        failure = "x" * 10000
        tool_use = ContentBlock(toolUse=ToolUse(toolUseId="t1", name="bash", input={}))
        tool_result = ToolResult(toolUseId="t1", status="error", content=[{"text": failure}])
        messages = [
            Message(role="assistant", content=[tool_use]),
            Message(role="user", content=[ContentBlock(toolResult=tool_result)]),
        ]
        agent, model = _mock_agent(messages)
        strategy = Offload.summarize("tool_result_errors").when(block_threshold=100)

        assert await strategy.apply(_agent_context(messages, agent, 0.5)) is True

        assert model.summarize.await_args_list[0].args[0] == self._block_request("[tool result: bash (error)]", failure)


class TestConditionsDecideWhenItFires:
    """Tests that the conditions decide only when the strategy fires."""

    @pytest.mark.asyncio
    async def test_fires_when_utilization_exceeds_threshold(self):
        messages = [_text("user", "initial question"), make_tool_result_message(LARGE_TEXT), _text("assistant", "last")]
        strategy = Offload.summarize("tool_results").when(context_utilization="85%")

        assert await strategy.apply(_context(messages, 0.9)) is True

    @pytest.mark.asyncio
    async def test_skips_when_utilization_is_below_threshold(self):
        messages = [make_tool_result_message(LARGE_TEXT)]
        strategy = Offload.summarize("tool_results").when(context_utilization="85%")

        assert await strategy.apply(_context(messages, 0.5)) is False

    @pytest.mark.asyncio
    async def test_returns_false_on_empty_messages(self):
        assert await Offload.summarize("tool_results").apply(_context([], 0.9)) is False

    @pytest.mark.asyncio
    async def test_returns_false_when_blocks_are_below_threshold(self):
        messages = [make_tool_result_message("short result")]
        strategy = Offload.summarize("tool_results").when(block_threshold=2500)

        assert await strategy.apply(_context(messages, 0.9)) is False


class TestSummarizingMessageRuns:
    """Tests that a message-level pass summarizes each contiguous run on its own."""

    @pytest.mark.asyncio
    async def test_summarizes_each_contiguous_run_separately_around_pinned_messages(self):
        summarize = unittest.mock.AsyncMock(side_effect=[_summary("late run"), _summary("early run")])
        pin = {"metadata": {"custom": {"pinned": True}}}
        messages = [
            _text("user", "task"),
            Message(role="assistant", content=[ContentBlock(text="a1")], **pin),
            _text("user", "u2"),
            _text("assistant", "a3"),
            _text("user", "u4"),
            Message(role="assistant", content=[ContentBlock(text="a5")], **pin),
            _text("user", "u6"),
            _text("assistant", "a7"),
            _text("user", "u8"),
            _text("assistant", "a9"),
            _text("user", "u10"),
        ]
        strategy = Offload.summarize("*").when(context_utilization="50%", preserve_recent=3)

        assert await strategy.apply(_context(messages, 0.9, summarize=summarize)) is True

        assert summarize.await_count == 2
        assert _texts(messages) == [
            ["task"],
            [
                "a1",
                "[Summarized: earlier messages, ~3 tokens]\n\nearly run",
                "a5",
                "[Summarized: earlier messages, ~2 tokens]\n\nlate run",
            ],
            ["u8"],
            ["a9"],
            ["u10"],
        ]

    @pytest.mark.asyncio
    async def test_leaves_a_failed_run_intact_and_still_summarizes_the_others(self, caplog):
        summarize = unittest.mock.AsyncMock(side_effect=[_summary("late run"), RuntimeError("throttled")])
        messages = [
            _text("user", "task"),
            _text("assistant", "a1"),
            _text("user", "u2"),
            _text("assistant", "a3"),
            _pinned("u4"),
            _text("assistant", "a5"),
            _text("user", "u6"),
            _text("assistant", "a7"),
        ]
        strategy = Offload.summarize("*").when(context_utilization="50%", preserve_recent=1)

        with caplog.at_level(logging.WARNING):
            assert await strategy.apply(_context(messages, 0.9, summarize=summarize)) is True

        texts = _texts(messages)
        assert texts[:5] == [["task"], ["a1"], ["u2"], ["a3"], ["u4"]]
        assert format_summarized(REMOVED_MESSAGES, 2, "late run") in texts[5]


class TestABlockThresholdOnTheMessageTarget:
    """Tests that a block threshold on ``"*"`` selects messages by size, client-side."""

    @pytest.mark.asyncio
    async def test_warns_once_that_a_block_threshold_rules_out_the_server_side_summary(self, caplog):
        strategy = _size_filtered()
        first, second = _size_filtered_messages(), _size_filtered_messages()
        agent, model = _mock_agent(first, server_side_summary=True)
        model.summarize = unittest.mock.AsyncMock(return_value=_summary("compacted", "anthropic"))

        with caplog.at_level(logging.WARNING):
            assert await strategy.apply(_agent_context(first, agent, 0.9)) is True
            assert await strategy.apply(_agent_context(second, agent, 0.9)) is True

        skips = [
            record.getMessage() for record in caplog.records if "cannot honour a block_threshold" in record.message
        ]
        assert len(skips) == 1
        assert "block_threshold=<100> | a server-side summary covers the conversation" in skips[0]

    @pytest.mark.asyncio
    async def test_summarizes_client_side_when_a_block_threshold_selects_messages_by_size(self, caplog):
        messages = _size_filtered_messages()
        agent, model = _mock_agent(messages, server_side_summary=True)
        model.summarize = unittest.mock.AsyncMock(return_value=_summary("compacted", "anthropic"))
        model.count_tokens = unittest.mock.AsyncMock(side_effect=heuristic_count_tokens)
        big_tokens = heuristic_count_tokens([messages[3]])

        with caplog.at_level(logging.WARNING):
            assert await _size_filtered().apply(_agent_context(messages, agent, 0.9)) is True

        # A server-side summary covers the conversation's start, so it can't honour a per-message size filter.
        assert _texts(messages) == [
            ["task"],
            ["small a1"],
            ["small u2"],
            [format_summarized(REMOVED_MESSAGES, big_tokens, "compacted")],
            ["small u4"],
            ["small a5"],
            ["last"],
        ]

    @pytest.mark.asyncio
    async def test_summarizes_client_side_when_message_0_holds_a_tool_use(self):
        tool_use = ContentBlock(toolUse=ToolUse(toolUseId="t0", name="read", input={}))
        messages = [
            Message(role="assistant", content=[tool_use]),
            make_tool_result_message("done", "t0"),
            *_server_side_messages()[1:],
        ]
        agent, model = _mock_agent(messages, server_side_summary=True)
        model.summarize = unittest.mock.AsyncMock(return_value=_summary("compacted", "anthropic"))

        await _per_message().apply(_agent_context(messages, agent, 0.9))

        assert messages[0]["content"] == [tool_use]
        assert not any("summary" in block for message in messages for block in message["content"])


class TestSummarizerDiagnosticsAndModelChoice:
    """Tests the summarizer's logging, usage accounting and model resolution."""

    @pytest.mark.asyncio
    async def test_logs_why_a_media_block_was_offloaded_unsummarized(self, caplog):
        image = ContentBlock(image={"format": "png", "source": {"bytes": b"\x00" * 4000}})
        messages = [_text("user", "task"), Message(role="user", content=[image]), _text("user", "last")]
        model = heuristic_model(summarize=unittest.mock.AsyncMock(side_effect=RuntimeError("images unsupported")))
        strategy = Offload.summarize("media", {"model": model}).when(context_utilization="50%", block_threshold=10)

        with caplog.at_level(logging.WARNING):
            assert await strategy.apply(_context(messages, 0.9)) is True

        assert "error=<images unsupported>" in caplog.text

    @pytest.mark.asyncio
    async def test_adds_the_summarizer_usage_to_the_request_even_when_the_limit_is_used_up(self):
        usage = Usage(inputTokens=4, outputTokens=5, totalTokens=9)
        summarizer = heuristic_model(
            summarize=unittest.mock.AsyncMock(
                return_value=SummarizeResult(content=_summary("Summary of tool output").content, usage=usage)
            )
        )
        messages = [make_tool_result_message(LARGE_TEXT)]
        request = _create_invocation_context({"turns": 1})
        request.usage["turns_taken"] = 5
        strategy = Offload.summarize("tool_results", {"model": summarizer})

        assert await strategy.apply(_agent_context(messages, make_agent(messages), 0.9, request)) is True

        preview = format_summarized("tool result", 2525, "Summary of tool output")
        tool_result = ToolResult(
            toolUseId="tool-123", status="success", content=[offload_placeholder("summarize", preview, None, 2525)]
        )
        assert messages[0]["content"] == [ContentBlock(toolResult=tool_result)]
        assert request.usage == {"turns_taken": 5, **usage}

    @pytest.mark.asyncio
    async def test_summarizes_with_the_agents_aux_model_when_the_strategy_has_no_model(self):
        messages = [make_tool_result_message(LARGE_TEXT)]
        main_model = heuristic_model(summarize=_mock_summarize())
        aux_model = heuristic_model(summarize=_mock_summarize())
        context = make_context(messages, utilization=0.9, model=main_model)
        context.agent.aux_model = aux_model

        assert await Offload.summarize("tool_results").apply(context) is True

        aux_model.summarize.assert_awaited_once()
        main_model.summarize.assert_not_awaited()

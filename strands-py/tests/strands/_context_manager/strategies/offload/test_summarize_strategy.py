"""Tests for the SummarizeStrategy."""

import logging
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
from strands.types.content import ContentBlock, Message, Messages, SummaryBlock
from strands.types.event_loop import Usage
from strands.types.tools import ToolResult, ToolUse
from tests.fixtures.context_manager_helpers import (
    heuristic_count_tokens,
    heuristic_model,
    make_agent,
    make_context,
    make_tool_result_message,
    placeholders_in,
)

AGENT_PROMPT = [{"text": "You are a coding agent."}]
AGENT_TOOLS = [{"name": "shell", "description": "Run a command", "inputSchema": {"json": {}}}]
INSTRUCTIONS = ContentBlock(text=f"{_SUMMARIZE_GUARD}\n\n{DEFAULT_SUMMARIZE_INSTRUCTIONS}")
STREAM_USAGE = {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}
LARGE_TEXT = "x" * (2500 * 4 + 100)


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


def _base_summarize(model: Any) -> unittest.mock.AsyncMock:
    """A ``summarize`` spy running the base implementation on ``model``."""

    async def summarize(messages: Messages, **kwargs: Any) -> SummarizeResult:
        return await Model.summarize(model, messages, **kwargs)

    return unittest.mock.AsyncMock(side_effect=summarize)


def _summary(text: str, provider: str | None = None) -> SummarizeResult:
    return SummarizeResult(content=[ContentBlock(summary=SummaryBlock(provider=provider, text=text))])


def _mock_summarize() -> unittest.mock.AsyncMock:
    """A ``summarize`` mock replying with a client-side summary."""
    return unittest.mock.AsyncMock(return_value=_summary("Summary of multimodal content"))


def _context(messages: Messages, utilization: float = 0.5, **members: Any) -> ContextState:
    """A context whose model counts tokens heuristically and replies with a mocked ``summarize``."""
    model = heuristic_model(**{"summarize": _mock_summarize(), **members})
    return make_context(messages, utilization=utilization, model=model)


def _base_model(server_side_summary: bool = False, text: str = "Summary of content.") -> unittest.mock.MagicMock:
    """A model whose ``summarize`` runs the base implementation over a stream replying ``text``."""
    model = heuristic_model(count_tokens=unittest.mock.AsyncMock(return_value=5000))
    model.stream = unittest.mock.MagicMock(side_effect=_stream_events(text))
    model.summarize = _base_summarize(model)
    model.get_config = unittest.mock.MagicMock(return_value={"model_id": "claude-haiku-5-5"})
    model.model_info.capabilities.server_side_summary = server_side_summary
    return model


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


def _agent_context(messages: Messages, agent: Any, utilization: float, request: Any = None) -> ContextState:
    """A context over an agent :func:`_mock_agent` built."""
    return ContextState(messages=messages, agent=agent, utilization=utilization, invocation_context=request)


def _replay_kwargs(agent: Any, instructions: str | None = None) -> dict[str, Any]:
    """The keyword arguments a run summary passes to ``summarize()`` for ``agent``."""
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


def _text(role: str, text: str) -> Message:
    return Message(role=role, content=[ContentBlock(text=text)])


def _pinned(text: str) -> Message:
    return Message(role="user", content=[ContentBlock(text=text)], metadata={"custom": {"pinned": True}})


def _texts(messages: Messages) -> list[list[str]]:
    """The text of every block, message by message."""
    return [[block["text"] for block in message["content"]] for message in messages]


def _server_side_messages() -> Messages:
    return [
        _text("user", "task"),
        _text("assistant", "old1"),
        _text("user", "old2"),
        _text("assistant", "old3"),
        _text("user", "recent"),
    ]


def _tool_result_messages() -> Messages:
    tool_result = ToolResult(toolUseId="t1", status="success", content=[{"text": "x" * 10000}])
    return [_text("user", "task"), Message(role="user", content=[ContentBlock(toolResult=tool_result)])]


def _summarized_tool_result(summary: str) -> Message:
    placeholder = offload_placeholder("summarize", format_summarized("tool result", 5000, summary), None, 5000)
    tool_result = ToolResult(toolUseId="t1", status="success", content=[placeholder])
    return Message(role="user", content=[ContentBlock(toolResult=tool_result)])


def _per_message():
    return Offload.summarize("*").when(context_utilization="80%", preserve_recent=1)


def _per_block(config: Any = None):
    return Offload.summarize("tool_results", config).when(block_threshold=100)


class TestApply:
    @pytest.mark.asyncio
    async def test_returns_false_when_no_model_is_available(self):
        messages = [make_tool_result_message(LARGE_TEXT)]
        context = make_context(messages)
        context.agent.aux_model = None

        assert await Offload.summarize("tool_results").apply(context) is False

    @pytest.mark.asyncio
    async def test_returns_false_when_blocks_are_below_threshold(self):
        messages = [make_tool_result_message("short result")]
        strategy = Offload.summarize("tool_results").when(block_threshold=2500)

        assert await strategy.apply(_context(messages, 0.9)) is False

    @pytest.mark.asyncio
    async def test_summarizes_large_tool_results(self):
        messages = [make_tool_result_message(LARGE_TEXT)]

        assert await Offload.summarize("tool_results").apply(_context(messages, 0.9)) is True

        assert "[Summarized:" in messages[0]["content"][0]["toolResult"]["content"][0]["text"]

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

    @pytest.mark.parametrize(("role", "target"), [("assistant", "assistant_text"), ("user", "user_text")])
    @pytest.mark.asyncio
    async def test_summarizes_text_blocks(self, role, target):
        message = _text(role, LARGE_TEXT)

        assert await Offload.summarize(target).apply(_context([message], 0.9)) is True

        assert "[Summarized:" in message["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_skips_when_utilization_is_below_threshold(self):
        messages = [make_tool_result_message(LARGE_TEXT)]
        strategy = Offload.summarize("tool_results").when(context_utilization="85%")

        assert await strategy.apply(_context(messages, 0.5)) is False

    @pytest.mark.asyncio
    async def test_fires_when_utilization_exceeds_threshold(self):
        messages = [_text("user", "initial question"), make_tool_result_message(LARGE_TEXT), _text("assistant", "last")]
        strategy = Offload.summarize("tool_results").when(context_utilization="85%")

        assert await strategy.apply(_context(messages, 0.9)) is True

    @pytest.mark.asyncio
    async def test_returns_false_on_empty_messages(self):
        assert await Offload.summarize("tool_results").apply(_context([], 0.9)) is False


class TestRequestLimits:
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


class TestSummarizerErrors:
    @pytest.mark.asyncio
    async def test_keeps_a_block_and_continues_the_pass_when_its_summarization_fails(self, caplog):
        """A summarizer failure is never hidden by a lossy retry (#5291)."""
        summarize = unittest.mock.AsyncMock(side_effect=[RuntimeError("rejected"), _summary("second")])
        messages = [make_tool_result_message(LARGE_TEXT, "call_1"), make_tool_result_message(LARGE_TEXT, "call_2")]

        with caplog.at_level(logging.WARNING):
            assert await Offload.summarize("tool_results").apply(_context(messages, 0.9, summarize=summarize)) is True

        assert messages[0]["content"][0]["toolResult"]["content"][0]["text"] == LARGE_TEXT
        assert "[Summarized:" in messages[1]["content"][0]["toolResult"]["content"][0]["text"]
        assert "error=<rejected>" in caplog.text

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

    @pytest.mark.asyncio
    async def test_logs_why_a_media_block_was_offloaded_unsummarized(self, caplog):
        image = ContentBlock(image={"format": "png", "source": {"bytes": b"\x00" * 4000}})
        messages = [_text("user", "task"), Message(role="user", content=[image]), _text("user", "last")]
        model = heuristic_model(summarize=unittest.mock.AsyncMock(side_effect=RuntimeError("images unsupported")))
        strategy = Offload.summarize("media", {"model": model}).when(context_utilization="50%", block_threshold=10)

        with caplog.at_level(logging.WARNING):
            assert await strategy.apply(_context(messages, 0.9)) is True

        assert "error=<images unsupported>" in caplog.text


class TestRepeatedSummarization:
    @pytest.mark.asyncio
    async def test_keeps_summaries_out_of_a_pinned_message_0(self):
        """A pinned first message keeps its own content across repeated passes (#4685)."""
        strategy = Offload.summarize("*").when(context_utilization="70%", preserve_recent=4)
        task = _pinned("task")
        messages = [dict(task)]
        for index in range(30):
            tool_use = ToolUse(toolUseId=f"t{index}", name="read", input={})
            messages.append(Message(role="assistant", content=[ContentBlock(toolUse=tool_use)]))
            messages.append(make_tool_result_message("x", f"t{index}"))
            await strategy.apply(_context(messages, 0.9))

        assert messages[0] == task
        assert [placeholder["method"] for placeholder in placeholders_in(messages)] == ["summarize"]


class TestSummarizingMessageRuns:
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


class TestPerBlockCancellationAndPlacement:
    @staticmethod
    def _tool_results() -> Messages:
        return [
            Message(
                role="user",
                content=[
                    ContentBlock(
                        toolResult=ToolResult(
                            toolUseId=f"call_{index}", status="success", content=[{"text": "x" * 10000}]
                        )
                    )
                ],
            )
            for index in range(5)
        ]

    @pytest.mark.asyncio
    async def test_stops_sending_requests_after_a_cancel(self, caplog):
        messages = self._tool_results()
        agent, model = _mock_agent(messages)
        model.stream = unittest.mock.MagicMock(side_effect=_stream_events("partial", agent._cancel_signal.set))

        with caplog.at_level(logging.WARNING):
            assert await _per_block().apply(_agent_context(messages, agent, 0.5)) is False

        assert model.stream.call_count == 1
        assert messages == self._tool_results()

    @pytest.mark.asyncio
    async def test_skips_a_run_summary_once_cancelled(self):
        messages = _server_side_messages()
        agent, model = _mock_agent(messages)
        agent._cancel_signal.set()

        assert await _per_message().apply(_agent_context(messages, agent, 0.9)) is False

        model.stream.assert_not_called()
        assert messages == _server_side_messages()

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


class TestASummarizedRunReplaysTheAgentRequest:
    @pytest.mark.asyncio
    async def test_replays_tool_calls_in_a_single_model_call(self):
        """A rejected request is never retried text-only, which would drop the tool calls (#5291)."""
        tool_use = ContentBlock(toolUse=ToolUse(toolUseId="call_1", name="shell", input={"command": "ls"}))
        tool_result = ContentBlock(
            toolResult=ToolResult(toolUseId="call_1", status="success", content=[{"text": "a.ts b.ts"}])
        )
        messages = [
            _text("user", "fix the build"),
            Message(role="assistant", content=[tool_use]),
            Message(role="user", content=[tool_result]),
            _text("assistant", "done"),
            _text("user", "next"),
        ]
        agent, model = _mock_agent(messages)
        strategy = Offload.summarize("*").when(context_utilization="70%", preserve_recent=2)

        assert await strategy.apply(_agent_context(messages, agent, 0.9)) is True

        assert model.stream.call_count == 1
        sent, tool_specs, system_prompt = model.stream.call_args.args
        assert sent == [
            _text("user", "fix the build"),
            Message(role="assistant", content=[tool_use]),
            Message(role="user", content=[tool_result, INSTRUCTIONS]),
        ]
        assert (tool_specs, system_prompt) == (AGENT_TOOLS, "You are a coding agent.")
        assert model.stream.call_args.kwargs["system_prompt_content"] == AGENT_PROMPT
        assert model.stream.call_args.kwargs["cancel_signal"] is agent._cancel_signal
        assert model.stream.call_args.kwargs["agent_metadata"] is agent._metadata

    @pytest.mark.asyncio
    async def test_sends_the_history_prefix_with_the_agent_prompt_and_tools(self):
        messages = _replay_messages()
        agent, model = _mock_agent(messages)

        assert await _per_message().apply(_agent_context(messages, agent, 0.9)) is True

        model.summarize.assert_awaited_once_with(_replay_messages()[:4], **_replay_kwargs(agent))

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
    async def test_replays_the_prefix_as_sent_when_it_holds_adjacent_same_role_messages(self):
        messages = [
            _text("user", "task"),
            _text("user", "more task"),
            _text("assistant", "old1"),
            _text("user", "recent"),
        ]
        agent, model = _mock_agent(messages)

        assert await _per_message().apply(_agent_context(messages, agent, 0.9)) is True

        expected = [_text("user", "task"), _text("user", "more task"), _text("assistant", "old1")]
        model.summarize.assert_awaited_once_with(expected, **_replay_kwargs(agent))

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
    async def test_sends_no_system_prompt_for_an_agent_without_one(self):
        messages = _replay_messages()
        agent, model = _mock_agent(messages, system_prompt=None)

        assert await _per_message().apply(_agent_context(messages, agent, 0.9)) is True

        assert model.stream.call_args.args[2] is None
        assert model.stream.call_args.kwargs["system_prompt_content"] is None

    @pytest.mark.asyncio
    async def test_leaves_the_history_unchanged_when_cancelled_mid_summary(self, caplog):
        messages = _replay_messages()
        agent, model = _mock_agent(messages)
        model.stream = unittest.mock.MagicMock(side_effect=_stream_events("partial", agent._cancel_signal.set))

        with caplog.at_level(logging.WARNING):
            assert await _per_message().apply(_agent_context(messages, agent, 0.9)) is False

        assert messages == _replay_messages()

    @pytest.mark.asyncio
    async def test_leaves_reasoning_out_for_a_model_other_than_the_agent_model(self):
        messages = _replay_messages()
        aux_model = heuristic_model(
            summarize=unittest.mock.AsyncMock(return_value=_summary("aux summary")),
            count_tokens=unittest.mock.AsyncMock(return_value=5000),
        )
        agent, _ = _mock_agent(messages)
        agent.aux_model = aux_model

        assert await _per_message().apply(_agent_context(messages, agent, 0.9)) is True

        expected = _replay_messages()[:4]
        expected[1] = _text("assistant", "old1")
        assert aux_model.summarize.await_args_list[0].args[0] == expected

    @pytest.mark.asyncio
    async def test_leaves_the_history_unchanged_when_the_reply_holds_no_text(self, caplog):
        messages = _replay_messages()
        agent, model = _mock_agent(messages)
        model.summarize = unittest.mock.AsyncMock(return_value=SummarizeResult())

        with caplog.at_level(logging.WARNING):
            assert await _per_message().apply(_agent_context(messages, agent, 0.9)) is False

        assert messages == _replay_messages()
        assert "summary held no text" in caplog.text

    @pytest.mark.asyncio
    async def test_sends_an_earlier_server_side_summary_with_the_run_that_replaces_it(self):
        earlier = ContentBlock(summary=SummaryBlock(provider="anthropic", text="fact"))
        messages = [
            _text("user", "task"),
            Message(role="assistant", content=[earlier]),
            _text("user", "old1"),
            _text("assistant", "old2"),
            _text("user", "recent"),
        ]
        agent, model = _mock_agent(messages)

        assert await _per_message().apply(_agent_context(messages, agent, 0.9)) is True

        assert model.summarize.await_args_list[0].args[0] == [
            _text("user", "task"),
            Message(role="assistant", content=[earlier]),
            _text("user", "old1"),
            _text("assistant", "old2"),
        ]


class _OtherModel(unittest.mock.MagicMock):
    """A model of another provider's class, so ``type(model)`` differs from the aux model's."""


def _server_side_model(model_class: Any = unittest.mock.MagicMock, model_id: str = "claude-haiku-5-5") -> Any:
    """A model reporting the server-side summary capability, counting every request as 5,000 tokens."""
    model = model_class()
    model.count_tokens = unittest.mock.AsyncMock(return_value=5000)
    model.summarize = _mock_summarize()
    model.get_config = unittest.mock.MagicMock(return_value={"model_id": model_id})
    model.model_info.capabilities.server_side_summary = True
    return model


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


def _size_filtered():
    return Offload.summarize("*").when(context_utilization="50%", block_threshold=100, preserve_recent=1)


class TestServerSideSummary:
    @pytest.mark.asyncio
    async def test_replaces_the_opening_run_with_the_server_side_summary(self):
        messages = _server_side_messages()
        agent, model = _mock_agent(messages, server_side_summary=True)
        summary = ContentBlock(summary=SummaryBlock(provider="anthropic", text="compacted"))
        model.summarize = unittest.mock.AsyncMock(return_value=SummarizeResult(content=[summary]))

        assert await _per_message().apply(_agent_context(messages, agent, 0.9)) is True

        sent = model.summarize.await_args_list[0].args[0]
        assert _texts(sent) == [["task"], ["old1"], ["old2"], ["old3"]]
        assert messages == [
            _text("user", "task"),
            Message(role="assistant", content=[summary]),
            _text("user", "recent"),
        ]

    @pytest.mark.asyncio
    async def test_places_a_summary_without_a_provider_as_a_client_side_marker(self, caplog):
        messages = _server_side_messages()
        agent, model = _mock_agent(messages, server_side_summary=True)
        model.summarize = unittest.mock.AsyncMock(return_value=_summary("written client-side"))

        with caplog.at_level(logging.WARNING):
            assert await _per_message().apply(_agent_context(messages, agent, 0.9)) is True

        assert model.count_tokens.await_count == 1
        assert model.count_tokens.await_args_list[0].args[0] == _server_side_messages()[1:4]
        assert messages == [
            _text("user", "task"),
            Message(role="assistant", content=[_marker("written client-side")]),
            _text("user", "recent"),
        ]

    @pytest.mark.parametrize(
        ("config", "instructions"),
        [({"system_prompt": "keep ids"}, "keep ids"), ({}, None)],
        ids=["with summarizer instructions", "without summarizer instructions"],
    )
    @pytest.mark.asyncio
    async def test_passes_the_live_system_prompt_and_tools_to_the_server_side_summary(self, config, instructions):
        tool_spec = {"name": "read", "description": "Read a file", "inputSchema": {"json": {}}}
        messages = _server_side_messages()
        agent, model = _mock_agent(messages, server_side_summary=True, system_prompt=[{"text": "be terse"}])
        agent.tool_registry.get_all_tool_specs.return_value = [tool_spec]
        model.summarize = unittest.mock.AsyncMock(return_value=_summary("compacted", "anthropic"))
        strategy = Offload.summarize("*", config).when(context_utilization="80%", preserve_recent=1)

        assert await strategy.apply(_agent_context(messages, agent, 0.9)) is True

        assert model.summarize.await_args_list[0].kwargs == {
            "tool_specs": [tool_spec],
            "system_prompt": "be terse",
            "system_prompt_content": [{"text": "be terse"}],
            "instructions": instructions,
            "cancel_signal": agent._cancel_signal,
            "agent_metadata": agent._metadata,
        }

    @pytest.mark.parametrize(
        "other",
        [{"model_id": "claude-opus-5-5"}, {"model_class": _OtherModel}],
        ids=["a different model id", "a different provider"],
    )
    @pytest.mark.asyncio
    async def test_summarizes_client_side_when_the_agent_model_is_another_one(self, other):
        # The agent's model is the one that replays the summary block, so only its own provider may write it.
        messages = _server_side_messages()
        agent = make_agent(messages, _server_side_model(**other))
        agent.aux_model = _server_side_model()

        assert await _per_message().apply(_agent_context(messages, agent, 0.9)) is True

        assert messages == [
            _text("user", "task"),
            Message(role="assistant", content=[_marker("Summary of multimodal content")]),
            _text("user", "recent"),
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
    async def test_falls_back_to_client_side_when_message_0_is_pinned(self, caplog):
        messages = _server_side_messages()
        messages[0] = _pinned("task")
        agent, model = _mock_agent(messages, server_side_summary=True)
        model.summarize = unittest.mock.AsyncMock(return_value=_summary("compacted", "anthropic"))

        with caplog.at_level(logging.WARNING):
            assert await _per_message().apply(_agent_context(messages, agent, 0.9)) is True

        assert messages == [
            _pinned("task"),
            Message(role="assistant", content=[_marker("compacted")]),
            _text("user", "recent"),
        ]
        assert "pinned=<1> | server-side summary does not support pinned messages" in caplog.text

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

    @pytest.mark.parametrize(
        ("agent_supports", "aux_supports"),
        [(False, True), (True, False)],
        ids=["agent model unsupported", "aux model unsupported"],
    )
    @pytest.mark.asyncio
    async def test_requires_both_models_to_support_server_side_summary(self, agent_supports, aux_supports):
        messages = _server_side_messages()
        agent, _ = _mock_agent(messages, server_side_summary=agent_supports)
        agent.aux_model = _base_model(aux_supports)

        assert await _per_message().apply(_agent_context(messages, agent, 0.9)) is True

        assert messages == [
            _text("user", "task"),
            Message(role="assistant", content=[_marker("Summary of content.")]),
            _text("user", "recent"),
        ]

    @pytest.mark.parametrize(
        ("result", "log"),
        [
            ({"side_effect": RuntimeError("overloaded")}, "error=<overloaded> | summarization failed"),
            ({"return_value": SummarizeResult()}, "summary held no text"),
        ],
        ids=["error", "empty"],
    )
    @pytest.mark.asyncio
    async def test_a_failed_server_side_summary_leaves_the_history_unchanged(self, caplog, result, log):
        messages = _server_side_messages()
        agent, model = _mock_agent(messages, server_side_summary=True)
        model.summarize = unittest.mock.AsyncMock(**result)

        with caplog.at_level(logging.WARNING):
            assert await _per_message().apply(_agent_context(messages, agent, 0.9)) is False

        assert model.summarize.await_count == 1
        assert messages == _server_side_messages()
        assert log in caplog.text

    @pytest.mark.asyncio
    async def test_warns_that_a_client_side_summary_drops_kept_thinking(self, caplog):
        messages = _server_side_messages()
        agent, model = _mock_agent(messages, server_side_summary=True)
        model.summarize = unittest.mock.AsyncMock(return_value=_summary("written client-side"))

        with caplog.at_level(logging.WARNING):
            assert await _per_message().apply(_agent_context(messages, agent, 0.9)) is True

        assert "thinking blocks kept after it will be dropped" in caplog.text

    @pytest.mark.asyncio
    async def test_sends_an_earlier_server_side_summary_with_the_opening_messages(self):
        earlier = ContentBlock(summary=SummaryBlock(provider="anthropic", text="fact"))
        messages = [
            _text("user", "task"),
            Message(role="assistant", content=[earlier]),
            _text("user", "old1"),
            _text("assistant", "old2"),
            _text("user", "recent"),
        ]
        agent, model = _mock_agent(messages, server_side_summary=True)
        model.summarize = unittest.mock.AsyncMock(return_value=_summary("compacted", "anthropic"))

        assert await _per_message().apply(_agent_context(messages, agent, 0.9)) is True

        expected = [
            _text("user", "task"),
            Message(role="assistant", content=[earlier]),
            _text("user", "old1"),
            _text("assistant", "old2"),
        ]
        model.summarize.assert_awaited_once_with(expected, **_replay_kwargs(agent))
        assert messages == [
            _text("user", "task"),
            Message(
                role="assistant", content=[ContentBlock(summary=SummaryBlock(provider="anthropic", text="compacted"))]
            ),
            _text("user", "recent"),
        ]


class TestClientSideSummariesUseModelSummarize:
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
    async def test_a_block_summary_sends_a_tool_result_after_its_tool_name(self):
        messages = _tool_result_messages()
        tool_use = ToolUse(toolUseId="t1", name="read_file", input={"path": "a.py"})
        messages.insert(1, Message(role="assistant", content=[ContentBlock(toolUse=tool_use)]))
        agent, model = _mock_agent(messages)

        assert await _per_block().apply(_agent_context(messages, agent, 0.5)) is True

        assert model.summarize.await_args_list[0].args[0] == self._block_request(
            "[tool result: read_file]", "x" * 10000
        )

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

    @pytest.mark.asyncio
    async def test_a_custom_system_prompt_reaches_client_side_summaries(self):
        messages = _tool_result_messages()
        agent, model = _mock_agent(messages)
        model.summarize = unittest.mock.AsyncMock(return_value=_summary("provider summary"))

        strategy = _per_block({"system_prompt": "Be very brief."})
        assert await strategy.apply(_agent_context(messages, agent, 0.5)) is True

        assert model.summarize.await_args_list[0].kwargs["instructions"] == "Be very brief."

    @pytest.mark.asyncio
    async def test_a_custom_system_prompt_reaches_run_summaries(self):
        messages = _server_side_messages()
        agent, model = _mock_agent(messages)
        model.summarize = unittest.mock.AsyncMock(return_value=_summary("provider summary"))
        strategy = Offload.summarize("*", {"system_prompt": "Be very brief."}).when(
            context_utilization="80%", preserve_recent=1
        )

        assert await strategy.apply(_agent_context(messages, agent, 0.9)) is True

        model.summarize.assert_awaited_once_with(_server_side_messages()[:4], **_replay_kwargs(agent, "Be very brief."))

    @pytest.mark.asyncio
    async def test_a_block_summary_sends_the_block_instructions_without_a_system_prompt(self):
        messages = _tool_result_messages()
        agent, model = _mock_agent(messages)

        assert await _per_block().apply(_agent_context(messages, agent, 0.5)) is True

        assert model.summarize.await_args_list[0].kwargs == {
            "instructions": BLOCK_SUMMARY_INSTRUCTIONS,
            "cancel_signal": agent._cancel_signal,
            "agent_metadata": agent._metadata,
        }

    @pytest.mark.parametrize("server_side_summary", [False, True])
    @pytest.mark.asyncio
    async def test_a_block_summary_adds_its_usage_to_the_request(self, server_side_summary):
        messages = _tool_result_messages()
        agent, _ = _mock_agent(messages, server_side_summary=server_side_summary)
        request = _create_invocation_context()

        assert await _per_block().apply(_agent_context(messages, agent, 0.5, request)) is True

        assert request.usage == {"turns_taken": 0, **STREAM_USAGE}

    @pytest.mark.asyncio
    async def test_a_per_message_summary_adds_its_usage_to_the_request(self):
        messages = _server_side_messages()
        agent, _ = _mock_agent(messages)
        request = _create_invocation_context()

        assert await _per_message().apply(_agent_context(messages, agent, 0.9, request)) is True

        assert request.usage == {"turns_taken": 0, **STREAM_USAGE}

    @pytest.mark.parametrize(
        "content",
        [[ContentBlock(summary=SummaryBlock(provider="anthropic", text="compacted"))], []],
        ids=["with a summary", "without a summary"],
    )
    @pytest.mark.asyncio
    async def test_a_server_side_summary_adds_its_usage_to_the_request(self, caplog, content):
        messages = _server_side_messages()
        agent, model = _mock_agent(messages, server_side_summary=True)
        usage = Usage(inputTokens=100, outputTokens=20, totalTokens=120)
        model.summarize = unittest.mock.AsyncMock(return_value=SummarizeResult(content=content, usage=usage))
        request = _create_invocation_context()

        with caplog.at_level(logging.WARNING):
            acted = await _per_message().apply(_agent_context(messages, agent, 0.9, request))

        assert acted is bool(content)
        assert request.usage == {"turns_taken": 0, **usage}

    @pytest.mark.asyncio
    async def test_warns_when_summarize_returns_no_text(self, caplog):
        messages = _tool_result_messages()
        agent, model = _mock_agent(messages)
        model.summarize = unittest.mock.AsyncMock(return_value=SummarizeResult())

        with caplog.at_level(logging.WARNING):
            assert await _per_block().apply(_agent_context(messages, agent, 0.5)) is False

        assert "summary held no text" in caplog.text
        assert messages == _tool_result_messages()

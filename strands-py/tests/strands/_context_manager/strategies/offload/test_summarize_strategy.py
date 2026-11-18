"""Tests for the SummarizeStrategy."""

import logging
import threading
import unittest.mock

import pytest

from strands._context_manager.strategies.offload import Offload
from strands._context_manager.strategies.offload.summarize import (
    _BLOCK_SUMMARY_INSTRUCTIONS,
    _format_summarized,
    _tool_result_to_content_blocks,
)
from strands._context_manager.types import ContextState
from strands.agent.invocation_context import _create_invocation_context
from strands.models import Model, SummarizeResult
from strands.models._summarize import _SUMMARIZE_GUARD, DEFAULT_SUMMARIZE_INSTRUCTIONS
from strands.types.content import ContentBlock, Message, Messages
from strands.types.event_loop import Usage
from strands.types.tools import ToolResult, ToolUse

AGENT_PROMPT = [{"text": "You are a coding agent."}]
AGENT_TOOLS = [{"name": "shell", "description": "Run a command", "inputSchema": {"json": {}}}]
INSTRUCTIONS = ContentBlock(text=f"{_SUMMARIZE_GUARD}\n\n{DEFAULT_SUMMARIZE_INSTRUCTIONS}")


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
    """Return the keyword arguments a batch summary passes to ``summarize()`` for ``agent``."""
    return {
        "tool_specs": AGENT_TOOLS,
        "system_prompt": "You are a coding agent.",
        "system_prompt_content": AGENT_PROMPT,
        "instructions": instructions,
        "cancel_signal": agent._cancel_signal,
        "agent_metadata": agent._metadata,
    }


def _marker(count: int, summary: str) -> ContentBlock:
    return ContentBlock(text=f"[Summarized: {count} messages, ~5,000 tokens]\n\n{summary}")


def _summary(text: str, provider: str | None = None) -> SummarizeResult:
    return SummarizeResult(content=[ContentBlock(summary={"provider": provider, "text": text})])


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
        strategy = Offload.summarize("tool_results").when(threshold=100)

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
        strategy = Offload.summarize("tool_results").when(threshold=100)

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
    async def test_skips_a_batch_summary_once_cancelled(self, mock_agent):
        mock_agent._cancel_signal.set()
        mock_agent.model.stream = unittest.mock.Mock()
        messages = TestServerSideSummary._messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is False

        mock_agent.model.stream.assert_not_called()
        assert messages == TestServerSideSummary._messages()

    @pytest.mark.asyncio
    async def test_places_only_the_first_summary_block(self, mock_agent):
        mock_agent.model.summarize = unittest.mock.AsyncMock(
            return_value=SummarizeResult(
                content=[
                    ContentBlock(summary={"provider": None, "text": "first"}),
                    ContentBlock(summary={"provider": None, "text": "second"}),
                ]
            )
        )
        messages = TestClientSideSummariesUseModelSummarize._tool_result_messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("tool_results").when(threshold=100)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.5)) is True

        assert messages[1] == TestClientSideSummariesUseModelSummarize._summarized_tool_result("first")

    @pytest.mark.asyncio
    async def test_offloads_video_block_without_summarizing(self, mock_agent):
        mock_agent.model.stream = unittest.mock.Mock()
        strategy = Offload.summarize("*").when(threshold=100)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(video={"format": "mp4", "source": {"bytes": b"video"}})]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)

        assert await strategy.apply(context) is True
        assert messages[0]["content"][0]["text"].startswith("[Offloaded:")
        mock_agent.model.stream.assert_not_called()

    @pytest.mark.asyncio
    async def test_offloads_media_block_when_summarization_fails(self, mock_agent, caplog):
        # guards against summarizer failures being hidden by a lossy retry (#5291)
        mock_agent.model.stream = unittest.mock.Mock(side_effect=RuntimeError("images unsupported"))
        strategy = Offload.summarize("*").when(threshold=100)
        messages: Messages = [
            Message(
                role="user",
                content=[ContentBlock(image={"format": "png", "source": {"bytes": b"img"}})],
            ),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)

        with caplog.at_level(logging.WARNING):
            assert await strategy.apply(context) is True
        assert "[Offloaded:" in messages[0]["content"][0]["text"]
        assert "error=<images unsupported>" in caplog.text


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
        strategy = Offload.summarize("*").when(utilization=0.7, preserve_recent=2)
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


class TestBatchSummaryReplaysTheAgentRequest:
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
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)

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
    async def test_counts_the_summarized_messages_as_the_model_receives_them(self, mock_agent):
        mock_agent.model.model_info.capabilities.server_side_summary = False
        mock_agent.model.model_info.capabilities.temporary_messages = None
        messages = self._messages()
        messages[2]["content"].append(ContentBlock(injected={"text": "<todos>v1</todos>", "source": "todos"}))
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        # Native counters reject a raw injected block, so it is counted in the form the model accepts.
        counted = self._messages()[1:4]
        counted[1] = Message(
            role="user", content=[ContentBlock(text="old2"), ContentBlock(text="\n\n<todos>v1</todos>")]
        )
        mock_agent.model.count_tokens.assert_awaited_once_with(counted)

    @pytest.mark.asyncio
    async def test_sends_only_the_replaced_messages_when_a_pin_is_kept(self, mock_agent):
        pinned = {"custom": {"pinned": True}}
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(role="assistant", content=[ContentBlock(text="old1")]),
            Message(role="user", content=[ContentBlock(text="pin")], metadata=pinned),
            Message(role="assistant", content=[ContentBlock(text="old3")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        assert mock_agent.model.summarize.await_args == unittest.mock.call(
            [
                Message(role="user", content=[ContentBlock(text="task")]),
                Message(role="assistant", content=[ContentBlock(text="old1"), ContentBlock(text="old3")]),
            ],
            **_replay_kwargs(mock_agent),
        )
        assert messages == [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(role="assistant", content=[_marker(2, "Summary of content.")]),
            Message(role="user", content=[ContentBlock(text="pin"), ContentBlock(text="recent")], metadata=pinned),
        ]

    @pytest.mark.asyncio
    async def test_sends_only_the_replaced_messages_when_a_threshold_skips_some(self, mock_agent):
        async def count_tokens(messages, *args, **kwargs):
            return 5000 if any("big" in block.get("text", "") for m in messages for block in m["content"]) else 10

        mock_agent.model.count_tokens = unittest.mock.AsyncMock(side_effect=count_tokens)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(role="assistant", content=[ContentBlock(text="big1")]),
            Message(role="user", content=[ContentBlock(text="question")]),
            Message(role="assistant", content=[ContentBlock(text="big2")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(utilization=0.8, threshold=100)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        assert mock_agent.model.summarize.await_args == unittest.mock.call(
            [
                Message(role="user", content=[ContentBlock(text="task")]),
                Message(role="assistant", content=[ContentBlock(text="big1"), ContentBlock(text="big2")]),
            ],
            **_replay_kwargs(mock_agent),
        )
        assert messages == [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(role="assistant", content=[_marker(2, "Summary of content.")]),
            Message(role="user", content=[ContentBlock(text="question"), ContentBlock(text="recent")]),
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
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)

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
    async def test_leaves_reasoning_out_when_a_gap_merges_assistant_turns(self, mock_agent):
        reasoning = ContentBlock(reasoningContent={"reasoningText": {"text": "think", "signature": "sig"}})
        pinned = {"custom": {"pinned": True}}
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(role="assistant", content=[reasoning, ContentBlock(text="old1")]),
            Message(role="user", content=[ContentBlock(text="pin")], metadata=pinned),
            Message(role="assistant", content=[reasoning, ContentBlock(text="old3")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        assert mock_agent.model.summarize.await_args == unittest.mock.call(
            [
                Message(role="user", content=[ContentBlock(text="task")]),
                Message(role="assistant", content=[ContentBlock(text="old1"), ContentBlock(text="old3")]),
            ],
            **_replay_kwargs(mock_agent),
        )

    @pytest.mark.asyncio
    async def test_sends_no_system_prompt_for_an_agent_without_one(self, mock_agent):
        mock_agent.system_prompt_content = None
        mock_agent.model.stream = unittest.mock.MagicMock(side_effect=_make_stream_events("Summary of content."))
        messages = self._messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)

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
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)

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
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        exp_request = self._messages()[:4]
        exp_request[1] = Message(role="assistant", content=[ContentBlock(text="old1")])
        assert aux_model.summarize.await_args.args[0] == exp_request

    @pytest.mark.asyncio
    async def test_leaves_the_history_unchanged_when_the_reply_holds_no_text(self, mock_agent, caplog):
        mock_agent.model.summarize = unittest.mock.AsyncMock(return_value=SummarizeResult())
        messages = self._messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)

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
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)

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
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        mock_agent.model.count_tokens.assert_awaited_once_with(self._messages()[1:4])
        assert messages == [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(
                role="assistant",
                content=[ContentBlock(text="[Summarized: 3 messages, ~5,000 tokens]\n\nwritten client-side")],
            ),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]

    @pytest.mark.asyncio
    async def test_counts_the_summarized_messages_as_the_model_receives_them(self, mock_agent):
        mock_agent.model.model_info.capabilities.server_side_summary = True
        mock_agent.model.model_info.capabilities.temporary_messages = None
        mock_agent.model.summarize = unittest.mock.AsyncMock(return_value=_summary("written client-side"))
        messages = self._messages()
        messages[2]["content"].append(ContentBlock(injected={"text": "<todos>v1</todos>", "source": "todos"}))
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        # Native counters reject a raw injected block, so it is counted in the form the model accepts.
        counted = self._messages()[1:4]
        counted[1] = Message(
            role="user", content=[ContentBlock(text="old2"), ContentBlock(text="\n\n<todos>v1</todos>")]
        )
        mock_agent.model.count_tokens.assert_awaited_once_with(counted)

    @pytest.mark.asyncio
    async def test_falls_back_to_client_side_when_a_pin_is_summarized(self, mock_agent, caplog):
        mock_agent.model.model_info.capabilities.server_side_summary = True
        mock_agent.model.summarize = unittest.mock.AsyncMock(return_value=_summary("compacted", "anthropic"))
        pinned = {"custom": {"pinned": True}}
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(role="assistant", content=[ContentBlock(text="old1")]),
            Message(role="user", content=[ContentBlock(text="pin")], metadata=pinned),
            Message(role="assistant", content=[ContentBlock(text="old3")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)

        with caplog.at_level(logging.WARNING):
            assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        mock_agent.model.summarize.assert_awaited_once_with(
            [
                Message(role="user", content=[ContentBlock(text="task")]),
                Message(role="assistant", content=[ContentBlock(text="old1"), ContentBlock(text="old3")]),
            ],
            **_replay_kwargs(mock_agent),
        )
        assert "pinned=<1> | server-side summary does not support pinned messages" in caplog.text
        assert messages == [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(role="assistant", content=[_marker(2, "compacted")]),
            Message(role="user", content=[ContentBlock(text="pin"), ContentBlock(text="recent")], metadata=pinned),
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
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        assert messages == [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(role="assistant", content=[_marker(3, "Summary of content.")]),
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
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)

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
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)

        with caplog.at_level(logging.WARNING):
            assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        assert messages == [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(role="assistant", content=[_marker(3, "written client-side")]),
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
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)

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

    @staticmethod
    def _tool_result_messages() -> Messages:
        return [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(
                role="user",
                content=[
                    ContentBlock(
                        toolResult=ToolResult(toolUseId="t1", status="success", content=[{"text": "x" * 10000}])
                    )
                ],
            ),
        ]

    @staticmethod
    def _summarized_tool_result(summary: str) -> Message:
        marker = f"[Summarized: tool result, ~5,000 tokens]\n\n{summary}"
        return Message(
            role="user",
            content=[ContentBlock(toolResult=ToolResult(toolUseId="t1", status="success", content=[{"text": marker}]))],
        )

    @pytest.mark.asyncio
    async def test_a_provider_override_writes_client_side_summaries(self, mock_agent):
        mock_agent.model.summarize = unittest.mock.AsyncMock(return_value=_summary("provider summary"))
        messages = self._tool_result_messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("tool_results").when(threshold=100)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.5)) is True

        assert messages[1] == self._summarized_tool_result("provider summary")
        call = mock_agent.model.summarize.await_args
        assert call.args[0] == [
            Message(
                role="user",
                content=[
                    ContentBlock(text="<content>"),
                    ContentBlock(text="[tool result]"),
                    ContentBlock(text="x" * 10000),
                    ContentBlock(text="</content>"),
                ],
            )
        ]
        assert "tool_specs" not in call.kwargs
        assert "system_prompt_content" not in call.kwargs

    @pytest.mark.asyncio
    async def test_a_server_side_model_writes_block_summaries_as_text(self, mock_agent):
        mock_agent.model.model_info.capabilities.server_side_summary = True
        mock_agent.model.summarize = unittest.mock.AsyncMock(return_value=_summary("compacted", "anthropic"))
        messages = self._tool_result_messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("tool_results").when(threshold=100)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.5)) is True

        mock_agent.model.summarize.assert_awaited_once()
        assert messages[1] == self._summarized_tool_result("compacted")

    @pytest.mark.asyncio
    async def test_a_failed_per_message_summary_leaves_the_history_unchanged(self, mock_agent, caplog):
        mock_agent.model.summarize = unittest.mock.AsyncMock(side_effect=RuntimeError("throttled"))
        messages = TestServerSideSummary._messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)

        with caplog.at_level(logging.WARNING):
            assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is False

        assert messages == TestServerSideSummary._messages()
        failure = next(record for record in caplog.records if "summarization failed" in record.getMessage())
        assert "error=<throttled>" in failure.getMessage()
        assert failure.exc_info

    @pytest.mark.asyncio
    async def test_a_block_summary_sends_a_tool_result_after_its_tool_name(self, mock_agent):
        tool_use = ContentBlock(toolUse=ToolUse(toolUseId="t1", name="read_file", input={"path": "a.py"}))
        messages = self._tool_result_messages()
        messages.insert(1, Message(role="assistant", content=[tool_use]))
        tool_result = messages[2]["content"][0]
        mock_agent.messages = messages
        strategy = Offload.summarize("tool_results").when(threshold=100)

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
        messages = self._tool_result_messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("tool_results", {"system_prompt": "Be very brief."}).when(threshold=100)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.5)) is True

        assert mock_agent.model.summarize.await_args.kwargs["instructions"] == "Be very brief."

    @pytest.mark.asyncio
    async def test_a_custom_system_prompt_reaches_batch_summaries(self, mock_agent):
        mock_agent.model.summarize = unittest.mock.AsyncMock(return_value=_summary("provider summary"))
        messages = TestServerSideSummary._messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("*", {"system_prompt": "Be very brief."}).when(utilization=0.8, preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        mock_agent.model.summarize.assert_awaited_once_with(
            TestServerSideSummary._messages()[:4], **_replay_kwargs(mock_agent, "Be very brief.")
        )

    @pytest.mark.asyncio
    async def test_a_block_summary_sends_the_block_instructions_without_a_system_prompt(self, mock_agent):
        messages = self._tool_result_messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("tool_results").when(threshold=100)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.5)) is True

        assert mock_agent.model.summarize.await_args.kwargs == {
            "instructions": _BLOCK_SUMMARY_INSTRUCTIONS,
            "cancel_signal": mock_agent._cancel_signal,
            "agent_metadata": mock_agent._metadata,
        }

    @pytest.mark.asyncio
    @pytest.mark.parametrize("server_side_summary", [False, True])
    async def test_a_block_summary_adds_its_usage_to_the_request(self, mock_agent, server_side_summary):
        mock_agent.model.model_info.capabilities.server_side_summary = server_side_summary
        messages = self._tool_result_messages()
        mock_agent.messages = messages
        request = _create_invocation_context()
        strategy = Offload.summarize("tool_results").when(threshold=100)

        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5, invocation_context=request)
        assert await strategy.apply(context) is True

        assert request.usage == {"turns_taken": 0, "inputTokens": 10, "outputTokens": 5, "totalTokens": 15}

    @pytest.mark.asyncio
    async def test_a_per_message_summary_adds_its_usage_to_the_request(self, mock_agent):
        messages = TestServerSideSummary._messages()
        mock_agent.messages = messages
        request = _create_invocation_context()
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)

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
        strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)

        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9, invocation_context=request)
        assert await strategy.apply(context) is bool(content)

        assert request.usage == {"turns_taken": 0, "inputTokens": 100, "outputTokens": 20, "totalTokens": 120}

    @pytest.mark.asyncio
    async def test_warns_when_summarize_returns_no_text(self, mock_agent, caplog):
        mock_agent.model.summarize = unittest.mock.AsyncMock(return_value=SummarizeResult())
        messages = self._tool_result_messages()
        mock_agent.messages = messages
        strategy = Offload.summarize("tool_results").when(threshold=100)

        with caplog.at_level(logging.WARNING):
            assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.5)) is False

        assert "summary held no text" in caplog.text
        assert messages == self._tool_result_messages()


def test_format_summarized_uses_expected_prefix():
    assert _format_summarized("test", 100).startswith("[Summarized:")


class TestToolResultToContentBlocks:
    """Tests for converting tool result content to summarizer content blocks."""

    def test_converts_text_content(self):
        assert _tool_result_to_content_blocks([{"text": "hello"}]) == [ContentBlock(text="hello")]

    def test_passes_through_images(self):
        image = {"image": {"format": "png", "source": {"bytes": b"data"}}}
        assert _tool_result_to_content_blocks([image]) == [image]

    def test_converts_json_content_to_text(self):
        tru_result = _tool_result_to_content_blocks([{"text": "plain text"}, {"json": {"key": "value", "count": 42}}])
        assert tru_result == [
            ContentBlock(text="plain text"),
            ContentBlock(text='{\n  "key": "value",\n  "count": 42\n}'),
        ]

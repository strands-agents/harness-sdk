"""Tests for the SummarizeStrategy."""

import logging
import unittest.mock

import pytest

from strands._context_manager.stash import _block_key
from strands._context_manager.strategies.offload import Offload
from strands._context_manager.strategies.offload.summarize import _compaction_split_index, _place_summary
from strands._context_manager.types import ContextState
from strands.models import SummarizeResult
from strands.models._summarize import _DEFAULT_SUMMARIZE_INSTRUCTIONS
from strands.models.model import Model
from strands.types.content import ContentBlock, Message, Messages
from strands.types.tools import ToolResult, ToolUse
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
    async def test_sends_a_block_with_the_custom_instruction_through_model_summarize_and_records_the_usage(
        self, mock_agent
    ):
        received = []

        async def stream(messages, tool_specs=None, system_prompt=None, **kwargs):
            received.append((messages, tool_specs, system_prompt))
            async for event in _make_stream_events("Summary of content.")():
                yield event

        mock_agent.model.stream = stream
        strategy = Offload.summarize("assistant_text", {"system_prompt": "Keep ids"}).when(threshold=100)
        messages = [_text("user", "task"), _text("assistant", "x" * 10000), _text("user", "latest")]
        invocation_context = unittest.mock.MagicMock()
        context = ContextState(
            messages=messages, agent=mock_agent, utilization=0.5, invocation_context=invocation_context
        )

        assert await strategy.apply(context) is True
        exp_request = [
            Message(
                role="user",
                content=[
                    ContentBlock(text="<content>"),
                    ContentBlock(text="\n---\n[assistant]"),
                    ContentBlock(text="x" * 10000),
                    ContentBlock(text="</content>"),
                ],
            )
        ]
        assert received == [(exp_request, None, "Keep ids")]
        invocation_context._record_usage.assert_called_once_with(
            {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}
        )
        assert messages[1]["content"] == [
            ContentBlock(text="[Summarized: text block, ~5,000 tokens]\n\nSummary of content.")
        ]

    @pytest.mark.asyncio
    async def test_sends_a_tool_result_after_its_tool_call_with_the_agent_cancel_signal(self, mock_agent):
        received = []

        async def stream(messages, tool_specs=None, system_prompt=None, **kwargs):
            received.append((messages, kwargs.get("cancel_signal")))
            async for event in _make_stream_events("Summary of content.")():
                yield event

        mock_agent.model.stream = stream
        strategy = Offload.summarize("tool_results").when(threshold=100)
        tool_use = ToolUse(toolUseId="t1", name="shell", input={"command": "ls"})
        tool_result = ToolResult(toolUseId="t1", status="success", content=[{"text": "x" * 10000}])
        messages: Messages = [
            _text("user", "task"),
            Message(role="assistant", content=[ContentBlock(toolUse=tool_use)]),
            Message(role="user", content=[ContentBlock(toolResult=tool_result)]),
        ]
        mock_agent.messages = messages

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.5)) is True
        exp_request = [
            Message(
                role="user",
                content=[
                    ContentBlock(text="<content>"),
                    ContentBlock(text="\n---\n[assistant]"),
                    ContentBlock(text='[tool call: shell] {"command":"ls"}'),
                    ContentBlock(text="\n---\n[user]"),
                    ContentBlock(text="[tool result: shell]"),
                    ContentBlock(text="x" * 10000),
                    ContentBlock(text="</content>"),
                ],
            )
        ]
        assert received == [(exp_request, mock_agent.cancel_signal)]

    @pytest.mark.asyncio
    async def test_sends_a_block_under_the_default_summarization_system_prompt(self, mock_agent):
        received = []

        async def stream(messages, tool_specs=None, system_prompt=None, **kwargs):
            received.append(system_prompt)
            async for event in _make_stream_events("Summary of content.")():
                yield event

        mock_agent.model.stream = stream
        strategy = Offload.summarize("assistant_text").when(threshold=100)
        messages = [_text("user", "task"), _text("assistant", "x" * 10000), _text("user", "latest")]

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.5)) is True
        assert received == [_DEFAULT_SUMMARIZE_INSTRUCTIONS]

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


PINNED = {"custom": {"pinned": True}}


class TestSummarizeStrategyMessageLevel:
    """Tests for message-level summaries around pinned messages."""

    @pytest.mark.asyncio
    async def test_summarizes_the_messages_after_a_pinned_task_into_assistant_content_behind_it(
        self, routing_agent, base_summarize
    ):
        strategy = Offload.summarize("*").when(utilization=0.8)
        task = Message(role="user", content=[ContentBlock(text="task")], metadata=PINNED)
        messages: Messages = [
            task,
            _text("assistant", "old1"),
            _text("user", "old2"),
            _text("assistant", "old3"),
            _text("user", "recent"),
        ]

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        exp_request = [_text("assistant", "old1"), _text("user", "old2")]
        routing_agent.model.summarize.assert_not_called()
        assert base_summarize.call_args.args == (routing_agent.model, exp_request)
        exp_carrier = {"role": "assistant", "content": [{"text": "old3"}, _marked(2)]}
        assert messages == [task, exp_carrier, _text("user", "recent")]

    @pytest.mark.asyncio
    async def test_keeps_message_zero_when_the_only_slot_before_it_lies_before_a_pinned_user_message(
        self, routing_agent, base_summarize
    ):
        # Summarized with the rest, the task would leave a user-role summary that joins the pinned prompt.
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=2)
        prompt = Message(role="user", content=[ContentBlock(text="now add tests")], metadata=PINNED)
        messages: Messages = [_text("user", "task"), _tool_use("t1"), _tool_result("t1"), _tool_use("t2")]
        messages += [_tool_result("t2"), _text("assistant", "done"), prompt, _text("assistant", "ok")]
        original = list(messages)

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        routing_agent.model.summarize.assert_not_called()
        assert base_summarize.call_args.args == (routing_agent.model, original[1:6])
        exp_summary = {"role": "assistant", "content": [_marked(5)], "tracking_id": unittest.mock.ANY}
        assert messages == [_text("user", "task"), exp_summary, prompt, _text("assistant", "ok")]

    @pytest.mark.asyncio
    async def test_skips_the_pass_when_the_only_message_after_message_zero_is_an_earlier_summary(
        self, routing_agent, base_summarize
    ):
        # The second pass has only the first pass's summary left to summarize, which frees nothing.
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=2)
        prompt = Message(role="user", content=[ContentBlock(text="now add tests")], metadata=PINNED)
        messages: Messages = [_text("user", "task"), _tool_use("t1"), _tool_result("t1"), _tool_use("t2")]
        messages += [_tool_result("t2"), _text("assistant", "done"), prompt, _text("assistant", "ok")]
        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        compacted = list(messages)
        base_summarize.reset_mock()

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is False
        base_summarize.assert_not_called()
        assert messages == compacted

    @pytest.mark.asyncio
    async def test_skips_the_pass_when_only_an_earlier_summary_can_be_removed(self, routing_agent, base_summarize):
        # Removing u2 would join the pinned a1 and a3, so only the summary at message 0 is left to summarize.
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=2)
        pinned = Message(role="assistant", content=[ContentBlock(text="a1")], metadata=PINNED)
        messages: Messages = [{"role": "user", "content": [_marked(3)]}, pinned, _text("user", "u2")]
        messages += [_text("assistant", "a3"), _text("user", "recent")]
        original = list(messages)

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is False
        base_summarize.assert_not_called()
        assert messages == original

    @pytest.mark.asyncio
    async def test_keeps_the_summary_out_of_a_pinned_assistant_message_so_the_next_pass_summarizes_it(
        self, routing_agent, base_summarize
    ):
        strategy = Offload.summarize("*").when(utilization=0.5)
        task = Message(role="user", content=[ContentBlock(text="task")], metadata=PINNED)
        ack = Message(role="assistant", content=[ContentBlock(text="ack")], metadata=PINNED)
        messages: Messages = [task, ack, _text("user", "u2"), _text("assistant", "a3"), _text("user", "u4")]
        messages += [_text("assistant", "a5"), _text("user", "u6")]

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        messages += [_text("assistant", "a7"), _text("user", "u8")]
        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True

        second_request = base_summarize.call_args_list[1].args[1]
        assert second_request == [_tracked_summary(3), _text("assistant", "a5"), _text("user", "u6")]
        assert messages == [task, ack, _tracked_summary(3), _text("assistant", "a7"), _text("user", "u8")]

    @pytest.mark.asyncio
    async def test_places_the_summary_at_a_later_gap_when_the_first_lies_between_pinned_messages(
        self, routing_agent, base_summarize
    ):
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=1)
        task = Message(role="user", content=[ContentBlock(text="task")], metadata=PINNED)
        ack = Message(role="assistant", content=[ContentBlock(text="ack")], metadata=PINNED)
        note = Message(role="user", content=[ContentBlock(text="note")], metadata=PINNED)
        messages: Messages = [
            task,
            ack,
            _text("user", "u2"),
            _text("assistant", "a3"),
            note,
            _text("assistant", "a5"),
            _text("user", "u6"),
            _text("assistant", "a7"),
            _text("user", "u8"),
        ]

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        assert messages == [
            task,
            ack,
            note,
            {"role": "assistant", "content": [{"text": "a7"}, _marked(4)]},
            _text("user", "u8"),
        ]

    @pytest.mark.asyncio
    async def test_skips_the_pass_when_every_gap_lies_between_pinned_messages_of_both_roles(
        self, routing_agent, base_summarize
    ):
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=2)
        task = Message(role="user", content=[ContentBlock(text="task")], metadata=PINNED)
        answer = Message(role="assistant", content=[ContentBlock(text="answer")], metadata=PINNED, tracking_id="t3")
        messages: Messages = [task, _text("assistant", "a1"), _text("user", "u2"), answer, _text("user", "u4")]
        original = list(messages)

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is False
        base_summarize.assert_not_called()
        assert messages == original

    @pytest.mark.asyncio
    async def test_keeps_a_run_whose_removal_would_join_pinned_messages(self, routing_agent, base_summarize):
        strategy = Offload.summarize("*").when(utilization=0.5)
        first = Message(role="assistant", content=[ContentBlock(text="a1")], metadata=PINNED, tracking_id="t1")
        second = Message(role="assistant", content=[ContentBlock(text="a3")], metadata=PINNED, tracking_id="t3")
        messages: Messages = [_text("user", "u0"), first, _text("user", "u2"), second, _text("user", "u4")]

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        assert routing_agent.model.summarize.call_args.args == ([_text("user", "u0")],)
        assert messages == [_tracked_summary(1), first, _text("user", "u2"), second, _text("user", "u4")]

    @pytest.mark.asyncio
    async def test_keeps_a_targeted_run_whose_removal_would_join_a_pinned_message(self, routing_agent, base_summarize):
        strategy = Offload.summarize("user_text").when(utilization=0.5)
        pinned = Message(role="assistant", content=[ContentBlock(text="a5")], metadata=PINNED, tracking_id="t5")
        messages: Messages = [
            _text("user", "u0"),
            _text("assistant", "a1"),
            _text("user", "u2"),
            _text("assistant", "a3"),
            _text("user", "u4"),
            pinned,
            _text("user", "u6"),
        ]

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        assert messages[-3:] == [_text("user", "u4"), pinned, _text("user", "u6")]

    @pytest.mark.asyncio
    async def test_leaves_a_lone_pinned_tool_result_unsummarized(self, routing_agent, base_summarize):
        strategy = Offload.summarize("*").when(utilization=0.5)
        messages: Messages = [{**_tool_result("tool-1"), "metadata": PINNED}]
        original = list(messages)

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is False
        base_summarize.assert_not_called()
        assert messages == original

    @pytest.mark.asyncio
    async def test_leaves_a_pinned_message_before_the_cut_out_of_the_summary(self, routing_agent, base_summarize):
        strategy = Offload.summarize("*").when(utilization=0.7, preserve_recent=2)
        messages = _routing_history()
        messages[2] = {**messages[2], "metadata": PINNED}
        original = list(messages)

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        exp_request = [original[1], original[3], original[4]]
        routing_agent.model.summarize.assert_not_called()
        assert base_summarize.call_args.args == (routing_agent.model, exp_request)
        exp_messages = [original[0], _tracked_summary(3, "assistant"), original[2], *original[5:]]
        assert messages == exp_messages

    @pytest.mark.asyncio
    async def test_keeps_the_message_before_a_pinned_last_message_so_the_summary_does_not_end_the_history(
        self, routing_agent
    ):
        strategy = Offload.summarize("*").when(utilization=0.7, preserve_recent=1)
        messages = _routing_history()
        messages[6] = {**messages[6], "metadata": PINNED}
        original = list(messages)

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        assert routing_agent.model.summarize.call_args.args == (original[:5],)
        assert messages == [_tracked_summary(5), *original[5:]]

    @pytest.mark.asyncio
    async def test_preserves_alternation(self, routing_agent):
        strategy = Offload.summarize("*").when(utilization=0.8)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")], metadata=PINNED),
            Message(role="assistant", content=[ContentBlock(text="a1")]),
            Message(role="user", content=[ContentBlock(text="u2")]),
            Message(role="assistant", content=[ContentBlock(text="a2")]),
            Message(role="user", content=[ContentBlock(text="u3")]),
            Message(role="assistant", content=[ContentBlock(text="a3")]),
        ]
        context = ContextState(messages=messages, agent=routing_agent, utilization=0.9)
        assert await strategy.apply(context) is True
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


class TestRepeatedSummarizationKeepsMessageZeroVerbatim:
    """Regression test for https://github.com/strands-agents/harness-sdk/issues/4685."""

    @pytest.mark.asyncio
    async def test_summaries_stay_out_of_pinned_message_zero(self, routing_agent):
        strategy = Offload.summarize("*").when(utilization=0.7, preserve_recent=4)
        task = Message(role="user", content=[ContentBlock(text="task")], metadata={"custom": {"pinned": True}})
        messages: Messages = [task]
        for index in range(30):
            messages.append(_tool_use(f"t{index}"))
            messages.append(_tool_result(f"t{index}"))
            await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9))
        assert messages[0] == Message(
            role="user", content=[ContentBlock(text="task")], metadata={"custom": {"pinned": True}}
        )
        summaries = [
            block for message in messages for block in message["content"] if "[Summarized:" in block.get("text", "")
        ]
        assert len(summaries) == 1


class TestBaseSummarizeKeepsMessageZeroVerbatim:
    """A recency pass through the base ``Model.summarize()`` never summarizes message 0."""

    @pytest.fixture
    def base_model_agent(self, mock_agent):
        mock_agent.model = MockedModelProvider([_text("assistant", "summary")])
        mock_agent.aux_model = mock_agent.model
        return mock_agent

    @pytest.mark.asyncio
    async def test_summarizes_the_messages_after_message_zero(self, base_model_agent):
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=2)
        messages: Messages = [_text("user", "task"), _text("assistant", "a1"), _text("user", "u2")]
        messages += [_text("assistant", "a3"), _text("user", "u4")]

        assert await strategy.apply(ContextState(messages=messages, agent=base_model_agent, utilization=0.9)) is True
        assert messages[0] == _text("user", "task")
        assert messages[1]["content"][0] == {"text": "a3"}
        assert messages[1]["content"][1]["text"].startswith("[Summarized: 2 messages,")
        assert messages[2] == _text("user", "u4")

    @pytest.mark.asyncio
    async def test_skips_the_pass_when_the_one_message_left_after_message_zero_holds_a_summary(self, base_model_agent):
        # The message left after message 0 opens with an earlier pass's summary, so re-summarizing it frees nothing.
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=2)
        pinned = Message(role="assistant", content=[ContentBlock(text="a1")], metadata=PINNED)
        carrier = Message(role="user", content=[_marked(3), ContentBlock(text="u2")])
        messages: Messages = [_text("user", "task"), pinned, carrier, _text("assistant", "a3"), _text("user", "u4")]
        original = list(messages)

        assert await strategy.apply(ContextState(messages=messages, agent=base_model_agent, utilization=0.9)) is False
        assert messages == original

    @pytest.mark.asyncio
    async def test_summarizes_the_one_message_left_after_message_zero(self, base_model_agent):
        # A large message right after the task is summarized alone; only an earlier summary is not.
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=3)
        messages: Messages = [_text("user", "task"), _text("assistant", "x" * 20000), _text("user", "u2")]
        messages += [_text("assistant", "a3"), _text("user", "u4")]

        assert await strategy.apply(ContextState(messages=messages, agent=base_model_agent, utilization=0.9)) is True
        assert messages[0] == _text("user", "task")
        assert messages[1]["role"] == "assistant"
        assert messages[1]["content"][0]["text"].startswith("[Summarized: 1 messages,")
        assert messages[2:] == [_text("user", "u2"), _text("assistant", "a3"), _text("user", "u4")]


class TestSummarizationWithToolCalls:
    """Guards against tool calls being dropped from or split from their results in the summary request (#5291)."""

    @pytest.mark.asyncio
    async def test_sends_tool_calls_with_their_results_and_the_live_tools_to_summarize(
        self, routing_agent, base_summarize
    ):
        strategy = Offload.summarize("*").when(utilization=0.7, preserve_recent=2)
        tool_use = ToolUse(toolUseId="call_1", name="shell", input={"command": "ls"})
        tool_result = ToolResult(toolUseId="call_1", status="success", content=[{"text": "a.ts b.ts"}])
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="fix the build")], metadata=PINNED),
            Message(role="assistant", content=[ContentBlock(toolUse=tool_use)]),
            Message(role="user", content=[ContentBlock(toolResult=tool_result)]),
            Message(role="assistant", content=[ContentBlock(text="done")]),
            Message(role="user", content=[ContentBlock(text="next")]),
        ]

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        exp_request = [
            Message(role="assistant", content=[ContentBlock(toolUse=tool_use)]),
            Message(role="user", content=[ContentBlock(toolResult=tool_result)]),
        ]
        base_summarize.assert_awaited_once_with(
            routing_agent.model,
            exp_request,
            tool_specs=[{"name": "read"}],
            system_prompt="live system prompt",
            system_prompt_content=[{"text": "live system prompt"}],
            instructions=None,
            cancel_signal=routing_agent.cancel_signal,
        )


def _large_result(tool_use_id: str) -> Message:
    return Message(
        role="user",
        content=[
            ContentBlock(
                toolResult=ToolResult(toolUseId=tool_use_id, status="success", content=[{"text": "x" * 10000}])
            )
        ],
    )


def _routing_history() -> Messages:
    return [
        Message(role="user", content=[ContentBlock(text="task")]),
        Message(role="assistant", content=[ContentBlock(text="a")]),
        _large_result("tool-1"),
        Message(role="assistant", content=[ContentBlock(text="b")]),
        _large_result("tool-2"),
        Message(role="assistant", content=[ContentBlock(text="c")]),
        Message(role="user", content=[ContentBlock(text="latest")]),
    ]


SUMMARY = Message(role="user", content=[ContentBlock(text="summary")])
USAGE = {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}


def _marked(count: int) -> ContentBlock:
    """The summary block placed for ``count`` messages, which the mock model counts as 5,000 tokens."""
    return ContentBlock(text=f"[Summarized: {count} messages, ~5,000 tokens]\n\nsummary")


def _tracked_summary(count: int, role: str = "user") -> Message:
    return {"role": role, "content": [_marked(count)], "tracking_id": unittest.mock.ANY}


@pytest.fixture
def base_summarize():
    with unittest.mock.patch.object(
        Model, "summarize", unittest.mock.AsyncMock(return_value=SummarizeResult(summary=SUMMARY, usage=USAGE))
    ) as base_summarize:
        yield base_summarize


@pytest.fixture
def routing_agent(mock_agent, base_summarize):
    mock_agent.tool_registry.get_all_tool_specs.return_value = [{"name": "read"}]
    mock_agent.system_prompt = "live system prompt"
    mock_agent.system_prompt_content = [{"text": "live system prompt"}]
    mock_agent.model.summarize = unittest.mock.AsyncMock(return_value=SummarizeResult(summary=SUMMARY, usage=USAGE))
    return mock_agent


class TestSummarizeStrategyRouting:
    """Tests for which summaries go through Model.summarize."""

    @pytest.mark.asyncio
    async def test_sends_a_whole_history_message_level_summary_through_summarize(self, routing_agent):
        strategy = Offload.summarize("*", {"system_prompt": "Keep ids"}).when(utilization=0.7, preserve_recent=2)
        messages = _routing_history()
        original = list(messages)

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.5)) is False
        routing_agent.model.summarize.assert_not_called()

        context = ContextState(messages=messages, agent=routing_agent, utilization=0.5, overflow=True)
        assert await strategy.apply(context) is True
        routing_agent.model.summarize.assert_awaited_once_with(
            original[:5],
            tool_specs=[{"name": "read"}],
            system_prompt="live system prompt",
            system_prompt_content=[{"text": "live system prompt"}],
            instructions="Keep ids",
            cancel_signal=routing_agent.cancel_signal,
        )
        assert messages == [_tracked_summary(5), *original[5:]]

    @pytest.mark.asyncio
    async def test_records_the_compaction_usage_on_the_invocation_context(self, routing_agent):
        invocation_context = unittest.mock.MagicMock()
        strategy = Offload.summarize("*").when(utilization=0.7, preserve_recent=2)
        context = ContextState(
            messages=_routing_history(), agent=routing_agent, utilization=0.9, invocation_context=invocation_context
        )

        assert await strategy.apply(context) is True
        invocation_context._record_usage.assert_called_once_with(USAGE)

    @pytest.mark.asyncio
    async def test_records_no_usage_when_the_provider_reports_none(self, routing_agent):
        routing_agent.model.summarize.return_value = SummarizeResult(summary=SUMMARY)
        invocation_context = unittest.mock.MagicMock()
        strategy = Offload.summarize("*").when(utilization=0.7, preserve_recent=2)
        context = ContextState(
            messages=_routing_history(), agent=routing_agent, utilization=0.9, invocation_context=invocation_context
        )

        assert await strategy.apply(context) is True
        invocation_context._record_usage.assert_not_called()

    @pytest.mark.asyncio
    async def test_marks_a_text_summary_with_the_summarized_messages_and_their_token_count(self, routing_agent):
        messages = _routing_history()
        original = list(messages)
        routing_agent.model.count_tokens.return_value = 1234
        routing_agent.model.summarize.return_value = SummarizeResult(
            summary=Message(role="user", content=[ContentBlock(text="first"), ContentBlock(text="second")])
        )
        strategy = Offload.summarize("*").when(utilization=0.7, preserve_recent=2)

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        routing_agent.model.count_tokens.assert_awaited_once_with(original[:5])
        exp_summary = {
            "role": "user",
            "content": [{"text": "[Summarized: 5 messages, ~1,234 tokens]\n\nfirst\nsecond"}],
            "tracking_id": unittest.mock.ANY,
        }
        assert messages == [exp_summary, *original[5:]]

    @pytest.mark.asyncio
    async def test_places_a_summary_with_non_text_content_unchanged(self, routing_agent):
        messages = _routing_history()
        original = list(messages)
        content = [ContentBlock(text="summary"), ContentBlock(image={"format": "png", "source": {"bytes": b"png"}})]
        routing_agent.model.summarize.return_value = SummarizeResult(summary=Message(role="user", content=content))
        strategy = Offload.summarize("*").when(utilization=0.7, preserve_recent=2)

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        routing_agent.model.count_tokens.assert_not_called()
        assert messages == [{"role": "user", "content": content, "tracking_id": unittest.mock.ANY}, *original[5:]]

    @pytest.mark.asyncio
    async def test_sends_a_prefix_opening_with_an_assistant_turn_through_base_summarize(
        self, routing_agent, base_summarize
    ):
        messages = _routing_history()[1:]
        original = list(messages)
        strategy = Offload.summarize("*").when(utilization=0.7, preserve_recent=2)

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        routing_agent.model.summarize.assert_not_called()
        exp_request = original[1:4]
        assert base_summarize.call_args.args == (routing_agent.model, exp_request)
        assert messages == [original[0], _tracked_summary(3), *original[4:]]

    @pytest.mark.asyncio
    async def test_moves_a_cut_on_a_tool_pair_forward(self, routing_agent):
        messages = [
            Message(role="user", content=[ContentBlock(text="task")]),
            _text("assistant", "a"),
            _text("user", "b"),
            _tool_use("tool-1"),
            _tool_result("tool-1"),
            _text("assistant", "c"),
            _text("user", "latest"),
        ]
        original = list(messages)
        strategy = Offload.summarize("*").when(utilization=0.7, preserve_recent=3)

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        assert routing_agent.model.summarize.call_args.args == (original[:5],)
        assert messages == [_tracked_summary(5), *original[5:]]

    @pytest.mark.asyncio
    async def test_merges_same_role_messages_at_the_join(self, routing_agent):
        messages = _routing_history()
        original = list(messages)
        strategy = Offload.summarize("*").when(utilization=0.7, preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        assert routing_agent.model.summarize.call_args.args == (original[:5],)
        assert messages == [_tracked_summary(5), *original[5:]]

    @pytest.mark.asyncio
    async def test_skips_a_pass_whose_only_summary_would_join_the_last_message(self, routing_agent):
        messages = [_text("user", "task"), _text("assistant", "a1"), _text("user", "latest")]
        original = list(messages)
        strategy = Offload.summarize("*").when(utilization=0.7)

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is False
        routing_agent.model.summarize.assert_not_called()
        assert messages == original

    @pytest.mark.asyncio
    async def test_leaves_the_history_unchanged_and_warns_when_summarize_writes_no_summary(self, routing_agent, caplog):
        routing_agent.model.summarize.return_value = SummarizeResult(
            summary=Message(role="user", content=[]), usage=USAGE
        )
        invocation_context = unittest.mock.MagicMock()
        strategy = Offload.summarize("*").when(utilization=0.7)
        messages = _routing_history()
        context = ContextState(
            messages=messages, agent=routing_agent, utilization=0.9, invocation_context=invocation_context
        )

        with caplog.at_level(logging.WARNING):
            assert await strategy.apply(context) is False

        assert messages == _routing_history()
        invocation_context._record_usage.assert_called_once_with(USAGE)
        assert "model summarize returned no summary" in caplog.text

    @pytest.mark.asyncio
    async def test_passes_no_instruction_without_a_custom_system_prompt(self, routing_agent):
        strategy = Offload.summarize("*").when(utilization=0.7, preserve_recent=2)

        assert await strategy.apply(ContextState(messages=_routing_history(), agent=routing_agent, utilization=0.9))
        routing_agent.model.summarize.assert_awaited_once_with(
            _routing_history()[:5],
            tool_specs=[{"name": "read"}],
            system_prompt="live system prompt",
            system_prompt_content=[{"text": "live system prompt"}],
            instructions=None,
            cancel_signal=routing_agent.cancel_signal,
        )

    @pytest.mark.asyncio
    async def test_a_second_pass_over_the_compacted_history_is_a_no_op(self, routing_agent):
        messages = [_text("user" if index % 2 == 0 else "assistant", f"m{index}") for index in range(9)]
        strategy = Offload.summarize("*").when(utilization=0.7, preserve_recent=4)

        tru_acted = [
            await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9))
            for _ in range(3)
        ]

        assert tru_acted == [True, False, False]
        routing_agent.model.summarize.assert_awaited_once()
        assert messages == [
            _tracked_summary(5),
            *[_text("assistant" if index % 2 else "user", f"m{index}") for index in range(5, 9)],
        ]

    @pytest.mark.asyncio
    async def test_sends_a_target_filtered_summary_through_base_summarize_with_the_selected_tool_pairs(
        self, routing_agent, base_summarize
    ):
        strategy = Offload.summarize("tool_results").when(utilization=0.7)
        messages = [
            _text("user", "task"),
            _tool_use("t1"),
            _tool_result("t1"),
            _text("assistant", "a"),
            _text("user", "u"),
            _tool_use("t2"),
            _tool_result("t2"),
            _text("assistant", "b"),
            _text("user", "latest"),
        ]
        original = list(messages)

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        exp_request = [*original[1:3], *original[5:7]]
        routing_agent.model.summarize.assert_not_called()
        assert base_summarize.call_args.args == (routing_agent.model, exp_request)
        exp_messages = [
            original[0],
            {"role": "assistant", "content": [{"text": "a"}, _marked(4)]},
            original[4],
            original[7],
            original[8],
        ]
        assert messages == exp_messages

    @pytest.mark.asyncio
    async def test_sends_a_threshold_summary_through_base_summarize(self, routing_agent, base_summarize):
        strategy = Offload.summarize("*").when(utilization=0.7, threshold=10)
        messages = _routing_history()
        original = list(messages)

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        exp_request = original[1:6]
        routing_agent.model.summarize.assert_not_called()
        assert base_summarize.call_args.args == (routing_agent.model, exp_request)
        exp_summary = _tracked_summary(5, "assistant")
        assert messages == [original[0], exp_summary, original[6]]


def _text(role, text):
    return {"role": role, "content": [{"text": text}]}


def _tool_use(tool_use_id):
    return {"role": "assistant", "content": [{"toolUse": {"toolUseId": tool_use_id, "name": "read", "input": {}}}]}


def _tool_result(tool_use_id):
    return {
        "role": "user",
        "content": [{"toolResult": {"toolUseId": tool_use_id, "status": "success", "content": [{"text": "ok"}]}}],
    }


class TestCompactionSplitIndex:
    def test_keeps_a_count_or_ratio_of_trailing_messages_and_never_cuts_past_the_last_message(self):
        messages = [
            _text("user", "a"),
            _text("assistant", "b"),
            _text("user", "c"),
            _text("assistant", "d"),
            _text("user", "e"),
        ]

        tru_splits = [
            _compaction_split_index(messages, 2),
            _compaction_split_index(messages, 0.5),
            _compaction_split_index(messages, 0),
            _compaction_split_index(messages, 5),
            _compaction_split_index(messages, 9),
            _compaction_split_index(messages, 4),
            _compaction_split_index([], 0),
            _compaction_split_index(messages[:1], 0),
            _compaction_split_index(messages[:2], 0),
            _compaction_split_index(messages[:3], 0),
        ]

        assert tru_splits == [3, 2, 4, 0, 0, 0, 0, 0, 0, 2]

    def test_moves_the_cut_forward_so_a_tool_use_stays_with_its_tool_result_or_back_when_the_result_is_last(self):
        messages = [_text("user", "task"), _tool_use("a"), _tool_result("a"), _tool_use("b"), _tool_result("b")]

        tru_splits = [_compaction_split_index(messages, kept) for kept in (2, 3, 0)]

        assert tru_splits == [3, 3, 3]

    def test_does_not_cut_when_moving_the_cut_back_off_a_tool_pair_leaves_one_message(self):
        messages = [_text("user", "task"), _tool_use("a"), _tool_result("a")]

        assert _compaction_split_index(messages, 0) == 0


REDACTED = ContentBlock(reasoningContent={"redactedContent": b"x"})


class TestSummaryPlacement:
    """Tests for where a summary lands relative to the messages it keeps."""

    def test_places_a_non_text_summary_verbatim_as_its_own_message(self):
        messages = [_text("user", "q1"), _text("assistant", "a1"), _text("user", "q2"), _text("assistant", "a2")]
        summary = Message(role="assistant", content=[REDACTED])

        assert _place_summary(messages, [0, 1], (0, "user"), summary) is True
        assert messages == [
            {"role": "assistant", "content": [REDACTED], "tracking_id": unittest.mock.ANY},
            _text("user", "q2"),
            _text("assistant", "a2"),
        ]

    def test_ends_a_user_message_that_opens_with_a_tool_result_with_the_summary(self):
        messages = [_text("user", "q0"), _text("assistant", "a1"), _text("user", "q2"), _tool_result("t1")]
        messages.append(_text("assistant", "a4"))
        summary = Message(role="user", content=[_marked(1)])

        assert _place_summary(messages, [2], (2, "user"), summary) is True
        assert messages[2]["content"] == [*_tool_result("t1")["content"], _marked(1)]

    def test_leaves_the_history_unchanged_when_a_non_text_summary_shares_a_role_with_a_kept_neighbor(self):
        messages = [_text("user", "q1"), _text("assistant", "a1"), _text("user", "q2"), _text("assistant", "a2")]
        original = list(messages)
        summary = Message(role="assistant", content=[REDACTED])

        assert _place_summary(messages, [0, 1, 2], (0, "user"), summary) is False
        assert messages == original

    @pytest.mark.asyncio
    async def test_places_an_override_compaction_block_with_its_own_role(self, routing_agent):
        summary = Message(role="assistant", content=[REDACTED])
        routing_agent.model.summarize.return_value = SummarizeResult(summary=summary)
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=3)
        messages = [_text("user", "u0"), _text("assistant", "a1"), _text("user", "u2"), _text("assistant", "a3")]
        messages.append(_text("user", "u4"))
        kept = messages[2:]

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        assert messages == [{"role": "assistant", "content": [REDACTED], "tracking_id": unittest.mock.ANY}, *kept]

    @pytest.mark.asyncio
    async def test_warns_and_keeps_the_history_when_an_override_compaction_block_does_not_alternate(
        self, routing_agent, caplog
    ):
        summary = Message(role="assistant", content=[REDACTED])
        routing_agent.model.summarize.return_value = SummarizeResult(summary=summary)
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=2)
        messages = [_text("user", "u0"), _text("assistant", "a1"), _text("user", "u2"), _text("assistant", "a3")]
        messages.append(_text("user", "u4"))
        original = list(messages)

        with caplog.at_level(logging.WARNING):
            assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is False
        assert messages == original
        assert "summary does not alternate with the kept messages" in caplog.text

    @pytest.mark.asyncio
    async def test_keeps_the_summary_out_of_a_tool_result_whose_tool_use_is_pinned(self, routing_agent, base_summarize):
        strategy = Offload.summarize("*").when(utilization=0.5)
        task = Message(role="user", content=[ContentBlock(text="task")], metadata=PINNED)
        tool_use = {**_tool_use("t1"), "metadata": PINNED}
        tool_result = _tool_result("t1")
        messages: Messages = [task, tool_use, tool_result, _text("assistant", "a3"), _text("user", "u4")]
        messages += [_text("assistant", "a5"), _text("user", "u6")]

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        messages += [_text("assistant", "a7"), _text("user", "u8")]
        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True

        exp_carrier = {"role": "assistant", "content": [{"text": "a7"}, _marked(2)]}
        assert messages == [task, tool_use, tool_result, exp_carrier, _text("user", "u8")]

    @pytest.mark.asyncio
    async def test_opens_the_kept_message_with_a_leading_summary_so_its_stash_refs_still_resolve(self, routing_agent):
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=3)
        metadata = {"custom": {"source": "upload"}}
        big = Message(role="user", content=[ContentBlock(text="x" * 10000)], tracking_id="id2", metadata=metadata)
        messages: Messages = [
            {**_text("user", "u0"), "tracking_id": "id0"},
            {**_text("assistant", "a1"), "tracking_id": "id1"},
            big,
            {**_text("assistant", "a3"), "tracking_id": "id3"},
            {**_text("user", "u4"), "tracking_id": "id4"},
        ]
        kept = messages[2:]

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        carrier = messages[0]
        assert carrier["content"] == [_marked(2), *big["content"]]
        assert carrier["tracking_id"] == "id2"
        assert carrier["metadata"]["custom"]["source"] == "upload"
        assert _block_key(carrier, 1) == "id2_0"
        assert messages[1:] == kept[1:]

    @pytest.mark.asyncio
    async def test_places_a_summary_between_two_same_role_messages_on_its_own(self, routing_agent, base_summarize):
        routing_agent.model.count_tokens.side_effect = lambda messages, *_, **__: sum(
            len(block.get("text", "")) // 4 for message in messages for block in message["content"]
        )
        strategy = Offload.summarize("assistant_text").when(utilization=0.5, threshold=50)
        question = {**_text("user", "q2"), "tracking_id": "id2", "metadata": {"custom": {"tag": "x"}}}
        latest = {**_text("user", "latest"), "tracking_id": "id4"}
        messages: Messages = [_text("user", "task"), _text("assistant", "ok"), question]
        messages += [_text("assistant", "a" * 400), latest]

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        assert messages[:3] == [_text("user", "task"), _text("assistant", "ok"), question]
        assert messages[3]["role"] == "assistant"
        assert messages[4] == latest

    @pytest.mark.asyncio
    async def test_sends_a_prefix_that_does_not_alternate_through_base_summarize(self, routing_agent, base_summarize):
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=3)
        messages: Messages = [_text("user", "u0"), _text("user", "u1"), _tool_use("t1"), _tool_result("t1")]
        messages += [_tool_use("t2"), _tool_result("t2"), _text("assistant", "a6"), _text("user", "u7")]

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        routing_agent.model.summarize.assert_not_called()
        base_summarize.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_does_not_resummarize_a_lone_earlier_summary(self, routing_agent, base_summarize):
        strategy = Offload.summarize("assistant_text").when(utilization=0.5)
        earlier = _text("assistant", "[Summarized: 3 messages, ~5,000 tokens]\n\nsummary")
        messages: Messages = [_text("user", "u0"), earlier, _text("user", "u2")]
        original = list(messages)

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is False
        assert messages == original
        base_summarize.assert_not_called()

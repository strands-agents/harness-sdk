"""Tests for the SummarizeStrategy."""

import functools
import json
import logging
import unittest.mock

import pytest

from strands._context_manager.strategies.offload import Offload
from strands._context_manager.strategies.offload.summarize import _warn_on_server_side_summary_limits
from strands._context_manager.types import ContextState
from strands.models import ModelCapabilities, ModelInfo, SummarizeResult
from strands.models.model import Model
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
    agent.model.summarize = functools.partial(Model.summarize, agent.model)
    agent.model.model_info = ModelInfo()
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
    async def test_summarizes_tool_calls_as_text_in_a_single_model_call(self, mock_agent):
        tru_calls: list[Messages] = []
        summary_stream = _make_stream_events("Listed the files")

        def recording_stream(messages, *args, **kwargs):
            tru_calls.append(messages)
            return summary_stream(messages, *args, **kwargs)

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
            [
                Message(
                    role="user",
                    content=[
                        ContentBlock(text="<content>"),
                        ContentBlock(text="\n---\n[assistant]"),
                        ContentBlock(text='[tool call: shell] {"command":"ls"}'),
                        ContentBlock(text="\n---\n[user]"),
                        ContentBlock(text="[tool result: shell]"),
                        ContentBlock(text="a.ts b.ts"),
                        ContentBlock(text="</content>"),
                    ],
                )
            ]
        ]
        assert tru_calls == exp_calls


def _turns(*texts: str) -> Messages:
    return [
        Message(role="user" if index % 2 == 0 else "assistant", content=[ContentBlock(text=text)])
        for index, text in enumerate(texts)
    ]


def _texts(messages: Messages) -> list[list[str]]:
    return [[block.get("text", "") for block in message["content"]] for message in messages]


class TestSummarizeMessages:
    """Tests for summarizing whole messages into one summary."""

    @pytest.mark.asyncio
    async def test_leaves_a_pinned_message_out_of_the_summary_and_in_place(self, mock_agent):
        messages = _turns("task", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8")
        messages[4]["metadata"] = {"custom": {"pinned": True}}
        mock_agent.messages = messages
        mock_agent.model.count_tokens = unittest.mock.AsyncMock(return_value=7)
        mock_agent.model.stream = unittest.mock.MagicMock(side_effect=_make_stream_events("run"))
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=2)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        assert mock_agent.model.stream.call_count == 1
        request = str(mock_agent.model.stream.call_args.args[0])
        assert "m1" in request and "m6" in request and "m4" not in request
        assert _texts(messages) == [["task"], ["[Summarized: 5 messages, ~7 tokens]\n\nrun"], ["m4"], ["m7"], ["m8"]]
        assert messages[2]["metadata"]["custom"]["pinned"] is True

    @pytest.mark.asyncio
    async def test_summarizes_the_messages_after_a_pinned_message_one(self, mock_agent):
        messages = _turns("task", "a1", "u2", "a3", "u4", "a5", "u6")
        messages[1]["metadata"] = {"custom": {"pinned": True}}
        mock_agent.messages = messages
        mock_agent.model.count_tokens = unittest.mock.AsyncMock(return_value=7)
        mock_agent.model.stream = unittest.mock.MagicMock(side_effect=_make_stream_events("run"))
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=2)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        assert _texts(messages) == [["task"], ["a1", "[Summarized: 3 messages, ~7 tokens]\n\nrun", "a5"], ["u6"]]
        assert messages[1]["metadata"]["custom"]["pinned"] is True

    @pytest.mark.asyncio
    async def test_keeps_a_pinned_message_after_the_summary_of_its_run(self, mock_agent):
        messages = _turns("task", "a1", "u2", "a3", "u4", "a5", "u6", "a7", "u8")
        messages[3]["metadata"] = {"custom": {"pinned": True}}
        mock_agent.messages = messages
        mock_agent.model.count_tokens = unittest.mock.AsyncMock(return_value=7)
        mock_agent.model.stream = unittest.mock.MagicMock(side_effect=_make_stream_events("run"))
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=3)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        assert mock_agent.model.stream.call_count == 1
        assert _texts(messages) == [
            ["task"],
            ["[Summarized: 4 messages, ~7 tokens]\n\nrun", "a3"],
            ["u6"],
            ["a7"],
            ["u8"],
        ]
        assert messages[1]["metadata"]["custom"]["pinned"] is True

    @pytest.mark.asyncio
    async def test_keeps_the_tool_result_of_a_pinned_tool_use(self, mock_agent):
        tool_use = ContentBlock(toolUse={"toolUseId": "t1", "name": "lookup", "input": {}})
        tool_result = ContentBlock(toolResult={"toolUseId": "t1", "status": "success", "content": [{"text": "r1"}]})
        messages = [
            *_turns("task", "a1", "u2"),
            Message(role="assistant", content=[tool_use], metadata={"custom": {"pinned": True}}),
            Message(role="user", content=[tool_result]),
            Message(role="assistant", content=[ContentBlock(text="a5")]),
            Message(role="user", content=[ContentBlock(text="u6")]),
        ]
        mock_agent.messages = messages
        mock_agent.model.stream = unittest.mock.MagicMock(side_effect=_make_stream_events("run"))
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=2)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        assert [message["role"] for message in messages] == ["user", "assistant", "user", "assistant", "user"]
        assert messages[1]["content"][1] == tool_use
        assert messages[2]["content"] == [tool_result]

    @pytest.mark.asyncio
    async def test_does_not_summarize_a_run_holding_only_an_earlier_summary(self, mock_agent):
        messages = _turns("task", "[Summarized: 3 messages, ~10 tokens]\n\nold", "u2", "a3", "u4")
        mock_agent.messages = messages
        stream = unittest.mock.MagicMock(side_effect=_make_stream_events("again"))
        mock_agent.model.stream = stream
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=3)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is False
        stream.assert_not_called()

    @pytest.mark.asyncio
    async def test_summarizes_a_run_holding_an_earlier_summary_and_an_image(self, mock_agent):
        messages = _turns("task", "[Summarized: 3 messages, ~10 tokens]\n\nold", "u2", "a3", "u4")
        messages[1]["content"].append(ContentBlock(image={"format": "png", "source": {"bytes": b"img"}}))
        mock_agent.messages = messages
        mock_agent.model.stream = unittest.mock.MagicMock(side_effect=_make_stream_events("again"))
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=3)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        assert _texts(messages)[1][-1].endswith("\n\nagain")

    @pytest.mark.asyncio
    async def test_places_the_summary_ahead_of_the_assistant_message_after_a_run_ending_on_a_user_turn(
        self, mock_agent
    ):
        messages = _turns("task", "a1", "u2", "a3", "u4", "a5", "u6")
        messages[3]["tracking_id"] = "a3"
        messages[3]["metadata"] = {"custom": {"source": "planner"}}
        mock_agent.messages = messages
        mock_agent.model.count_tokens = unittest.mock.AsyncMock(return_value=7)
        mock_agent.model.stream = unittest.mock.MagicMock(side_effect=_make_stream_events("run"))
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=4)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        assert _texts(messages) == [
            ["task"],
            ["[Summarized: 2 messages, ~7 tokens]\n\nrun", "a3"],
            ["u4"],
            ["a5"],
            ["u6"],
        ]
        assert messages[1]["tracking_id"] == "a3"
        assert messages[1]["metadata"]["custom"]["source"] == "planner"


_COMPACTION = {"provider": "test", "signature": "opaque"}


class TestServerSideSummary:
    """Tests for routing the conversation's opening to a model with server-side summaries."""

    @pytest.fixture
    def summarizing_agent(self, mock_agent):
        mock_agent.model.model_info = ModelInfo(capabilities=ModelCapabilities(server_side_summary=True))
        compacted = ContentBlock(text="compacted", metadata={"serverSideSummary": _COMPACTION})
        mock_agent.model.summarize = unittest.mock.AsyncMock(
            return_value=SummarizeResult(content=[compacted], usage=None)
        )
        return mock_agent

    @pytest.mark.asyncio
    async def test_compacts_the_opening_run_from_message_zero_into_its_own_message(self, summarizing_agent):
        messages = _turns("task", "a1", "u2", "a3", "u4", "a5", "u6")
        task, a1, u2, a3 = messages[:4]
        summarizing_agent.messages = messages
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=3)

        assert await strategy.apply(ContextState(messages=messages, agent=summarizing_agent, utilization=0.9)) is True

        summarizing_agent.model.summarize.assert_awaited_once()
        assert summarizing_agent.model.summarize.await_args.args[0] == [task, a1, u2, a3]
        assert messages[0] is task
        summary = ContentBlock(
            text="[Summarized: 3 messages, ~5,000 tokens]\n\ncompacted", metadata={"serverSideSummary": _COMPACTION}
        )
        assert messages[1] == Message(role="assistant", content=[summary])
        assert [message["role"] for message in messages] == ["user", "assistant", "user", "assistant", "user"]

    @pytest.mark.asyncio
    async def test_compacts_pinned_messages_with_the_rest_of_the_opening_run(self, summarizing_agent):
        messages = _turns("task", "a1", "u2", "a3", "u4", "a5", "u6")
        messages[1]["metadata"] = {"custom": {"pinned": True}}
        messages[3]["metadata"] = {"custom": {"pinned": True}}
        task, a1, u2, a3 = messages[:4]
        summarizing_agent.messages = messages
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=3)

        assert await strategy.apply(ContextState(messages=messages, agent=summarizing_agent, utilization=0.9)) is True

        assert summarizing_agent.model.summarize.await_args.args[0] == [task, a1, u2, a3]
        summary = ContentBlock(
            text="[Summarized: 3 messages, ~5,000 tokens]\n\ncompacted", metadata={"serverSideSummary": _COMPACTION}
        )
        assert messages == [task, Message(role="assistant", content=[summary]), *_turns("u4", "a5", "u6")]

    @pytest.mark.asyncio
    async def test_keeps_pinned_messages_after_the_base_summary_when_compaction_writes_none(self, summarizing_agent):
        summarizing_agent.model.summarize.return_value = SummarizeResult(content=[])
        messages = _turns("task", "a1", "u2", "a3", "u4", "a5", "u6")
        messages[3]["metadata"] = {"custom": {"pinned": True}}
        summarizing_agent.messages = messages
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=3)

        assert await strategy.apply(ContextState(messages=messages, agent=summarizing_agent, utilization=0.9)) is True

        assert _texts(messages)[1][-1] == "a3"
        assert messages[1]["metadata"]["custom"]["pinned"] is True

    @pytest.mark.asyncio
    async def test_uses_the_base_summary_when_the_run_does_not_start_after_message_zero(self, summarizing_agent):
        messages = _turns("task", "a1", "u2", "a3", "u4", "a5", "u6")
        summarizing_agent.messages = messages
        strategy = Offload.summarize(["tool::lookup"]).when(utilization=0.5, preserve_recent=3)
        tool_use = ContentBlock(toolUse={"toolUseId": "t1", "name": "lookup", "input": {}})
        tool_result = ContentBlock(toolResult={"toolUseId": "t1", "status": "success", "content": [{"text": "r1"}]})
        messages[3] = Message(role="assistant", content=[tool_use])
        messages[4] = Message(role="user", content=[tool_result])

        await strategy.apply(ContextState(messages=messages, agent=summarizing_agent, utilization=0.9))

        summarizing_agent.model.summarize.assert_not_awaited()
        assert "serverSideSummary" not in json.dumps(messages)

    @pytest.mark.asyncio
    async def test_places_the_summary_ahead_of_the_next_assistant_message(self, summarizing_agent):
        messages = _turns("task", "a1", "u2", "a3", "u4", "a5", "u6")
        summarizing_agent.messages = messages
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=4)

        assert await strategy.apply(ContextState(messages=messages, agent=summarizing_agent, utilization=0.9)) is True

        summarizing_agent.model.summarize.assert_awaited_once()
        assert _texts(messages) == [
            ["task"],
            ["[Summarized: 2 messages, ~5,000 tokens]\n\ncompacted", "a3"],
            ["u4"],
            ["a5"],
            ["u6"],
        ]

    @pytest.mark.asyncio
    async def test_gives_the_opening_run_the_base_summary_when_compaction_writes_none(self, summarizing_agent):
        summarizing_agent.model.summarize.return_value = SummarizeResult(content=[])
        messages = _turns("task", "a1", "u2", "a3", "u4", "a5", "u6")
        summarizing_agent.messages = messages
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=3)

        assert await strategy.apply(ContextState(messages=messages, agent=summarizing_agent, utilization=0.9)) is True

        summarizing_agent.model.summarize.assert_awaited_once()
        assert messages[0]["content"] == [{"text": "task"}]
        assert any("Summary of content." in text for message in _texts(messages) for text in message)
        assert "serverSideSummary" not in json.dumps(messages)

    @pytest.mark.asyncio
    async def test_uses_the_base_summary_when_only_the_summarizer_compacts_server_side(self, summarizing_agent):
        summarizer = summarizing_agent.model
        summarizing_agent.model = unittest.mock.MagicMock(model_info=ModelInfo())
        messages = _turns("task", "a1", "u2", "a3", "u4", "a5", "u6")
        summarizing_agent.messages = messages
        strategy = Offload.summarize("*", {"model": summarizer}).when(utilization=0.5, preserve_recent=3)

        assert await strategy.apply(ContextState(messages=messages, agent=summarizing_agent, utilization=0.9)) is True

        summarizer.summarize.assert_not_awaited()
        assert messages[0]["content"] == [{"text": "task"}]
        assert any("Summary of content." in text for message in _texts(messages) for text in message)
        assert "serverSideSummary" not in json.dumps(messages)

    @pytest.mark.asyncio
    async def test_summarizes_blocks_with_the_base_summary(self, summarizing_agent):
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="a" * 10000)]),
        ]
        summarizing_agent.messages = messages
        strategy = Offload.summarize("*").when(threshold=100)

        assert await strategy.apply(ContextState(messages=messages, agent=summarizing_agent, utilization=0.5)) is True

        summarizing_agent.model.summarize.assert_not_awaited()
        assert "Summary of content." in messages[1]["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_compacts_a_run_that_ends_on_a_tool_result(self, summarizing_agent):
        messages: Messages = [Message(role="user", content=[ContentBlock(text="task")])]
        for tool_use_id in ("t1", "t2"):
            messages.append(
                Message(
                    role="assistant",
                    content=[ContentBlock(toolUse={"toolUseId": tool_use_id, "name": "read", "input": {}})],
                )
            )
            messages.append(
                Message(
                    role="user",
                    content=[
                        ContentBlock(
                            toolResult={"toolUseId": tool_use_id, "status": "success", "content": [{"text": "r"}]}
                        )
                    ],
                )
            )
        summarizing_agent.messages = messages
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=2)

        assert await strategy.apply(ContextState(messages=messages, agent=summarizing_agent, utilization=0.9)) is True

        summarizing_agent.model.summarize.assert_awaited_once()
        exp_messages = [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(
                role="assistant",
                content=[
                    ContentBlock(
                        text="[Summarized: 2 messages, ~5,000 tokens]\n\ncompacted",
                        metadata={"serverSideSummary": _COMPACTION},
                    ),
                    ContentBlock(toolUse={"toolUseId": "t2", "name": "read", "input": {}}),
                ],
                metadata={
                    "custom": {"merged_messages": [{"offset": 0, "metadata": {}}, {"offset": 1, "metadata": {}}]}
                },
            ),
            Message(
                role="user",
                content=[ContentBlock(toolResult={"toolUseId": "t2", "status": "success", "content": [{"text": "r"}]})],
            ),
        ]
        assert messages == exp_messages

    @pytest.mark.asyncio
    async def test_keeps_the_first_server_side_summary_verbatim(self, summarizing_agent):
        other = {"provider": "other"}
        summarizing_agent.model.summarize.return_value = SummarizeResult(
            content=[
                ContentBlock(text="plain"),
                ContentBlock(text="  compacted\n", metadata={"serverSideSummary": _COMPACTION}),
                ContentBlock(text="more", metadata={"serverSideSummary": other}),
            ]
        )
        messages = _turns("task", "a1", "u2", "a3", "u4", "a5", "u6")
        summarizing_agent.messages = messages
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=3)

        assert await strategy.apply(ContextState(messages=messages, agent=summarizing_agent, utilization=0.9)) is True

        assert messages[1]["content"][0] == ContentBlock(
            text="[Summarized: 3 messages, ~5,000 tokens]\n\n  compacted\n",
            metadata={"serverSideSummary": _COMPACTION},
        )

    @pytest.mark.asyncio
    async def test_does_not_compact_a_run_holding_only_the_earlier_summary_again(self, summarizing_agent):
        messages = _turns("task", "a1", "u2", "a3", "u4", "a5", "u6")
        summarizing_agent.messages = messages
        strategy = Offload.summarize("*").when(utilization=0.5, preserve_recent=3)
        await strategy.apply(ContextState(messages=messages, agent=summarizing_agent, utilization=0.9))
        summarizing_agent.model.summarize.reset_mock()

        assert await strategy.apply(ContextState(messages=messages, agent=summarizing_agent, utilization=0.9)) is False

        summarizing_agent.model.summarize.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_leaves_a_server_side_summary_in_place(self, summarizing_agent):
        summary = ContentBlock(
            text="[Summarized: 3 messages]\n\n" + "a" * 10000, metadata={"serverSideSummary": _COMPACTION}
        )
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(role="assistant", content=[summary]),
        ]
        summarizing_agent.messages = messages
        stream = unittest.mock.MagicMock(side_effect=_make_stream_events("again"))
        summarizing_agent.model.stream = stream
        summarizing_agent.model.count_tokens = unittest.mock.AsyncMock(
            side_effect=lambda turns: sum(len(block.get("text", "")) for turn in turns for block in turn["content"])
        )
        strategy = Offload.summarize("*").when(threshold=100)

        await strategy.apply(ContextState(messages=messages, agent=summarizing_agent, utilization=0.5))

        stream.assert_not_called()
        assert messages[1]["content"] == [summary]


class TestServerSideSummaryLimitsWarning:
    """Tests for the warning about features a server-side summary doesn't support."""

    _PINNED = "pinned messages are summarized like any other message by a server-side summary"
    _PER_BLOCK = (
        "per-block summarization with preserve_recent rewrites blocks the model has already seen"
        " | thinking from earlier turns will be dropped on the next turns"
    )

    @pytest.fixture
    def summarizing_agent(self, mock_agent):
        mock_agent.model.model_info = ModelInfo(capabilities=ModelCapabilities(server_side_summary=True))
        mock_agent.model.get_config = unittest.mock.MagicMock(return_value={"model_id": "claude-test"})
        mock_agent.messages = _turns("task", "a1", "u2")
        return mock_agent

    @staticmethod
    def _warnings(caplog) -> list[str]:
        return [record.getMessage() for record in caplog.records if record.levelno == logging.WARNING]

    @pytest.mark.parametrize(
        ("pinned", "strategies", "statements"),
        [
            (True, [Offload.summarize("*").when(utilization=0.5)], _PINNED),
            (False, [Offload.summarize("tool_results").when(threshold=100, preserve_recent=2)], _PER_BLOCK),
            (
                True,
                [
                    Offload.summarize("*").when(utilization=0.5),
                    Offload.summarize("*").when(threshold=100, preserve_recent=2),
                ],
                f"{_PINNED} | {_PER_BLOCK}",
            ),
        ],
    )
    def test_describes_the_features_in_use(self, summarizing_agent, caplog, pinned, strategies, statements):
        summarizing_agent.messages[1]["metadata"] = {"custom": {"pinned": pinned}}

        with caplog.at_level(logging.WARNING):
            _warn_on_server_side_summary_limits(summarizing_agent, strategies)

        assert self._warnings(caplog) == [f"model_id=<claude-test> | {statements}"]

    @pytest.mark.parametrize(
        "strategies",
        [
            [Offload.summarize("*").when(utilization=0.5)],
            [Offload.summarize("tool_results").when(threshold=100)],
            [Offload.truncate("tool_results").when(threshold=2500, preserve_recent=2)],
        ],
    )
    def test_stays_silent_without_pins_or_per_block_summarization(self, summarizing_agent, caplog, strategies):
        with caplog.at_level(logging.WARNING):
            _warn_on_server_side_summary_limits(summarizing_agent, strategies)

        assert self._warnings(caplog) == []

    def test_ignores_pins_when_no_summary_compacts_server_side(self, summarizing_agent, caplog):
        summarizing_agent.messages[1]["metadata"] = {"custom": {"pinned": True}}
        summarizer = unittest.mock.MagicMock(model_info=ModelInfo())
        strategies = [Offload.summarize("*", {"model": summarizer}).when(utilization=0.5)]

        with caplog.at_level(logging.WARNING):
            _warn_on_server_side_summary_limits(summarizing_agent, strategies)

        assert self._warnings(caplog) == []

    def test_stays_silent_when_the_agent_model_does_not_compact_server_side(self, summarizing_agent, caplog):
        summarizing_agent.model.model_info = ModelInfo()

        with caplog.at_level(logging.WARNING):
            _warn_on_server_side_summary_limits(
                summarizing_agent, [Offload.summarize("*").when(threshold=100, preserve_recent=2)]
            )

        assert self._warnings(caplog) == []

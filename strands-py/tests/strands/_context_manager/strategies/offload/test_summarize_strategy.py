"""Tests for the SummarizeStrategy."""

import functools
import logging
import unittest.mock

import pytest

from strands._context_manager.strategies.offload import Offload
from strands._context_manager.types import ContextState
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
    agent.model.compact = functools.partial(Model.compact, agent.model)
    agent.model.server_compaction = None
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


COMPACTED: Messages = [
    Message(role="user", content=[ContentBlock(text="task")]),
    Message(role="assistant", content=[ContentBlock(text="summary")]),
    Message(role="user", content=[ContentBlock(text="latest")]),
]


@pytest.fixture
def routing_agent(mock_agent):
    mock_agent.tool_registry.get_all_tool_specs.return_value = [{"name": "read"}]
    mock_agent.system_prompt = "live system prompt"
    mock_agent.system_prompt_content = [{"text": "live system prompt"}]
    mock_agent.model.compact = unittest.mock.AsyncMock(return_value=list(COMPACTED))
    return mock_agent


class TestSummarizeStrategyRouting:
    """Tests for which summaries go through Model.compact."""

    @pytest.mark.asyncio
    async def test_sends_a_whole_history_message_level_summary_through_compact(self, routing_agent):
        received = []

        async def compact(messages, **kwargs):
            received.append((list(messages), kwargs))
            return list(COMPACTED)

        routing_agent.model.compact = compact
        strategy = Offload.summarize("*", {"system_prompt": "Keep ids"}).when(utilization=0.7, preserve_recent=2)
        messages = _routing_history()
        original = list(messages)

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.5)) is False
        assert received == []

        context = ContextState(messages=messages, agent=routing_agent, utilization=0.5, overflow=True)
        assert await strategy.apply(context) is True
        exp_kwargs = {
            "preserved_messages": 2,
            "tool_specs": [{"name": "read"}],
            "system_prompt": "live system prompt",
            "system_prompt_content": [{"text": "live system prompt"}],
            "instructions": "Keep ids",
            "invocation_context": None,
        }
        assert received == [(original, exp_kwargs)]
        assert messages == COMPACTED

    @pytest.mark.asyncio
    async def test_leaves_the_history_unchanged_when_compact_has_nothing_to_compact(self, routing_agent):
        routing_agent.model.compact.return_value = None
        strategy = Offload.summarize("*").when(utilization=0.7)
        messages = _routing_history()

        assert await strategy.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is False
        assert messages == _routing_history()

    @pytest.mark.asyncio
    async def test_keeps_target_filtered_and_threshold_message_level_summaries_on_the_client_side_path(
        self, routing_agent
    ):
        strategies = [
            Offload.summarize("tool_results").when(utilization=0.7),
            Offload.summarize("*").when(utilization=0.7, threshold=10),
        ]

        for strategy in strategies:
            context = ContextState(messages=_routing_history(), agent=routing_agent, utilization=0.9)
            assert await strategy.apply(context) is True
        routing_agent.model.compact.assert_not_called()

    @pytest.mark.asyncio
    async def test_sends_a_retroactive_per_block_summary_through_compact_only_when_the_model_compacts_server_side(
        self, routing_agent
    ):
        retroactive = Offload.summarize("tool_results").when(preserve_recent=1)
        eager = Offload.summarize("tool_results").when(threshold=10)

        routing_agent.model.server_compaction = None
        context = ContextState(messages=_routing_history(), agent=routing_agent, utilization=0.9)
        assert await retroactive.apply(context) is True
        routing_agent.model.compact.assert_not_called()

        routing_agent.model.server_compaction = True
        context = ContextState(messages=_routing_history(), agent=routing_agent, utilization=0.9)
        assert await eager.apply(context) is True
        routing_agent.model.compact.assert_not_called()

        no_tool_results: Messages = [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(role="assistant", content=[ContentBlock(text="a")]),
            Message(role="user", content=[ContentBlock(text="b")]),
            Message(role="assistant", content=[ContentBlock(text="c")]),
        ]
        context = ContextState(messages=no_tool_results, agent=routing_agent, utilization=0.9)
        assert await retroactive.apply(context) is False
        below_threshold = Offload.summarize("tool_results").when(threshold=100_000, preserve_recent=1)
        context = ContextState(messages=_routing_history(), agent=routing_agent, utilization=0.9)
        assert await below_threshold.apply(context) is False
        routing_agent.model.compact.assert_not_called()

        messages = _routing_history()
        assert await retroactive.apply(ContextState(messages=messages, agent=routing_agent, utilization=0.9)) is True
        routing_agent.model.compact.assert_called_once()
        assert routing_agent.model.compact.call_args.kwargs["preserved_messages"] == 4
        assert messages == COMPACTED

    @pytest.mark.asyncio
    async def test_keeps_a_tool_pair_that_straddles_the_preserve_recent_cut_out_of_the_summary(self, mock_agent):
        tool_use = Message(
            role="assistant", content=[ContentBlock(toolUse=ToolUse(toolUseId="tool-1", name="read", input={}))]
        )
        tool_result = Message(
            role="user",
            content=[
                ContentBlock(toolResult=ToolResult(toolUseId="tool-1", status="success", content=[{"text": "ok"}]))
            ],
        )
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(role="assistant", content=[ContentBlock(text="a")]),
            Message(role="user", content=[ContentBlock(text="b")]),
            tool_use,
            tool_result,
            Message(role="assistant", content=[ContentBlock(text="c")]),
            Message(role="user", content=[ContentBlock(text="latest")]),
        ]
        original = list(messages)
        strategy = Offload.summarize("*").when(utilization=0.7, preserve_recent=3)

        assert await strategy.apply(ContextState(messages=messages, agent=mock_agent, utilization=0.9)) is True

        exp_messages = [
            original[0],
            {
                "role": "assistant",
                "content": [
                    *tool_use["content"],
                    {"text": "[Summarized: 2 messages, ~5,000 tokens]\n\nSummary of content."},
                ],
            },
            tool_result,
            original[5],
            original[6],
        ]
        assert messages == exp_messages

"""Tests for the agentic context-management tools."""

from unittest.mock import Mock

import pytest

from strands._context_manager.modes.agentic.agentic_context import (
    pin_context,
    summarize_context,
    truncate_context,
)
from strands.agent.conversation_manager.compression.pin_message import pin_message
from strands.hooks.registry import HookRegistry
from strands.telemetry.metrics import EventLoopMetrics
from strands.types.content import Message


def text_msg(role: str, text: str) -> Message:
    return {"role": role, "content": [{"text": text}]}


def tool_use_msg(tool_use_id: str, name: str = "test") -> Message:
    return {"role": "assistant", "content": [{"toolUse": {"toolUseId": tool_use_id, "name": name, "input": {}}}]}


def tool_result_msg(tool_use_id: str, text: str = "result") -> Message:
    return {
        "role": "user",
        "content": [{"toolResult": {"toolUseId": tool_use_id, "status": "success", "content": [{"text": text}]}}],
    }


def make_messages(count: int) -> list[Message]:
    return [text_msg("user" if i % 2 == 0 else "assistant", f"Message {i + 1}") for i in range(count)]


async def _mock_model_stream(response_text):
    yield {"messageStart": {"role": "assistant"}}
    yield {"contentBlockStart": {"start": {}}}
    yield {"contentBlockDelta": {"delta": {"text": response_text}}}
    yield {"contentBlockStop": {}}
    yield {"messageStop": {"stopReason": "end_turn"}}


async def _mock_model_stream_error(error):
    raise error
    yield  # pragma: no cover - makes this a generator


def mock_model(summary_text="Summary of older messages"):
    model = Mock()
    model.stream = Mock(side_effect=lambda *a, **kw: _mock_model_stream(summary_text))
    return model


def make_agent(messages, model=None):
    agent = Mock()
    agent.messages = messages
    agent.model = model if model is not None else Mock()
    agent.hooks = HookRegistry()
    agent.event_loop_metrics = EventLoopMetrics()
    return agent


async def invoke_tool(decorated_tool, agent, alist, **tool_input):
    """Invoke a decorated tool and return its string result."""
    tool_use = {"toolUseId": "test-id", "name": decorated_tool.tool_name, "input": tool_input}
    events = await alist(decorated_tool.stream(tool_use, {"agent": agent}))
    return events[-1].tool_result["content"][0]["text"]


@pytest.mark.asyncio
class TestSummarizeContext:
    async def test_returns_message_when_not_enough_messages_to_summarize(self, alist):
        messages = make_messages(4)
        agent = make_agent(messages)
        result = await invoke_tool(summarize_context, agent, alist, keep_recent=10)
        assert "No summarization performed" in result
        assert "not enough eligible messages" in result
        assert len(messages) == 4

    async def test_summarizes_eligible_messages_and_splices_the_array(self, alist):
        messages = make_messages(20)
        agent = make_agent(messages, mock_model("Summary"))
        result = await invoke_tool(summarize_context, agent, alist, keep_recent=10, summary_ratio=0.5)
        assert "Summarized" in result
        assert "message(s)" in result
        assert len(messages) < 20
        assert messages[0]["role"] == "user"

    async def test_assigns_a_durable_tracking_id_to_the_generated_summary(self, alist):
        # The summary message is spliced straight into agent.messages, bypassing the append
        # chokepoint, so summarize_context must assign it a durable tracking id itself.
        messages = make_messages(20)
        agent = make_agent(messages, mock_model("Summary"))
        await invoke_tool(summarize_context, agent, alist, keep_recent=10, summary_ratio=0.5)
        summary_message = next(msg for msg in messages if msg["content"][0].get("text") == "Summary")
        assert isinstance(summary_message.get("tracking_id"), str)
        assert summary_message["tracking_id"]

    async def test_preserves_pinned_messages_during_summarization(self, alist):
        messages = make_messages(20)
        pin_message(messages, 1)
        pinned_text = messages[1]["content"][0]["text"]
        agent = make_agent(messages, mock_model("Summary"))

        await invoke_tool(summarize_context, agent, alist, keep_recent=6, summary_ratio=0.5)

        texts = [m["content"][0].get("text") for m in messages]
        assert pinned_text in texts

    async def test_respects_message_type_filter(self, alist):
        messages = [tool_use_msg("id-1"), tool_result_msg("id-1"), *make_messages(14)]
        agent = make_agent(messages, mock_model("Summary"))
        result = await invoke_tool(
            summarize_context, agent, alist, keep_recent=10, summary_ratio=0.3, message_type="messages"
        )
        assert '"messages"' in result

    async def test_returns_message_when_no_eligible_messages_after_filtering(self, alist):
        messages = [
            tool_use_msg("id-1"),
            tool_result_msg("id-1"),
            tool_use_msg("id-2"),
            tool_result_msg("id-2"),
            *make_messages(12),
        ]
        agent = make_agent(messages, mock_model())
        result = await invoke_tool(
            summarize_context, agent, alist, keep_recent=12, summary_ratio=0.3, message_type="messages"
        )
        assert "No summarization performed" in result

    async def test_preserves_pinned_tool_use_when_its_tool_result_is_eligible(self, alist):
        messages = [tool_use_msg("id-1"), tool_result_msg("id-1", "Important result"), *make_messages(14)]
        pin_message(messages, 0)
        agent = make_agent(messages, mock_model("Summary"))

        await invoke_tool(summarize_context, agent, alist, keep_recent=10, summary_ratio=0.3)

        has_tool_use = any(
            any("toolUse" in block for block in m["content"]) and m.get("metadata", {}).get("custom", {}).get("pinned")
            for m in messages
        )
        assert has_tool_use is True

    async def test_preserves_message_order_with_pinned_assistant_message(self, alist):
        messages = [text_msg("user", "First"), text_msg("assistant", "Pinned response"), *make_messages(18)]
        pin_message(messages, 1)
        agent = make_agent(messages, mock_model("Summary"))

        await invoke_tool(summarize_context, agent, alist, keep_recent=10, summary_ratio=0.3)

        assert messages[0]["role"] == "user"

    async def test_returns_failure_message_when_model_throws(self, alist):
        model = Mock()
        model.stream = Mock(side_effect=lambda *a, **kw: _mock_model_stream_error(RuntimeError("model error")))
        messages = make_messages(20)
        agent = make_agent(messages, model)
        result = await invoke_tool(summarize_context, agent, alist, keep_recent=5, summary_ratio=0.5)
        assert "Summarization failed" in result


@pytest.mark.asyncio
class TestTruncateContext:
    async def test_does_not_drop_when_keep_recent_exceeds_length(self, alist):
        messages = make_messages(6)
        agent = make_agent(messages)
        result = await invoke_tool(truncate_context, agent, alist, keep_recent=10)
        assert "No messages dropped" in result
        assert len(messages) == 6

    async def test_preserves_message_order_when_pinned_assistant_message_exists(self, alist):
        messages = [text_msg("user", "First"), text_msg("assistant", "Response"), *make_messages(18)]
        pin_message(messages, 1)
        agent = make_agent(messages)

        await invoke_tool(truncate_context, agent, alist, keep_recent=5)

        assert messages[0]["role"] == "user"

    async def test_returns_message_when_conversation_is_too_short(self, alist):
        messages = make_messages(2)
        agent = make_agent(messages)
        result = await invoke_tool(truncate_context, agent, alist)
        assert "No messages dropped" in result
        assert "only has 2 messages" in result
        assert len(messages) == 2

    async def test_drops_oldest_messages_respecting_window(self, alist):
        messages = make_messages(20)
        agent = make_agent(messages)
        result = await invoke_tool(truncate_context, agent, alist, keep_recent=5)
        assert "Dropped" in result
        assert "remaining" in result
        assert len(messages) < 20
        assert len(messages) >= 4
        assert messages[-1]["content"][0]["text"] == "Message 20"

    async def test_preserves_pinned_messages_during_truncation(self, alist):
        messages = make_messages(20)
        pin_message(messages, 0)
        pin_message(messages, 1)
        pinned_text_0 = messages[0]["content"][0]["text"]
        pinned_text_1 = messages[1]["content"][0]["text"]
        agent = make_agent(messages)

        await invoke_tool(truncate_context, agent, alist, keep_recent=5)

        remaining_texts = [m["content"][0].get("text") for m in messages]
        assert pinned_text_0 in remaining_texts
        assert pinned_text_1 in remaining_texts

    async def test_respects_message_type_filter(self, alist):
        messages = [
            text_msg("user", "Hello"),
            text_msg("assistant", "Hi"),
            tool_use_msg("id-1"),
            tool_result_msg("id-1"),
            *make_messages(10),
        ]
        agent = make_agent(messages)
        result = await invoke_tool(truncate_context, agent, alist, keep_recent=5, message_type="messages")
        assert '"messages"' in result

    async def test_returns_message_when_no_valid_trim_point_found(self, alist):
        messages = [tool_result_msg(f"id-{i}") for i in range(6)]
        agent = make_agent(messages)
        result = await invoke_tool(truncate_context, agent, alist, keep_recent=2)
        assert "No messages dropped" in result
        assert "no valid trim boundary" in result


@pytest.mark.asyncio
class TestPinContextLastTurn:
    async def test_pins_the_entire_current_turn(self, alist):
        messages = [
            text_msg("user", "First question"),
            text_msg("assistant", "First answer"),
            text_msg("user", "Second question"),
            text_msg("assistant", "Second answer"),
        ]
        agent = make_agent(messages)
        result = await invoke_tool(pin_context, agent, alist, select="last_turn", action="pin")
        assert "Pinned" in result
        assert "2 message(s)" in result
        assert messages[2]["metadata"]["custom"]["pinned"] is True
        assert messages[3]["metadata"]["custom"]["pinned"] is True
        assert "metadata" not in messages[0]

    async def test_includes_tool_calls_in_the_current_turn(self, alist):
        messages = [
            text_msg("user", "Old question"),
            text_msg("assistant", "Old answer"),
            text_msg("user", "Check weather"),
            tool_use_msg("id-1", "weather"),
            tool_result_msg("id-1", "Sunny"),
            text_msg("assistant", "It is sunny"),
        ]
        agent = make_agent(messages)
        result = await invoke_tool(pin_context, agent, alist, select="last_turn", action="pin")
        assert "4 message(s)" in result
        assert messages[2]["metadata"]["custom"]["pinned"] is True
        assert messages[3]["metadata"]["custom"]["pinned"] is True
        assert messages[4]["metadata"]["custom"]["pinned"] is True
        assert messages[5]["metadata"]["custom"]["pinned"] is True
        assert "metadata" not in messages[0]

    async def test_pins_with_filter_on_last_turn(self, alist):
        messages = [
            text_msg("user", "Old"),
            text_msg("assistant", "Old"),
            text_msg("user", "New question"),
            text_msg("assistant", "New answer"),
        ]
        agent = make_agent(messages)
        result = await invoke_tool(pin_context, agent, alist, select="last_turn", filter="user", action="pin")
        assert "1 message(s)" in result
        assert messages[2]["metadata"]["custom"]["pinned"] is True
        assert "metadata" not in messages[3]


@pytest.mark.asyncio
class TestPinContextLastN:
    async def test_pins_the_last_n_messages(self, alist):
        messages = make_messages(6)
        agent = make_agent(messages)
        result = await invoke_tool(pin_context, agent, alist, select=3, action="pin")
        assert "Pinned" in result
        assert "3 message(s)" in result
        assert messages[3]["metadata"]["custom"]["pinned"] is True
        assert messages[4]["metadata"]["custom"]["pinned"] is True
        assert messages[5]["metadata"]["custom"]["pinned"] is True
        assert "metadata" not in messages[0]

    async def test_clamps_to_conversation_length(self, alist):
        messages = make_messages(3)
        agent = make_agent(messages)
        result = await invoke_tool(pin_context, agent, alist, select=100, action="pin")
        assert "3 message(s)" in result

    async def test_filters_by_role_within_last_n(self, alist):
        messages = make_messages(6)
        agent = make_agent(messages)
        result = await invoke_tool(pin_context, agent, alist, select=6, filter="user", action="pin")
        assert "3 message(s)" in result
        assert messages[0]["metadata"]["custom"]["pinned"] is True
        assert messages[2]["metadata"]["custom"]["pinned"] is True
        assert messages[4]["metadata"]["custom"]["pinned"] is True
        assert "metadata" not in messages[1]


@pytest.mark.asyncio
class TestPinContextIndices:
    async def test_pins_messages_at_specific_indices(self, alist):
        messages = make_messages(6)
        agent = make_agent(messages)
        result = await invoke_tool(pin_context, agent, alist, select=[0, 2, 4], action="pin")
        assert "Pinned" in result
        assert "3 message(s)" in result
        assert messages[0]["metadata"]["custom"]["pinned"] is True
        assert "metadata" not in messages[1]
        assert messages[2]["metadata"]["custom"]["pinned"] is True
        assert messages[4]["metadata"]["custom"]["pinned"] is True

    async def test_returns_error_when_all_indices_out_of_range(self, alist):
        messages = make_messages(3)
        agent = make_agent(messages)
        result = await invoke_tool(pin_context, agent, alist, select=[10, 20, 30], action="pin")
        assert "All indices out of range" in result
        assert "3 messages" in result

    async def test_filters_out_of_range_indices_but_pins_valid_ones(self, alist):
        messages = make_messages(4)
        agent = make_agent(messages)
        result = await invoke_tool(pin_context, agent, alist, select=[1, 99], action="pin")
        assert "Pinned" in result
        assert "1 message(s)" in result
        assert messages[1]["metadata"]["custom"]["pinned"] is True

    async def test_rejects_negative_indices(self, alist):
        messages = make_messages(5)
        agent = make_agent(messages)
        result = await invoke_tool(pin_context, agent, alist, select=[-1], action="pin")
        assert "All indices out of range" in result
        # The negative index must not wrap around and pin the last message.
        assert all("metadata" not in m for m in messages)

    async def test_pins_valid_indices_and_drops_negative_ones(self, alist):
        messages = make_messages(5)
        agent = make_agent(messages)
        result = await invoke_tool(pin_context, agent, alist, select=[-1, 2], action="pin")
        assert "1 message(s)" in result
        assert messages[2]["metadata"]["custom"]["pinned"] is True
        assert "metadata" not in messages[4]


@pytest.mark.asyncio
class TestPinContextToolsFilter:
    async def test_pins_only_tool_use_and_tool_result_messages(self, alist):
        messages = [
            text_msg("user", "Do something"),
            tool_use_msg("id-1"),
            tool_result_msg("id-1", "Result"),
            text_msg("assistant", "Done"),
        ]
        agent = make_agent(messages)
        result = await invoke_tool(pin_context, agent, alist, select=4, filter="tools", action="pin")
        assert "2 message(s)" in result
        assert messages[1]["metadata"]["custom"]["pinned"] is True
        assert messages[2]["metadata"]["custom"]["pinned"] is True
        assert "metadata" not in messages[0]
        assert "metadata" not in messages[3]


@pytest.mark.asyncio
class TestPinContextUnpin:
    async def test_removes_pin_from_previously_pinned_messages(self, alist):
        messages = make_messages(4)
        pin_message(messages, 1)
        pin_message(messages, 2)
        agent = make_agent(messages)

        result = await invoke_tool(pin_context, agent, alist, select=[1, 2], action="unpin")
        assert "Unpinned" in result
        assert "2 message(s)" in result
        assert "metadata" not in messages[1]
        assert "metadata" not in messages[2]

    async def test_unpins_last_n_messages(self, alist):
        messages = make_messages(4)
        pin_message(messages, 2)
        pin_message(messages, 3)
        agent = make_agent(messages)

        await invoke_tool(pin_context, agent, alist, select=2, action="unpin")
        assert "metadata" not in messages[2]
        assert "metadata" not in messages[3]


@pytest.mark.asyncio
class TestPinContextEmptyConversation:
    async def test_returns_appropriate_message(self, alist):
        agent = make_agent([])
        result = await invoke_tool(pin_context, agent, alist, select="last_turn", action="pin")
        assert result == "No messages in the conversation."

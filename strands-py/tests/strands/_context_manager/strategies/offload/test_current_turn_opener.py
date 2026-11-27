"""The user message that opens the current turn survives whole-message offloading (goal loss after compaction)."""

import unittest.mock

import pytest

from strands._context_manager.strategies.offload import Offload
from strands._context_manager.strategies.offload.base import current_turn_opener
from strands._context_manager.types import ContextState
from strands.models import Model
from strands.models._summarize import _SUMMARIZE_GUARD, DEFAULT_SUMMARIZE_INSTRUCTIONS
from strands.types.content import ContentBlock, Message, Messages
from strands.types.tools import ToolResult, ToolUse
from tests.fixtures.context_manager_helpers import heuristic_model, make_agent

TASK = "Read every file in the project, then tell me the total line count."


def _text(role: str, text: str) -> Message:
    return Message(role=role, content=[ContentBlock(text=text)])


def _tool_use(tool_use_id: str) -> Message:
    return Message(
        role="assistant",
        content=[ContentBlock(toolUse=ToolUse(toolUseId=tool_use_id, name="read_file", input={"path": tool_use_id}))],
    )


def _tool_result(tool_use_id: str) -> Message:
    result = ToolResult(toolUseId=tool_use_id, status="success", content=[{"text": "line\n" * 200}])
    return Message(role="user", content=[ContentBlock(toolResult=result)])


def _tool_loop() -> Messages:
    """A greeting turn, then a task whose tool loop is under way."""
    return [
        _text("user", "hello"),
        _text("assistant", "Hello! How can I help?"),
        _text("user", TASK),
        _tool_use("t1"),
        _tool_result("t1"),
        _tool_use("t2"),
        _tool_result("t2"),
    ]


def _summarizing_model() -> unittest.mock.MagicMock:
    async def stream(*args, **kwargs):
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": "Summary of content."}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}
        yield {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}}}

    async def summarize(messages, **kwargs):
        return await Model.summarize(model, messages, **kwargs)

    model = heuristic_model(count_tokens=unittest.mock.AsyncMock(return_value=5000))
    model.stream = unittest.mock.MagicMock(side_effect=stream)
    model.summarize = unittest.mock.AsyncMock(side_effect=summarize)
    model.get_config = unittest.mock.MagicMock(return_value={"model_id": "claude-haiku-5-5"})
    model.model_info.capabilities.server_side_summary = False
    return model


def _user_texts(messages: Messages) -> list[str]:
    user_messages = [message for message in messages if message["role"] == "user"]
    return [block["text"] for message in user_messages for block in message["content"] if "text" in block]


class TestCurrentTurnOpener:
    def test_finds_the_last_user_message_without_a_tool_result(self):
        assert current_turn_opener(_tool_loop()) == 2

    def test_is_none_in_the_first_turn_since_message_0_is_protected_already(self):
        assert current_turn_opener([_text("user", TASK), _tool_use("t1"), _tool_result("t1")]) is None


class TestSummarizeKeepsTheCurrentRequest:
    @pytest.mark.asyncio
    async def test_keeps_the_request_as_a_user_message_after_summarizing_the_tool_loop(self):
        messages = _tool_loop()
        opener = messages[2]
        model = _summarizing_model()
        agent = make_agent(messages, model)
        strategy = Offload.summarize("*").when(context_utilization="80%", preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=agent, utilization=0.9)) is True

        assert any(message is opener for message in messages)
        assert _user_texts(messages) == ["hello", TASK]

    @pytest.mark.asyncio
    async def test_summarizes_the_tool_loop_over_the_agent_prefix_which_holds_the_request(self):
        messages = _tool_loop()
        expected_prefix = list(messages[:5])
        model = _summarizing_model()
        agent = make_agent(messages, model)
        strategy = Offload.summarize("*").when(context_utilization="80%", preserve_recent=1)

        await strategy.apply(ContextState(messages=messages, agent=agent, utilization=0.9))

        # The later run goes first: the tool loop's request is the history up to its last message, as the agent sent
        # it, so it shares the agent's prompt cache and the summarizer sees the request the tool loop works toward.
        assert model.summarize.await_args_list[0].args[0] == expected_prefix


class TestDropKeepsTheCurrentRequest:
    @pytest.mark.asyncio
    async def test_keeps_the_request_as_a_user_message_after_dropping_the_tool_loop(self):
        messages = _tool_loop()
        agent = make_agent(messages, _summarizing_model())

        assert (
            await Offload.drop("*")
            .when(preserve_recent=1)
            .apply(ContextState(messages=messages, agent=agent, utilization=0.9))
        )

        assert _user_texts(messages) == ["hello", TASK]


class TestSummarizeInstructions:
    def test_the_guard_says_it_is_not_from_the_user(self):
        assert "This is not a message from the user." in _SUMMARIZE_GUARD
        assert "Do not mention this compaction request in the summary." in _SUMMARIZE_GUARD

    def test_the_instructions_ask_for_the_most_recent_request_verbatim(self):
        expected = "the user's most recent request, quoted verbatim, and progress toward it"
        assert expected in DEFAULT_SUMMARIZE_INSTRUCTIONS
        assert "outstanding requests" not in DEFAULT_SUMMARIZE_INSTRUCTIONS

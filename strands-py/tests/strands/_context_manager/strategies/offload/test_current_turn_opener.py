"""The user message that opens the current turn survives whole-message offloading (goal loss after compaction)."""

import unittest.mock

import pytest

from strands._context_manager.context_manager import ContextManager
from strands._context_manager.placeholder import REMOVED_MESSAGES, format_summarized, is_offloaded, offload_placeholder
from strands._context_manager.strategies.offload import Offload
from strands._context_manager.strategies.offload.base import EmergencyTruncateStrategy, current_turn_opener
from strands._context_manager.types import ContextState
from strands.agent._turn_opener import is_turn_opener, mark_turn_opener
from strands.hooks import HookRegistry
from strands.hooks.events import AfterModelCallEvent
from strands.models import Model
from strands.models._summarize import _SUMMARIZE_GUARD, DEFAULT_SUMMARIZE_INSTRUCTIONS
from strands.types.content import ContentBlock, Message, Messages
from strands.types.exceptions import ContextWindowOverflowException
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


def _marked_tool_loop() -> Messages:
    """The tool loop as the agent stores it, with each prompt marked as its turn's opener."""
    messages = _tool_loop()
    messages[0] = mark_turn_opener([messages[0]])[0]
    messages[2] = mark_turn_opener([messages[2]])[0]
    return messages


def _after_greeting_summary(tool_steps: int) -> Messages:
    """The marked tool loop once the greeting reply was summarized, with ``tool_steps`` steps under way."""
    marker = offload_placeholder("summarize", format_summarized(REMOVED_MESSAGES, 40, "The user said hello."), None, 40)
    messages = _marked_tool_loop()
    steps = [
        message for index in range(1, tool_steps + 1) for message in (_tool_use(f"t{index}"), _tool_result(f"t{index}"))
    ]
    return [messages[0], Message(role="assistant", content=[marker]), messages[2], *steps]


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


def _all_texts(messages: Messages) -> list[str]:
    return [block["text"] for message in messages for block in message["content"] if "text" in block]


def _content_messages(messages: Messages) -> int:
    return sum(not all(is_offloaded(block) for block in message["content"]) for message in messages)


def _tool_use_ids(messages: Messages) -> list[str]:
    return [block["toolUse"]["toolUseId"] for message in messages for block in message["content"] if "toolUse" in block]


def _user_texts(messages: Messages) -> list[str]:
    user_messages = [message for message in messages if message["role"] == "user"]
    return [block["text"] for message in user_messages for block in message["content"] if "text" in block]


class TestCurrentTurnOpener:
    def test_finds_the_last_user_message_without_a_tool_result(self):
        assert current_turn_opener(_tool_loop()) == 2

    def test_is_none_in_the_first_turn_since_message_0_is_protected_already(self):
        assert current_turn_opener([_text("user", TASK), _tool_use("t1"), _tool_result("t1")]) is None

    def test_prefers_the_marked_request_over_later_user_text_the_sdk_added(self):
        # A forced structured output pass appends its own prompt as a user message mid-turn.
        messages = _marked_tool_loop()
        messages += [_text("assistant", "Done."), _text("user", "Use the structured output tool now.")]

        assert current_turn_opener(messages) == 2

    def test_is_none_when_the_marked_request_is_message_0(self):
        messages = [*mark_turn_opener([_text("user", TASK)]), _tool_use("t1"), _tool_result("t1"), _text("user", "x")]

        assert current_turn_opener(messages) is None


class TestMarkTurnOpener:
    def test_marks_a_copy_of_the_last_user_message_without_a_tool_result(self):
        prompt = [_text("user", "context"), _text("assistant", "ok"), _text("user", TASK)]

        marked = mark_turn_opener(prompt)

        assert [is_turn_opener(message) for message in marked] == [False, False, True]
        assert marked[2]["content"] == prompt[2]["content"]
        assert "metadata" not in prompt[2]

    def test_keeps_existing_metadata(self):
        pinned = Message(role="user", content=[ContentBlock(text=TASK)], metadata={"custom": {"pinned": True}})

        assert mark_turn_opener([pinned])[0]["metadata"] == {"custom": {"pinned": True, "turn_opener": True}}

    def test_leaves_messages_without_a_request_unchanged(self):
        messages = [_tool_result("t1")]

        assert mark_turn_opener(messages) is messages


class TestSummarizeKeepsTheCurrentRequest:
    @pytest.mark.asyncio
    async def test_keeps_the_request_as_a_user_message_after_summarizing_the_tool_loop(self):
        messages = _tool_loop()
        opener = messages[2]
        model = _summarizing_model()
        agent = make_agent(messages, model)
        strategy = Offload.summarize("*").when(context_utilization="80%", preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=agent, utilization=0.9)) is True

        # The greeting reply and the finished tool steps are one summary after the request, which stays user text
        # beside the greeting it now follows directly.
        assert [message["role"] for message in messages] == ["user", "assistant", "user"]
        assert messages[0]["content"] == [*_tool_loop()[0]["content"], *opener["content"]]
        assert messages[1]["content"][0]["text"].startswith("[Summarized")
        assert "toolUse" in messages[1]["content"][-1]
        assert model.summarize.await_count == 1

    @pytest.mark.asyncio
    async def test_summarizes_the_tool_loop_over_the_agent_prefix_which_holds_the_request(self):
        messages = _tool_loop()
        expected_prefix = list(messages[:5])
        model = _summarizing_model()
        agent = make_agent(messages, model)
        strategy = Offload.summarize("*").when(context_utilization="80%", preserve_recent=1)

        await strategy.apply(ContextState(messages=messages, agent=agent, utilization=0.9))

        # One request, the history up to the run's last message as the agent sent it, so it shares the agent's prompt
        # cache, its instruction joins the tool result turn, and the summarizer sees the request the loop works on.
        assert [call.args[0] for call in model.summarize.await_args_list] == [expected_prefix]


class TestSummarizeSkipsAnEarlierSummary:
    @pytest.mark.asyncio
    async def test_does_not_summarize_a_run_holding_only_an_earlier_summary(self):
        messages = _after_greeting_summary(tool_steps=1)
        before = list(messages)
        model = _summarizing_model()
        agent = make_agent(messages, model)
        strategy = Offload.summarize("*").when(context_utilization="80%", preserve_recent=2)

        assert await strategy.apply(ContextState(messages=messages, agent=agent, utilization=0.9)) is False

        assert model.summarize.await_count == 0
        assert messages == before

    @pytest.mark.asyncio
    async def test_summarizes_an_earlier_summary_together_with_new_messages(self):
        messages = _after_greeting_summary(tool_steps=2)
        model = _summarizing_model()
        agent = make_agent(messages, model)
        strategy = Offload.summarize("*").when(context_utilization="80%", preserve_recent=1)

        assert await strategy.apply(ContextState(messages=messages, agent=agent, utilization=0.9)) is True

        assert model.summarize.await_count == 1
        assert not any("The user said hello." in text for text in _all_texts(messages))
        assert _user_texts(messages) == ["hello", TASK]

    @pytest.mark.asyncio
    async def test_an_overflow_after_the_first_turn_falls_through_to_emergency_truncation(self):
        messages = _after_greeting_summary(tool_steps=6)
        opener = messages[2]
        model = _summarizing_model()
        agent = make_agent(messages, model)
        agent.hooks = HookRegistry()
        agent.tool_registry.get_all_tool_specs.return_value = []
        strategy = Offload.summarize("*").when(context_utilization="80%", preserve_recent=12)
        ContextManager(strategies=[strategy], archive=False).init_agent(agent)

        for kept in (["t2", "t3", "t4", "t5", "t6"], ["t3", "t4", "t5", "t6"], ["t4", "t5", "t6"]):
            event = AfterModelCallEvent(agent=agent, exception=ContextWindowOverflowException("overflow"))
            await agent.hooks.invoke_callbacks_async(event)

            assert event.retry is True
            assert _tool_use_ids(messages) == kept
        assert model.summarize.await_count == 0
        assert opener in messages


class TestEmergencyTruncateKeepsTheCurrentRequest:
    @pytest.mark.asyncio
    async def test_keeps_the_request_when_it_falls_in_the_oldest_messages(self):
        messages = [
            *_marked_tool_loop(),
            *(message for index in (3, 4) for message in (_tool_use(f"t{index}"), _tool_result(f"t{index}"))),
        ]
        first, opener = messages[0], messages[2]
        context = ContextState(messages=messages, agent=make_agent(messages), utilization=1.1, overflow=True)

        assert await EmergencyTruncateStrategy().apply(context) is True

        assert "Hello! How can I help?" not in _all_texts(messages)
        assert messages[0] is first
        assert messages[2] is opener
        assert opener["content"] == _tool_loop()[2]["content"]
        roles = [message["role"] for message in messages]
        assert all(earlier != later for earlier, later in zip(roles, roles[1:], strict=False))

    @pytest.mark.asyncio
    async def test_reaches_the_tool_steps_past_the_request_across_passes(self):
        messages = _after_greeting_summary(tool_steps=6)
        opener = messages[2]
        context = ContextState(messages=messages, agent=make_agent(messages), utilization=1.1, overflow=True)

        for _ in range(3):
            assert await EmergencyTruncateStrategy().apply(context) is True

        assert "t1" not in _tool_use_ids(messages)
        assert opener in messages

    @pytest.mark.parametrize(
        "build", [_marked_tool_loop, lambda: _after_greeting_summary(tool_steps=2)], ids=["greeting", "summary"]
    )
    @pytest.mark.asyncio
    async def test_shrinks_a_short_history_across_passes(self, build):
        messages = build()
        opener = messages[2]
        context = ContextState(messages=messages, agent=make_agent(messages), utilization=1.1, overflow=True)

        results = []
        for _ in range(3):
            kept = _content_messages(messages)
            results.append(await EmergencyTruncateStrategy().apply(context))
            assert results[-1] is (_content_messages(messages) < kept)

        assert results[-1] is False
        assert "t1" not in _tool_use_ids(messages)
        assert opener in messages


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
    def test_the_guard_opens_with_the_stop_and_the_tool_ban(self):
        # A guard that opens by saying it is not from the user led GPT and Nova to call a tool instead.
        assert _SUMMARIZE_GUARD.startswith("STOP. Do not call any tools")

    def test_the_guard_says_it_is_not_part_of_the_users_request(self):
        assert "not part of the user's request" in _SUMMARIZE_GUARD
        assert "it is still in progress" in _SUMMARIZE_GUARD

    def test_the_instructions_ask_for_the_most_recent_request_verbatim(self):
        expected = "the user's most recent request, quoted verbatim, and progress toward it"
        assert expected in DEFAULT_SUMMARIZE_INSTRUCTIONS
        assert "outstanding requests" not in DEFAULT_SUMMARIZE_INSTRUCTIONS

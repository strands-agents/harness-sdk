"""Tests for agent continuation input."""

from collections.abc import AsyncGenerator
from typing import Any, cast
from unittest.mock import Mock

import pytest

from strands import Agent, tool
from strands.agent._continuation import _ContinuationInput, add_input
from strands.hooks import AfterInvocationEvent, BeforeModelCallEvent, MessageAddedEvent
from strands.types.content import Message, MessageMetadata, Messages
from strands.types.event_loop import StopReason, Usage
from strands.types.tools import ToolContext
from tests.fixtures.mocked_model_provider import MockedModelProvider


def _text_of(message: Message) -> str:
    return "".join(block["text"] for block in message["content"] if "text" in block)


def _text_model(*turns: str) -> MockedModelProvider:
    return MockedModelProvider([{"role": "assistant", "content": [{"text": text}]} for text in turns])


def _capture_requests(model: MockedModelProvider, monkeypatch: pytest.MonkeyPatch) -> Mock:
    stream = Mock(wraps=model.stream)
    monkeypatch.setattr(model, "stream", stream)
    return stream


@pytest.mark.asyncio
async def test_combines_multiple_follow_up_contributions_with_public_resume_input(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model = _text_model("initial", "final")
    stream = _capture_requests(model, monkeypatch)
    appended: list[str] = []
    abandoned = Mock(side_effect=RuntimeError("abandon callback failed"))
    agent = Agent(model=model, callback_handler=None)
    resumed = False

    async def record_appended(args: str) -> None:
        appended.append(args)
        raise RuntimeError("append callback failed")

    def add_follow_up(event: AfterInvocationEvent) -> None:
        nonlocal resumed
        if resumed:
            return
        resumed = True
        for args in ("first", "second"):
            add_input(
                event,
                _ContinuationInput(args=args, on_appended=lambda args=args: record_appended(args)),
            )
        add_input(
            event,
            _ContinuationInput(
                args=[{"role": "assistant", "content": [{"text": "invalid"}]}],
                on_abandoned=abandoned,
            ),
        )
        event.resume = "public"

    agent.hooks.add_callback(AfterInvocationEvent, add_follow_up)

    await agent.invoke_async("start")

    requests = [call.args[0] for call in stream.call_args_list]
    assert [message["role"] for message in requests[1]] == ["user", "assistant", "user"]
    assert _text_of(requests[1][-1]) == "firstsecondpublic"
    assert [_text_of(message) for message in agent.messages] == ["start", "initial", "firstsecondpublic", "final"]
    assert appended == ["first", "second"]
    abandoned.assert_called_once()
    assert str(abandoned.call_args.args[0]) == "Continuation input must contain a complete message sequence"


@pytest.mark.asyncio
async def test_retains_follow_up_input_through_failed_resume_attempts(monkeypatch: pytest.MonkeyPatch) -> None:
    model = MockedModelProvider(
        [
            {
                "role": "assistant",
                "content": [{"toolUse": {"name": "confirm_tool", "toolUseId": "tool-1", "input": {}}}],
            },
            {"role": "assistant", "content": [{"text": "resumed"}]},
            {"role": "assistant", "content": [{"text": "continued"}]},
        ]
    )
    stream = _capture_requests(model, monkeypatch)
    appended = Mock()
    abandoned = Mock()

    @tool(context=True)
    def confirm_tool(tool_context: ToolContext) -> str:
        """Require confirmation before completing."""
        response = tool_context.interrupt("confirm", reason="Confirm?")
        return f"confirmed:{response}"

    agent = Agent(model=model, tools=[confirm_tool], callback_handler=None)
    added = False

    def add_follow_up(event: AfterInvocationEvent) -> None:
        nonlocal added
        if added:
            return
        added = True
        add_input(
            event,
            _ContinuationInput(args="pending", on_appended=appended, on_abandoned=abandoned),
        )

    agent.hooks.add_callback(AfterInvocationEvent, add_follow_up)

    interrupt_result = await agent.invoke_async("start")

    assert interrupt_result.stop_reason == "interrupt"
    assert interrupt_result.interrupts
    appended.assert_not_called()
    abandoned.assert_not_called()

    with pytest.raises(TypeError, match="must resume from interrupt"):
        await agent.invoke_async("invalid resume")
    appended.assert_not_called()
    abandoned.assert_not_called()

    final_result = await agent.invoke_async(
        [
            {
                "interruptResponse": {
                    "interruptId": interrupt_result.interrupts[0].id,
                    "response": "yes",
                }
            }
        ]
    )

    assert final_result.stop_reason == "end_turn"
    requests = [call.args[0] for call in stream.call_args_list]
    assert _text_of(requests[2][-1]) == "pending"
    appended.assert_called_once_with()
    abandoned.assert_not_called()


@pytest.mark.asyncio
async def test_preserves_unrecognized_stop_reason_instead_of_continuing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stop_reason = "provider_specific_stop"
    model = _text_model("partial", "unreachable")
    original_map = model.map_agent_message_to_events

    def map_agent_message_to_events(
        agent_message: Message,
        usage: Usage | None = None,
    ) -> list[dict[str, Any]]:
        events = list(original_map(agent_message, usage))
        for event in events:
            if "messageStop" in event:
                event["messageStop"]["stopReason"] = cast(StopReason, stop_reason)
                break
        return events

    monkeypatch.setattr(model, "map_agent_message_to_events", map_agent_message_to_events)
    abandoned = Mock()
    agent = Agent(model=model, callback_handler=None)
    added = False

    def add_follow_up(event: AfterInvocationEvent) -> None:
        nonlocal added
        if added:
            return
        added = True
        add_input(event, _ContinuationInput(args="pending", on_abandoned=abandoned))

    agent.hooks.add_callback(AfterInvocationEvent, add_follow_up)

    result = await agent.invoke_async("start")

    assert result.stop_reason == stop_reason
    assert model.index == 1
    assert [_text_of(message) for message in agent.messages] == ["start", "partial"]
    abandoned.assert_called_once()


@pytest.mark.asyncio
async def test_appends_complete_tool_exchange_contributed_before_model_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model = _text_model("final")
    stream = _capture_requests(model, monkeypatch)
    metadata: MessageMetadata = {"custom": {"pinned": True}}
    initial_input: Message = {
        "role": "user",
        "content": [{"text": "start"}],
        "tracking_id": "durable-1",
        "metadata": metadata,
    }
    tool_use: Message = {
        "role": "assistant",
        "content": [{"toolUse": {"name": "background_result", "toolUseId": "delivery-1", "input": {}}}],
    }
    tool_result: Message = {
        "role": "user",
        "content": [
            {
                "toolResult": {
                    "toolUseId": "delivery-1",
                    "status": "success",
                    "content": [{"text": "complete"}],
                }
            }
        ],
    }
    appended = Mock()
    added_messages: Messages = []
    agent = Agent(model=model, callback_handler=None)

    agent.hooks.add_callback(MessageAddedEvent, lambda event: added_messages.append(event.message))

    def add_before_model_input(event: BeforeModelCallEvent) -> None:
        add_input(event, _ContinuationInput(args="guidance"))

        def on_appended() -> None:
            assert agent.messages == [agent.messages[0], tool_use, tool_result]
            appended()

        add_input(
            event,
            _ContinuationInput(args=[tool_use, tool_result], on_appended=on_appended),
        )

    agent.hooks.add_callback(BeforeModelCallEvent, add_before_model_input)

    await agent.invoke_async([initial_input])

    request = stream.call_args_list[0].args[0]
    assert [message["role"] for message in request] == ["user", "assistant", "user"]
    assert _text_of(request[0]) == "startguidance"
    assert agent.messages[0] == {
        "role": "user",
        "content": [{"text": "start"}, {"text": "guidance"}],
        "tracking_id": "durable-1",
        "metadata": metadata,
    }
    assert agent.messages[1:3] == [tool_use, tool_result]
    assert agent.messages[3]["role"] == "assistant"
    assert agent.messages[0] in added_messages
    appended.assert_called_once_with()


@pytest.mark.asyncio
async def test_abandons_follow_up_input_when_stream_closes_before_it_is_appended() -> None:
    abandoned = Mock()
    agent = Agent(model=_text_model("initial", "unreachable"), callback_handler=None)
    added = False

    def add_follow_up(event: AfterInvocationEvent) -> None:
        nonlocal added
        if added:
            return
        added = True
        add_input(event, _ContinuationInput(args="pending", on_abandoned=abandoned))

    agent.hooks.add_callback(AfterInvocationEvent, add_follow_up)

    stream = agent.stream_async("start")
    async for event in stream:
        if event.get("start"):
            await cast(AsyncGenerator[dict[str, Any], None], stream).aclose()
            break

    abandoned.assert_called_once()
    assert [_text_of(message) for message in agent.messages] == ["start"]

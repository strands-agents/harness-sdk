"""Tests for internal continuation input coordination."""

import asyncio
from unittest.mock import AsyncMock, Mock

import pytest

from strands import Agent
from strands.agent._continuation import (
    _ContinuationInput,
    _is_complete_message_input,
    abandon,
    add_input,
    prepare,
)
from strands.hooks import AfterInvocationEvent
from strands.types.content import Message, Messages

_USER_TEXT: Message = {"role": "user", "content": [{"text": "done"}]}
_ASSISTANT_TEXT: Message = {"role": "assistant", "content": [{"text": "invalid"}]}
_TOOL_USE: Message = {
    "role": "assistant",
    "content": [{"toolUse": {"name": "tool", "toolUseId": "tool-1", "input": {}}}],
}
_USER_TOOL_USE: Message = {
    "role": "user",
    "content": _TOOL_USE["content"],
}
_TOOL_RESULT: Message = {
    "role": "user",
    "content": [
        {
            "toolResult": {
                "toolUseId": "tool-1",
                "status": "success",
                "content": [{"text": "done"}],
            }
        }
    ],
}


@pytest.mark.asyncio
async def test_prepare_preserves_inputs_deferred_across_interrupts() -> None:
    agent = Mock(spec=Agent)
    first_event = AfterInvocationEvent(agent=agent)
    second_event = AfterInvocationEvent(agent=agent)
    abandoned = Mock()
    first_input = _ContinuationInput(args="first", on_abandoned=abandoned)
    second_input = _ContinuationInput(args="second", on_abandoned=abandoned)
    normalize_input = AsyncMock()

    add_input(first_event, first_input)
    add_input(second_event, second_input)
    await prepare(first_event, normalize_input, "interrupt")
    await prepare(second_event, normalize_input, "interrupt")

    assert agent._deferred_continuation_inputs == [first_input, second_input]
    normalize_input.assert_not_awaited()

    next_event = AfterInvocationEvent(agent=agent)
    with pytest.raises(asyncio.CancelledError):
        await prepare(next_event, AsyncMock(side_effect=asyncio.CancelledError()))
    await abandon(next_event, RuntimeError("cancelled"))

    assert abandoned.call_count == 2


@pytest.mark.parametrize(
    ("messages", "expected"),
    [
        ([_USER_TEXT], True),
        ([_TOOL_USE, _TOOL_RESULT, _USER_TEXT], True),
        ([_TOOL_USE, _ASSISTANT_TEXT, _USER_TEXT], False),
        ([_USER_TOOL_USE], False),
        ([_TOOL_RESULT], False),
        ([_TOOL_USE, _USER_TEXT], False),
    ],
)
def test_validates_complete_message_sequences(messages: Messages, expected: bool) -> None:
    assert _is_complete_message_input(messages) is expected

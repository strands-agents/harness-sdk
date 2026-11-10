import json
from unittest.mock import ANY

import pytest

from strands import Agent, tool
from strands.hooks import BeforeToolCallEvent, HookProvider
from strands.interrupt import Interrupt
from strands.types.tools import ToolContext


@pytest.fixture
def interrupt_hook():
    class Hook(HookProvider):
        def register_hooks(self, registry):
            registry.add_callback(BeforeToolCallEvent, self.interrupt)

        def interrupt(self, event):
            if event.tool_use["name"] != "time_tool":
                return

            response = event.interrupt("test_interrupt", reason="need approval")
            if response != "APPROVE":
                event.cancel_tool = "tool rejected"

    return Hook()


@pytest.fixture
def time_tool():
    @tool(name="time_tool", context=True)
    def func(tool_context: ToolContext) -> str:
        return tool_context.interrupt("test_interrupt", reason="need time")

    return func


@pytest.fixture
def day_tool():
    @tool(name="day_tool", context=True)
    def func(tool_context: ToolContext) -> str:
        return tool_context.interrupt("test_interrupt", reason="need day")

    return func


@pytest.fixture
def weather_tool():
    @tool(name="weather_tool")
    def func() -> str:
        return "sunny"

    return func


@pytest.fixture
def agent(interrupt_hook, time_tool, day_tool, weather_tool):
    return Agent(hooks=[interrupt_hook], tools=[time_tool, day_tool, weather_tool])


def test_interrupt(agent):
    result = agent("What is the time, day, and weather?")

    tru_stop_reason = result.stop_reason
    exp_stop_reason = "interrupt"
    assert tru_stop_reason == exp_stop_reason

    tru_interrupts = sorted(result.interrupts, key=lambda interrupt: interrupt.reason)
    exp_interrupts = [
        Interrupt(
            id=ANY,
            name="test_interrupt",
            reason="need approval",
        ),
        Interrupt(
            id=ANY,
            name="test_interrupt",
            reason="need day",
        ),
    ]
    assert tru_interrupts == exp_interrupts

    interrupt_approval, interrupt_day = result.interrupts

    responses = [
        {
            "interruptResponse": {
                "interruptId": interrupt_approval.id,
                "response": "APPROVE",
            },
        },
        {
            "interruptResponse": {
                "interruptId": interrupt_day.id,
                "response": "monday",
            },
        },
    ]
    result = agent(responses)

    tru_stop_reason = result.stop_reason
    exp_stop_reason = "interrupt"
    assert tru_stop_reason == exp_stop_reason

    tru_interrupts = result.interrupts
    exp_interrupts = [
        Interrupt(
            id=ANY,
            name="test_interrupt",
            reason="need time",
        ),
    ]
    assert tru_interrupts == exp_interrupts

    interrupt_time = result.interrupts[0]

    responses = [
        {
            "interruptResponse": {
                "interruptId": interrupt_time.id,
                "response": "12:01",
            },
        },
    ]
    result = agent(responses)

    result_message = json.dumps(result.message).lower()
    assert all(string in result_message for string in ["12:01", "monday", "sunny"])

    tru_tool_results = agent.messages[-2]["content"]
    tru_tool_results.sort(key=lambda content: content["toolResult"]["content"][0]["text"])

    exp_tool_results = [
        {
            "toolResult": {
                "toolUseId": ANY,
                "status": "success",
                "content": [
                    {"text": "12:01"},
                ],
            },
        },
        {
            "toolResult": {
                "toolUseId": ANY,
                "status": "success",
                "content": [
                    {"text": "monday"},
                ],
            },
        },
        {
            "toolResult": {
                "toolUseId": ANY,
                "status": "success",
                "content": [
                    {"text": "sunny"},
                ],
            },
        },
    ]
    assert tru_tool_results == exp_tool_results

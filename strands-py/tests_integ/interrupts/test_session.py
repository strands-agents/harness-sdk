import json

import pytest

from strands import Agent, tool
from strands.hooks import BeforeToolCallEvent, HookProvider
from strands.session import FileSessionManager


@pytest.fixture
def interrupt_hook():
    class Hook(HookProvider):
        def register_hooks(self, registry):
            registry.add_callback(BeforeToolCallEvent, self.interrupt)

        def interrupt(self, event):
            if event.tool_use["name"] == "weather_tool":
                return

            response = event.interrupt("test_interrupt", reason="need approval")
            if response != "APPROVE":
                event.cancel_tool = "tool rejected"

    return Hook()


@pytest.fixture
def time_tool():
    @tool(name="time_tool")
    def func():
        return "12:00"

    return func


@pytest.fixture
def weather_tool():
    @tool(name="weather_tool")
    def func():
        return "sunny"

    return func


@pytest.fixture
def agent(interrupt_hook, time_tool, weather_tool):
    return Agent(hooks=[interrupt_hook], tools=[time_tool, weather_tool])


def test_interrupt_session(interrupt_hook, time_tool, weather_tool, tmpdir):
    session_manager = FileSessionManager(session_id="strands-interrupt-test", storage_dir=tmpdir)
    agent = Agent(hooks=[interrupt_hook], session_manager=session_manager, tools=[time_tool, weather_tool])
    result = agent("What is the time and weather?")

    tru_stop_reason = result.stop_reason
    exp_stop_reason = "interrupt"
    assert tru_stop_reason == exp_stop_reason

    interrupt = result.interrupts[0]

    session_manager = FileSessionManager(session_id="strands-interrupt-test", storage_dir=tmpdir)
    agent = Agent(hooks=[interrupt_hook], session_manager=session_manager, tools=[time_tool, weather_tool])
    responses = [
        {
            "interruptResponse": {
                "interruptId": interrupt.id,
                "response": "APPROVE",
            },
        },
    ]
    result = agent(responses)

    tru_stop_reason = result.stop_reason
    exp_stop_reason = "end_turn"
    assert tru_stop_reason == exp_stop_reason

    result_message = json.dumps(result.message).lower()
    assert all(string in result_message for string in ["12:00", "sunny"])

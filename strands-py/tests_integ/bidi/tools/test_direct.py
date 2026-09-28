import unittest.mock

import pytest

from strands import tool
from strands.experimental.bidi.agent import BidiAgent
from strands.session import FileSessionManager


@pytest.fixture
def weather_tool():
    @tool(name="weather_tool")
    def func(city_name: str) -> str:
        return f"city_name=<{city_name}> | sunny"

    return func


@pytest.fixture
def agent(weather_tool):
    return BidiAgent(record_direct_tool_call=True, tools=[weather_tool])


def test_bidi_agent_tool_direct_call(agent):
    tru_result = agent.tool.weather_tool(city_name="new york")
    exp_result = {
        "content": [{"text": "city_name=<new york> | sunny"}],
        "status": "success",
        "toolUseId": unittest.mock.ANY,
    }
    assert tru_result == exp_result

    tru_messages = agent.messages
    exp_messages = [
        {
            "content": [
                {
                    "text": (
                        'agent.tool.weather_tool direct tool call.\nInput parameters: {"city_name": "new york"}\n'
                    ),
                },
            ],
            "role": "user",
            "tracking_id": unittest.mock.ANY,
        },
        {
            "content": [
                {
                    "toolUse": {
                        "input": {"city_name": "new york"},
                        "name": "weather_tool",
                        "toolUseId": unittest.mock.ANY,
                    },
                },
            ],
            "role": "assistant",
            "tracking_id": unittest.mock.ANY,
        },
        {
            "content": [
                {
                    "toolResult": {
                        "content": [{"text": "city_name=<new york> | sunny"}],
                        "status": "success",
                        "toolUseId": unittest.mock.ANY,
                    },
                },
            ],
            "role": "user",
            "tracking_id": unittest.mock.ANY,
        },
        {
            "content": [{"text": "agent.tool.weather_tool was called."}],
            "role": "assistant",
            "tracking_id": unittest.mock.ANY,
        },
    ]
    assert tru_messages == exp_messages


def test_bidi_agent_tool_direct_call_with_file_session(weather_tool, tmp_path):
    agent = BidiAgent(
        record_direct_tool_call=True,
        tools=[weather_tool],
        session_manager=FileSessionManager(session_id="bidi-session", storage_dir=tmp_path),
    )
    agent.state.set("city", "new york")
    agent.tool.weather_tool(city_name="new york")

    restored_manager = FileSessionManager(session_id="bidi-session", storage_dir=tmp_path)
    restored_agent = BidiAgent(record_direct_tool_call=True, tools=[weather_tool], session_manager=restored_manager)

    tru_state = restored_agent.state.get()
    exp_state = {"city": "new york"}
    assert tru_state == exp_state
    tru_messages = restored_agent.messages
    exp_messages = agent.messages
    assert tru_messages == exp_messages

    restored_agent.tool.weather_tool(city_name="seattle")

    tru_messages = [
        (message.message_id, message.to_message())
        for message in restored_manager.list_messages("bidi-session", restored_agent.agent_id)
    ]
    exp_messages = list(enumerate(restored_agent.messages))
    # Two calls, each recording a user prompt, tool use, tool result, and assistant acknowledgement.
    assert len(exp_messages) == 8
    assert tru_messages == exp_messages

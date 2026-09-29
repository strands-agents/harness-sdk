import unittest.mock

import pytest

from strands import tool
from strands.experimental.bidi.agent import BidiAgent


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

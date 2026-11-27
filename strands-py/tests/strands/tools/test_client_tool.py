import pytest
from pydantic import BaseModel

from strands import Agent
from strands.tools import CLIENT_TOOL_INTERRUPT_NAME, ClientTool
from tests.fixtures.mocked_model_provider import MockedModelProvider


class Location(BaseModel):
    """Where to look up."""

    city: str


def _tool_use_msg(tool_use_id: str, tool_input: dict) -> dict:
    return {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": tool_use_id, "name": "get_weather", "input": tool_input}}],
    }


def _agent(tool: ClientTool, tool_input: dict) -> Agent:
    model = MockedModelProvider([_tool_use_msg("t1", tool_input), {"role": "assistant", "content": [{"text": "done"}]}])
    return Agent(model=model, tools=[tool], callback_handler=None)


def _tool_result(agent: Agent) -> dict:
    return next(block["toolResult"] for msg in agent.messages for block in msg["content"] if "toolResult" in block)


def test_spec_from_json_schema():
    schema = {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
    tool = ClientTool(name="get_weather", description="Get weather.", input_schema=schema)

    assert tool.tool_name == "get_weather"
    assert tool.tool_type == "client"
    assert tool.tool_spec == {"name": "get_weather", "description": "Get weather.", "inputSchema": {"json": schema}}


def test_spec_from_pydantic_model():
    tool = ClientTool(name="get_weather", description="Get weather.", input_schema=Location)

    schema = tool.tool_spec["inputSchema"]["json"]
    assert tool.tool_spec["name"] == "get_weather"
    assert tool.tool_spec["description"] == "Get weather."
    assert schema["properties"]["city"]["type"] == "string"
    assert schema["required"] == ["city"]


def test_spec_defaults_to_empty_object_schema():
    tool = ClientTool(name="get_weather", description="Get weather.")

    assert tool.tool_spec["inputSchema"] == {"json": {"type": "object", "properties": {}}}


def test_interrupts_with_tool_call_and_returns_response_as_result():
    agent = _agent(ClientTool(name="get_weather", description="Get weather."), {"city": "Seattle"})

    result = agent("weather?")

    assert result.stop_reason == "interrupt"
    interrupt = result.interrupts[0]
    assert interrupt.name == CLIENT_TOOL_INTERRUPT_NAME
    assert interrupt.reason == {"name": "get_weather", "input": {"city": "Seattle"}}

    resumed = agent([{"interruptResponse": {"interruptId": interrupt.id, "response": {"temp_f": 61}}}])

    assert resumed.stop_reason == "end_turn"
    assert _tool_result(agent) == {"toolUseId": "t1", "status": "success", "content": [{"text": '{"temp_f": 61}'}]}


def test_string_response_becomes_text_result():
    agent = _agent(ClientTool(name="get_weather", description="Get weather."), {})
    interrupt = agent("weather?").interrupts[0]

    agent([{"interruptResponse": {"interruptId": interrupt.id, "response": "sunny"}}])

    assert _tool_result(agent)["content"] == [{"text": "sunny"}]


def test_tool_result_response_passes_through():
    agent = _agent(ClientTool(name="get_weather", description="Get weather."), {})
    interrupt = agent("weather?").interrupts[0]
    response = {"status": "error", "content": [{"text": "location permission denied"}]}

    agent([{"interruptResponse": {"interruptId": interrupt.id, "response": response}}])

    assert _tool_result(agent) == {"toolUseId": "t1", **response}


@pytest.mark.parametrize("tool_input", [{}, {"city": 3}])
def test_invalid_input_returns_error_without_interrupting(tool_input):
    agent = _agent(ClientTool(name="get_weather", description="Get weather.", input_schema=Location), tool_input)

    result = agent("weather?")

    assert result.stop_reason == "end_turn"
    assert not result.interrupts
    tool_result = _tool_result(agent)
    assert tool_result["status"] == "error"
    assert "city" in tool_result["content"][0]["text"]


def test_valid_input_interrupts_with_pydantic_schema():
    agent = _agent(ClientTool(name="get_weather", description="Get weather.", input_schema=Location), {"city": "Oslo"})

    result = agent("weather?")

    assert result.stop_reason == "interrupt"
    assert result.interrupts[0].reason == {"name": "get_weather", "input": {"city": "Oslo"}}


def test_parallel_calls_interrupt_together():
    tool = ClientTool(name="get_weather", description="Get weather.")
    model = MockedModelProvider(
        [
            {
                "role": "assistant",
                "content": [
                    {"toolUse": {"toolUseId": "a", "name": "get_weather", "input": {"city": "Oslo"}}},
                    {"toolUse": {"toolUseId": "b", "name": "get_weather", "input": {"city": "Rome"}}},
                ],
            },
            {"role": "assistant", "content": [{"text": "done"}]},
        ]
    )
    agent = Agent(model=model, tools=[tool], callback_handler=None)

    result = agent("weather?")

    assert sorted(i.reason["input"]["city"] for i in result.interrupts) == ["Oslo", "Rome"]
    responses = [
        {"interruptResponse": {"interruptId": i.id, "response": i.reason["input"]["city"]}} for i in result.interrupts
    ]
    assert agent(responses).stop_reason == "end_turn"
    results = {
        b["toolResult"]["toolUseId"]: b["toolResult"] for m in agent.messages for b in m["content"] if "toolResult" in b
    }
    assert results["a"]["content"] == [{"text": "Oslo"}]
    assert results["b"]["content"] == [{"text": "Rome"}]

import datetime
import unittest.mock

import pytest
from pydantic import BaseModel

from strands import Agent
from strands.hooks import BeforeToolCallEvent
from strands.middleware.stages import ExecuteToolStage
from strands.tools import CLIENT_TOOL_INTERRUPT_NAME, ClientTool
from strands.types._events import ToolResultEvent
from tests.fixtures.mocked_model_provider import MockedModelProvider


class Forecast(BaseModel):
    """Forecast request."""

    city: str
    days: int = 3


@pytest.fixture
def tool():
    return ClientTool(name="get_weather", description="Get weather.")


def _agent(tool: ClientTool, *tool_uses: tuple[str, dict]) -> Agent:
    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": i, "name": "get_weather", "input": inp}} for i, inp in tool_uses],
    }
    model = MockedModelProvider([tool_use_msg, {"role": "assistant", "content": [{"text": "done"}]}])
    return Agent(model=model, tools=[tool], callback_handler=None)


def _respond(agent: Agent, response):
    interrupt = agent("weather?").interrupts[0]
    return agent([{"interruptResponse": {"interruptId": interrupt.id, "response": response}}])


def _tool_results(agent: Agent) -> list[dict]:
    return [block["toolResult"] for msg in agent.messages for block in msg["content"] if "toolResult" in block]


def test_tool_spec_json_schema():
    schema = {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}

    tru_spec = ClientTool(name="get_weather", description="Get weather.", input_schema=schema).tool_spec
    exp_spec = {"name": "get_weather", "description": "Get weather.", "inputSchema": {"json": schema}}

    assert tru_spec == exp_spec


def test_tool_spec_unwraps_json_key():
    schema = {"type": "object", "properties": {}}

    tru_schema = ClientTool(name="t", description="d", input_schema={"json": schema}).tool_spec["inputSchema"]
    exp_schema = {"json": schema}

    assert tru_schema == exp_schema


def test_tool_spec_pydantic_model():
    tru_schema = ClientTool(name="get_weather", description="d", input_schema=Forecast).tool_spec["inputSchema"]
    exp_schema = {
        "json": {
            "description": "Forecast request.",
            "properties": {"city": {"type": "string"}, "days": {"default": 3, "type": "integer"}},
            "required": ["city"],
            "type": "object",
        }
    }

    assert tru_schema == exp_schema


def test_tool_spec_default_schema(tool):
    tru_schema = tool.tool_spec["inputSchema"]
    exp_schema = {"json": {"type": "object", "properties": {}, "additionalProperties": False}}

    assert tru_schema == exp_schema
    assert tool.tool_name == "get_weather"
    assert tool.tool_type == "client"


@pytest.mark.parametrize("input_schema", ["schema", 42, dict])
def test__init__invalid_input_schema(input_schema):
    with pytest.raises(TypeError, match="input_schema must be"):
        ClientTool(name="t", description="d", input_schema=input_schema)


def test_stream_interrupts_then_returns_response(tool):
    agent = _agent(tool, ("t1", {"city": "Seattle"}))

    result = agent("weather?")

    assert result.stop_reason == "interrupt"
    tru_interrupt = (result.interrupts[0].name, result.interrupts[0].reason)
    exp_interrupt = (
        CLIENT_TOOL_INTERRUPT_NAME,
        {"toolUseId": "t1", "name": "get_weather", "input": {"city": "Seattle"}},
    )
    assert tru_interrupt == exp_interrupt

    resumed = agent([{"interruptResponse": {"interruptId": result.interrupts[0].id, "response": {"temp_f": 61}}}])

    assert resumed.stop_reason == "end_turn"
    tru_results = _tool_results(agent)
    exp_results = [{"toolUseId": "t1", "status": "success", "content": [{"text": '{"temp_f": 61}'}]}]
    assert tru_results == exp_results


@pytest.mark.parametrize(
    ("response", "exp_content"),
    [
        ("sunny", [{"text": "sunny"}]),
        (Forecast(city="Oslo"), [{"text": '{"city":"Oslo","days":3}'}]),
        ({"status": 200, "content": "<html>"}, [{"text": '{"status": 200, "content": "<html>"}'}]),
        ({"status": "success", "content": [{"id": 1}]}, [{"text": '{"status": "success", "content": [{"id": 1}]}'}]),
        ({"status": "success", "content": []}, [{"text": '{"status": "success", "content": []}'}]),
        ({1, 2}, [{"text": "{1, 2}"}]),
    ],
)
def test_stream_wraps_non_tool_result_response(tool, response, exp_content):
    agent = _agent(tool, ("t1", {}))

    _respond(agent, response)

    tru_result = _tool_results(agent)[0]
    exp_result = {"toolUseId": "t1", "status": "success", "content": exp_content}
    assert tru_result == exp_result


def test_stream_passes_tool_result_response_through(tool):
    agent = _agent(tool, ("t1", {}))
    response = {"status": "error", "content": [{"text": "permission denied"}], "extra": 1}

    _respond(agent, response)

    tru_result = _tool_results(agent)[0]
    exp_result = {"toolUseId": "t1", "status": "error", "content": [{"text": "permission denied"}]}
    assert tru_result == exp_result


def test_stream_wraps_date_response(tool):
    # Not JSON-serializable: falls back to str() instead of failing the tool call.
    agent = _agent(tool, ("t1", {}))

    _respond(agent, datetime.date(2030, 1, 2))

    assert _tool_results(agent)[0]["content"] == [{"text": "2030-01-02"}]


@pytest.mark.parametrize("tool_input", [{}, {"city": 3}, {"city": "Oslo", "days": "many"}])
def test_stream_invalid_input_returns_error_without_interrupting(tool_input):
    agent = _agent(ClientTool(name="get_weather", description="d", input_schema=Forecast), ("t1", tool_input))

    result = agent("weather?")

    assert result.stop_reason == "end_turn"
    assert not result.interrupts
    tru_result = _tool_results(agent)[0]
    exp_result = {"toolUseId": "t1", "status": "error", "content": [{"text": unittest.mock.ANY}]}
    assert tru_result == exp_result


def test_stream_forwards_validated_input():
    agent = _agent(ClientTool(name="get_weather", description="d", input_schema=Forecast), ("t1", {"city": "Oslo"}))

    tru_reason = agent("weather?").interrupts[0].reason
    exp_reason = {"toolUseId": "t1", "name": "get_weather", "input": {"city": "Oslo", "days": 3}}

    assert tru_reason == exp_reason


def test_stream_parallel_calls_interrupt_together(tool):
    agent = _agent(tool, ("a", {"city": "Oslo"}), ("b", {"city": "Rome"}))

    result = agent("weather?")

    assert sorted(i.reason["toolUseId"] for i in result.interrupts) == ["a", "b"]
    responses = [
        {"interruptResponse": {"interruptId": i.id, "response": i.reason["input"]["city"]}} for i in result.interrupts
    ]
    assert agent(responses).stop_reason == "end_turn"
    tru_results = sorted(_tool_results(agent), key=lambda r: r["toolUseId"])
    exp_results = [
        {"toolUseId": "a", "status": "success", "content": [{"text": "Oslo"}]},
        {"toolUseId": "b", "status": "success", "content": [{"text": "Rome"}]},
    ]
    assert tru_results == exp_results


def test_stream_interrupt_survives_error_handling_middleware(tool):
    agent = _agent(tool, ("t1", {}))

    async def error_middleware(context, next_fn):
        try:
            async for event in next_fn(context):
                yield event
        except Exception as e:
            result = {"toolUseId": context.tool_use["toolUseId"], "status": "error", "content": [{"text": str(e)}]}
            yield ToolResultEvent(result)

    agent.add_middleware(ExecuteToolStage, error_middleware)

    assert agent("weather?").stop_reason == "interrupt"


def test_stream_after_approval_interrupt(tool):
    agent = _agent(tool, ("t1", {}))

    def approve(event: BeforeToolCallEvent):
        if event.interrupt("approve", reason="run get_weather?") != "yes":
            event.cancel_tool = "denied"

    agent.hooks.add_callback(BeforeToolCallEvent, approve)

    approval = agent("weather?").interrupts[0]
    client_call = agent([{"interruptResponse": {"interruptId": approval.id, "response": "yes"}}]).interrupts[0]
    resumed = agent([{"interruptResponse": {"interruptId": client_call.id, "response": "sunny"}}])

    assert (approval.name, client_call.name) == ("approve", CLIENT_TOOL_INTERRUPT_NAME)
    assert resumed.stop_reason == "end_turn"
    assert _tool_results(agent)[0]["content"] == [{"text": "sunny"}]

import json
from unittest.mock import ANY

import pytest

from strands import Agent, tool
from strands.interrupt import Interrupt
from strands.multiagent import GraphBuilder, Swarm
from strands.multiagent.base import Status
from strands.types.tools import ToolContext


@pytest.fixture
def day_tool():
    @tool(name="day_tool", context=True)
    def func(tool_context: ToolContext) -> str:
        response = tool_context.interrupt("day_interrupt", reason="need day")
        return response

    return func


@pytest.fixture
def time_tool():
    @tool(name="time_tool")
    def func():
        return "12:01"

    return func


@pytest.fixture
def weather_tool():
    @tool(name="weather_tool", context=True)
    def func(tool_context: ToolContext) -> str:
        response = tool_context.interrupt("weather_interrupt", reason="need weather")
        return response

    return func


@pytest.fixture
def info_agent():
    return Agent(name="info")


@pytest.fixture
def day_agent(day_tool):
    return Agent(name="day", tools=[day_tool])


@pytest.fixture
def time_agent(time_tool):
    return Agent(name="time", tools=[time_tool])


@pytest.fixture
def weather_agent(weather_tool):
    return Agent(name="weather", tools=[weather_tool])


@pytest.fixture
def swarm(weather_agent):
    return Swarm([weather_agent])


@pytest.fixture
def graph(info_agent, day_agent, time_agent, swarm):
    builder = GraphBuilder()

    builder.add_node(info_agent, "info")
    builder.add_node(day_agent, "day")
    builder.add_node(time_agent, "time")
    builder.add_node(swarm, "weather")

    builder.add_edge("info", "day")
    builder.add_edge("info", "time")
    builder.add_edge("info", "weather")

    builder.set_entry_point("info")

    return builder.build()


def test_swarm_interrupt_node(swarm):
    multiagent_result = swarm("What is the weather?")

    tru_status = multiagent_result.status
    exp_status = Status.INTERRUPTED
    assert tru_status == exp_status

    tru_interrupts = multiagent_result.interrupts
    exp_interrupts = [
        Interrupt(
            id=ANY,
            name="weather_interrupt",
            reason="need weather",
        ),
    ]
    assert tru_interrupts == exp_interrupts

    interrupt = multiagent_result.interrupts[0]

    responses = [
        {
            "interruptResponse": {
                "interruptId": interrupt.id,
                "response": "sunny",
            },
        },
    ]
    multiagent_result = swarm(responses)

    tru_status = multiagent_result.status
    exp_status = Status.COMPLETED
    assert tru_status == exp_status

    assert len(multiagent_result.results) == 1
    weather_result = multiagent_result.results["weather"]

    weather_message = json.dumps(weather_result.result.message).lower()
    assert "sunny" in weather_message


def test_graph_interrupt_node(graph):
    multiagent_result = graph("What is the day, time, and weather?")

    tru_result_status = multiagent_result.status
    exp_result_status = Status.INTERRUPTED
    assert tru_result_status == exp_result_status

    tru_state_status = graph.state.status
    exp_state_status = Status.INTERRUPTED
    assert tru_state_status == exp_state_status

    tru_node_ids = sorted([node.node_id for node in graph.state.interrupted_nodes])
    exp_node_ids = ["day", "weather"]
    assert tru_node_ids == exp_node_ids

    tru_interrupts = sorted(multiagent_result.interrupts, key=lambda interrupt: interrupt.name)
    exp_interrupts = [
        Interrupt(
            id=ANY,
            name="day_interrupt",
            reason="need day",
        ),
        Interrupt(
            id=ANY,
            name="weather_interrupt",
            reason="need weather",
        ),
    ]
    assert tru_interrupts == exp_interrupts

    responses = [
        {
            "interruptResponse": {
                "interruptId": tru_interrupts[0].id,
                "response": "monday",
            },
        },
        {
            "interruptResponse": {
                "interruptId": tru_interrupts[1].id,
                "response": "sunny",
            },
        },
    ]
    multiagent_result = graph(responses)

    tru_result_status = multiagent_result.status
    exp_result_status = Status.COMPLETED
    assert tru_result_status == exp_result_status

    tru_state_status = graph.state.status
    exp_state_status = Status.COMPLETED
    assert tru_state_status == exp_state_status

    assert len(multiagent_result.results) == 4

    day_message = json.dumps(multiagent_result.results["day"].result.message).lower()
    time_message = json.dumps(multiagent_result.results["time"].result.message).lower()
    assert "monday" in day_message
    assert "12:01" in time_message

    nested_multiagent_result = multiagent_result.results["weather"].result
    weather_message = json.dumps(nested_multiagent_result.results["weather"].result.message).lower()
    assert "sunny" in weather_message

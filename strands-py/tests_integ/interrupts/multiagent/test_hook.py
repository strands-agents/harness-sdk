import json
from unittest.mock import ANY

import pytest

from strands import Agent, tool
from strands.hooks import BeforeNodeCallEvent, HookProvider
from strands.interrupt import Interrupt
from strands.multiagent import GraphBuilder, Swarm
from strands.multiagent.base import Status


@pytest.fixture
def interrupt_hook():
    class Hook(HookProvider):
        def register_hooks(self, registry):
            registry.add_callback(BeforeNodeCallEvent, self.interrupt)

        def interrupt(self, event):
            if event.node_id == "info" or event.node_id == "time":
                return

            response = event.interrupt(f"{event.node_id}_interrupt", reason="need approval")
            if response != "APPROVE":
                event.cancel_node = "node rejected"

    return Hook()


@pytest.fixture
def day_tool():
    @tool(name="day_tool")
    def func():
        return "monday"

    return func


@pytest.fixture
def time_tool():
    @tool(name="time_tool")
    def func():
        return "12:01"

    return func


@pytest.fixture
def weather_tool():
    @tool(name="weather_tool")
    def func():
        return "sunny"

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
def swarm(interrupt_hook, info_agent, weather_agent):
    return Swarm([info_agent, weather_agent], hooks=[interrupt_hook])


@pytest.fixture
def graph(interrupt_hook, info_agent, day_agent, time_agent, weather_agent):
    builder = GraphBuilder()

    builder.add_node(info_agent, "info")
    builder.add_node(day_agent, "day")
    builder.add_node(time_agent, "time")
    builder.add_node(weather_agent, "weather")

    builder.add_edge("info", "day")
    builder.add_edge("info", "time")
    builder.add_edge("info", "weather")

    builder.set_entry_point("info")
    builder.set_hook_providers([interrupt_hook])

    return builder.build()


def test_swarm_interrupt(swarm):
    multiagent_result = swarm("What is the weather?")

    tru_status = multiagent_result.status
    exp_status = Status.INTERRUPTED
    assert tru_status == exp_status

    tru_interrupts = multiagent_result.interrupts
    exp_interrupts = [
        Interrupt(
            id=ANY,
            name="weather_interrupt",
            reason="need approval",
        ),
    ]
    assert tru_interrupts == exp_interrupts

    interrupt = multiagent_result.interrupts[0]

    responses = [
        {
            "interruptResponse": {
                "interruptId": interrupt.id,
                "response": "APPROVE",
            },
        },
    ]
    multiagent_result = swarm(responses)

    tru_status = multiagent_result.status
    exp_status = Status.COMPLETED
    assert tru_status == exp_status

    assert len(multiagent_result.results) == 2
    weather_result = multiagent_result.results["weather"]

    weather_message = json.dumps(weather_result.result.message).lower()
    assert "sunny" in weather_message


@pytest.mark.asyncio
async def test_swarm_interrupt_reject(swarm):
    multiagent_result = swarm("What is the weather?")

    tru_status = multiagent_result.status
    exp_status = Status.INTERRUPTED
    assert tru_status == exp_status

    tru_interrupts = multiagent_result.interrupts
    exp_interrupts = [
        Interrupt(
            id=ANY,
            name="weather_interrupt",
            reason="need approval",
        ),
    ]
    assert tru_interrupts == exp_interrupts

    interrupt = multiagent_result.interrupts[0]

    responses = [
        {
            "interruptResponse": {
                "interruptId": interrupt.id,
                "response": "REJECT",
            },
        },
    ]
    tru_cancel_id = None
    async for event in swarm.stream_async(responses):
        if event.get("type") == "multiagent_node_cancel":
            tru_cancel_id = event["node_id"]

    multiagent_result = event["result"]

    exp_cancel_id = "weather"
    assert tru_cancel_id == exp_cancel_id

    tru_status = multiagent_result.status
    exp_status = Status.FAILED
    assert tru_status == exp_status

    assert len(multiagent_result.node_history) == 1
    tru_node_id = multiagent_result.node_history[0].node_id
    exp_node_id = "info"
    assert tru_node_id == exp_node_id


def test_graph_interrupt(graph):
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
            reason="need approval",
        ),
        Interrupt(
            id=ANY,
            name="weather_interrupt",
            reason="need approval",
        ),
    ]
    assert tru_interrupts == exp_interrupts

    responses = [
        {
            "interruptResponse": {
                "interruptId": interrupt.id,
                "response": "APPROVE",
            },
        }
        for interrupt in multiagent_result.interrupts
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
    weather_message = json.dumps(multiagent_result.results["weather"].result.message).lower()
    assert "monday" in day_message
    assert "12:01" in time_message
    assert "sunny" in weather_message


@pytest.mark.asyncio
async def test_graph_interrupt_reject(graph):
    multiagent_result = graph("What is the day, time, and weather?")

    tru_result_status = multiagent_result.status
    exp_result_status = Status.INTERRUPTED
    assert tru_result_status == exp_result_status

    tru_state_status = graph.state.status
    exp_state_status = Status.INTERRUPTED
    assert tru_state_status == exp_state_status

    tru_interrupts = sorted(multiagent_result.interrupts, key=lambda interrupt: interrupt.name)
    exp_interrupts = [
        Interrupt(
            id=ANY,
            name="day_interrupt",
            reason="need approval",
        ),
        Interrupt(
            id=ANY,
            name="weather_interrupt",
            reason="need approval",
        ),
    ]
    assert tru_interrupts == exp_interrupts

    responses = [
        {
            "interruptResponse": {
                "interruptId": tru_interrupts[0].id,
                "response": "APPROVE",
            },
        },
        {
            "interruptResponse": {
                "interruptId": tru_interrupts[1].id,
                "response": "REJECT",
            },
        },
    ]

    try:
        async for event in graph.stream_async(responses):
            if event.get("type") == "multiagent_node_cancel":
                tru_cancel_id = event["node_id"]

    except RuntimeError as e:
        assert "node rejected" in str(e)

    exp_cancel_id = "weather"
    assert tru_cancel_id == exp_cancel_id

    tru_state_status = graph.state.status
    exp_state_status = Status.FAILED
    assert tru_state_status == exp_state_status

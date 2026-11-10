import asyncio
import json

import pytest

import strands
from strands import Agent
from strands.tools.executors import ConcurrentToolExecutor


@pytest.fixture
def tool_executor():
    return ConcurrentToolExecutor()


@pytest.fixture
def tool_events():
    return []


@pytest.fixture
def time_tool(tool_events):
    @strands.tool(name="time_tool")
    async def func():
        tool_events.append({"name": "time_tool", "event": "start"})
        await asyncio.sleep(2)
        tool_events.append({"name": "time_tool", "event": "end"})
        return "12:00"

    return func


@pytest.fixture
def weather_tool(tool_events):
    @strands.tool(name="weather_tool")
    async def func():
        tool_events.append({"name": "weather_tool", "event": "start"})
        await asyncio.sleep(1)
        tool_events.append({"name": "weather_tool", "event": "end"})

        return "sunny"

    return func


@pytest.fixture
def agent(tool_executor, time_tool, weather_tool):
    return Agent(tools=[time_tool, weather_tool], tool_executor=tool_executor)


@pytest.mark.asyncio
async def test_agent_invoke_async_tool_executor(agent, tool_events):
    await agent.invoke_async("What is the time and weather in New York?")

    tru_events = tool_events
    exp_events = [
        {"name": "time_tool", "event": "start"},
        {"name": "weather_tool", "event": "start"},
        {"name": "weather_tool", "event": "end"},
        {"name": "time_tool", "event": "end"},
    ]
    assert tru_events == exp_events


@pytest.mark.asyncio
async def test_agent_stream_async_tool_executor_cancelled(cancel_hook, tool_executor, time_tool, tool_events):
    agent = Agent(tools=[time_tool], tool_executor=tool_executor, hooks=[cancel_hook])

    exp_message = "cancelled tool call"
    tru_message = ""
    async for event in agent.stream_async("What is the time in New York?"):
        if "tool_cancel_event" in event:
            tru_message = event["tool_cancel_event"]["message"]

    assert tru_message == exp_message
    assert len(tool_events) == 0
    assert exp_message in json.dumps(agent.messages)

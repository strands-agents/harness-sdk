import os

import pytest
from pydantic import BaseModel

import strands
from strands import Agent
from strands.models.writer import WriterModel
from tests_integ.models import providers

# these tests only run if we have the writer api key
pytestmark = providers.writer.mark


@pytest.fixture
def model():
    return WriterModel(
        model_id="palmyra-x4",
        client_args={"api_key": os.getenv("WRITER_API_KEY", "")},
        stream_options={"include_usage": True},
    )


@pytest.fixture
def system_prompt():
    return "You are a smart assistant, that uses @ instead of all punctuation marks"


@pytest.fixture
def tools():
    @strands.tool
    def tool_time() -> str:
        return "12:00"

    @strands.tool
    def tool_weather() -> str:
        return "sunny"

    return [tool_time, tool_weather]


@pytest.fixture
def agent(model, tools, system_prompt):
    return Agent(model=model, tools=tools, system_prompt=system_prompt, load_tools_from_directory=False)


def test_agent(agent):
    result = agent("What is the time and weather in New York?")
    text = result.message["content"][0]["text"].lower()

    assert all(string in text for string in ["12:00", "sunny"])


@pytest.mark.asyncio
async def test_agent_async(agent):
    result = await agent.invoke_async("What is the time and weather in New York?")
    text = result.message["content"][0]["text"].lower()

    assert all(string in text for string in ["12:00", "sunny"])


@pytest.mark.asyncio
async def test_agent_stream_async(agent):
    stream = agent.stream_async("What is the time and weather in New York?")
    async for event in stream:
        _ = event

    result = event["result"]
    text = result.message["content"][0]["text"].lower()

    assert all(string in text for string in ["12:00", "sunny"])


def test_structured_output(agent):
    class Weather(BaseModel):
        time: str
        weather: str

    result = agent.structured_output(Weather, "The time is 12:00 and the weather is sunny")

    assert isinstance(result, Weather)
    assert result.time == "12:00"
    assert result.weather == "sunny"


@pytest.mark.asyncio
async def test_structured_output_async(agent):
    class Weather(BaseModel):
        time: str
        weather: str

    result = await agent.structured_output_async(Weather, "The time is 12:00 and the weather is sunny")

    assert isinstance(result, Weather)
    assert result.time == "12:00"
    assert result.weather == "sunny"

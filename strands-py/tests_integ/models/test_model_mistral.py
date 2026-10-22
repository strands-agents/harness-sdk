import os

import pytest
from pydantic import BaseModel

import strands
from strands import Agent
from strands.models.mistral import MistralModel
from tests_integ.models import providers

# these tests only run if we have the mistral api key
pytestmark = providers.mistral.mark


@pytest.fixture()
def streaming_model():
    return MistralModel(
        model_id="mistral-medium-latest",
        api_key=os.getenv("MISTRAL_API_KEY"),
        stream=True,
        temperature=0.7,
        max_tokens=1000,
        top_p=0.9,
    )


@pytest.fixture()
def non_streaming_model():
    return MistralModel(
        model_id="mistral-medium-latest",
        api_key=os.getenv("MISTRAL_API_KEY"),
        stream=False,
        temperature=0.7,
        max_tokens=1000,
        top_p=0.9,
    )


@pytest.fixture()
def system_prompt():
    return "You are an AI assistant that provides helpful and accurate information."


@pytest.fixture()
def tools():
    @strands.tool
    def tool_time() -> str:
        return "12:00"

    @strands.tool
    def tool_weather() -> str:
        return "sunny"

    return [tool_time, tool_weather]


@pytest.fixture()
def streaming_agent(streaming_model, tools):
    return Agent(model=streaming_model, tools=tools)


@pytest.fixture()
def non_streaming_agent(non_streaming_model, tools):
    return Agent(model=non_streaming_model, tools=tools)


@pytest.fixture(params=["streaming_agent", "non_streaming_agent"])
def agent(request):
    return request.getfixturevalue(request.param)


@pytest.fixture()
def weather():
    class Weather(BaseModel):
        """Extracts the time and weather from the user's message with the exact strings."""

        time: str
        weather: str

    return Weather(time="12:00", weather="sunny")


def test_agent_invoke(agent):
    result = agent("What is the time and weather in New York?")
    text = result.message["content"][0]["text"].lower()

    assert all(string in text for string in ["12:00", "sunny"])


@pytest.mark.asyncio
async def test_agent_invoke_async(agent):
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

    assert result.metrics.accumulated_usage is not None
    assert result.metrics.accumulated_usage["inputTokens"] > 0
    assert result.metrics.accumulated_usage["outputTokens"] > 0
    assert result.metrics.accumulated_usage["totalTokens"] > 0


def test_agent_structured_output(non_streaming_agent, weather):
    tru_weather = non_streaming_agent.structured_output(type(weather), "The time is 12:00 and the weather is sunny")
    exp_weather = weather
    assert tru_weather == exp_weather


@pytest.mark.asyncio
async def test_agent_structured_output_async(non_streaming_agent, weather):
    tru_weather = await non_streaming_agent.structured_output_async(
        type(weather), "The time is 12:00 and the weather is sunny"
    )
    exp_weather = weather
    assert tru_weather == exp_weather


class TestMistralMedium35:
    """Smoke coverage for mistral-medium-3-5: the context window resolves and a tool-using turn completes."""

    @pytest.fixture()
    def model(self):
        return MistralModel(
            model_id="mistral-medium-3-5",
            api_key=os.getenv("MISTRAL_API_KEY"),
            stream=True,
            temperature=0.7,
            max_tokens=1000,
            top_p=0.9,
        )

    def test_context_window_limit_resolves(self, model):
        assert model.get_config()["context_window_limit"] == 262_144

    def test_tool_use_turn(self, model, tools, system_prompt):
        agent = Agent(model=model, tools=tools, system_prompt=system_prompt)

        result = agent("What is the time and weather in New York?")

        text = result.message["content"][0]["text"].lower()
        assert all(string in text for string in ["12:00", "sunny"])


class TestMistralLarge4:
    """Smoke coverage for mistral-large-4-0: the context window resolves; the tool-using turn is blocked on #5032."""

    @pytest.fixture()
    def model(self):
        return MistralModel(
            model_id="mistral-large-4-0",
            api_key=os.getenv("MISTRAL_API_KEY"),
            stream=True,
            temperature=0.7,
            max_tokens=1000,
            top_p=0.9,
        )

    def test_context_window_limit_resolves(self, model):
        assert model.get_config()["context_window_limit"] == 1_048_576

    @pytest.mark.xfail(
        strict=True,
        raises=TypeError,
        reason="Large 4 returns list content (ThinkChunk/TextChunk) that MistralModel passes through as text: #5032",
    )
    def test_tool_use_turn(self, model, tools, system_prompt):
        agent = Agent(model=model, tools=tools, system_prompt=system_prompt)

        result = agent("What is the time and weather in New York?")

        text = result.message["content"][0]["text"].lower()
        assert all(string in text for string in ["12:00", "sunny"])


class TestMinistral3:
    """Smoke coverage for ministral-14b-2512: the context window resolves and a tool-using turn completes."""

    @pytest.fixture()
    def model(self):
        return MistralModel(
            model_id="ministral-14b-2512",
            api_key=os.getenv("MISTRAL_API_KEY"),
            stream=True,
            temperature=0.7,
            max_tokens=1000,
        )

    def test_context_window_limit_resolves(self, model):
        assert model.get_config()["context_window_limit"] == 262_144

    def test_tool_use_turn(self, model, tools, system_prompt):
        agent = Agent(model=model, tools=tools, system_prompt=system_prompt)

        result = agent("What is the time and weather in New York?")

        text = result.message["content"][0]["text"].lower()
        assert all(string in text for string in ["12:00", "sunny"])


class TestMistralSmall4:
    """Smoke coverage for mistral-small-2603: the context window resolves and a tool-using turn completes."""

    @pytest.fixture()
    def model(self):
        return MistralModel(
            model_id="mistral-small-2603",
            api_key=os.getenv("MISTRAL_API_KEY"),
            temperature=0.3,
        )

    def test_context_window_limit_resolves(self, model):
        assert model.get_config()["context_window_limit"] == 262_144

    def test_tool_use_turn(self, model, tools, system_prompt):
        agent = Agent(model=model, tools=tools, system_prompt=system_prompt)

        result = agent("What is the time and weather in New York?")

        text = str(result).lower()
        assert "12:00" in text
        assert "sunny" in text


class TestCodestral:
    """Smoke coverage for codestral-2508: the context window resolves and a tool-using turn completes."""

    @pytest.fixture()
    def model(self):
        return MistralModel(
            model_id="codestral-2508",
            api_key=os.getenv("MISTRAL_API_KEY"),
            stream=True,
            temperature=0.7,
            max_tokens=1000,
            top_p=0.9,
        )

    def test_context_window_limit_resolves(self, model):
        assert model.get_config()["context_window_limit"] == 256_000

    def test_tool_use_turn(self, model, tools, system_prompt):
        agent = Agent(model=model, tools=tools, system_prompt=system_prompt)

        result = agent("What is the time and weather in New York?")

        text = result.message["content"][0]["text"].lower()
        assert all(string in text for string in ["12:00", "sunny"])

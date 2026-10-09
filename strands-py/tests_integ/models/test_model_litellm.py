import os
import unittest.mock
from uuid import uuid4

import pydantic
import pytest

import strands
from strands import Agent
from strands.models.litellm import LiteLLMModel
from tests_integ.conftest import retry_on_flaky


@pytest.fixture
def model():
    return LiteLLMModel(model_id="bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0")


@pytest.fixture
def streaming_model():
    return LiteLLMModel(model_id="bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0", params={"stream": True})


@pytest.fixture
def non_streaming_model():
    return LiteLLMModel(model_id="bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0", params={"stream": False})


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
def agent(model, tools):
    return Agent(model=model, tools=tools)


@pytest.fixture
def weather():
    class Weather(pydantic.BaseModel):
        """Extracts the time and weather from the user's message with the exact strings."""

        time: str = pydantic.Field(description="The time in HH:MM format (e.g., '12:00', '09:30')")
        weather: str = pydantic.Field(description="The weather condition (e.g., 'sunny', 'rainy', 'cloudy')")

    return Weather(time="12:00", weather="sunny")


class Location(pydantic.BaseModel):
    """Location information."""

    city: str = pydantic.Field(description="The city name")
    country: str = pydantic.Field(description="The country name")


class WeatherCondition(pydantic.BaseModel):
    """Weather condition details."""

    condition: str = pydantic.Field(description="The weather condition (e.g., 'sunny', 'rainy', 'cloudy')")
    temperature: int = pydantic.Field(description="Temperature in Celsius")


class NestedWeather(pydantic.BaseModel):
    """Weather report with nested location and condition information."""

    time: str = pydantic.Field(description="The time in HH:MM format")
    location: Location = pydantic.Field(description="Location information")
    weather: WeatherCondition = pydantic.Field(description="Weather condition details")


@pytest.fixture
def nested_weather():
    return NestedWeather(
        time="12:00",
        location=Location(city="New York", country="USA"),
        weather=WeatherCondition(condition="sunny", temperature=25),
    )


@pytest.fixture
def yellow_color():
    class Color(pydantic.BaseModel):
        """Describes a color with its basic name.

        Used to extract and normalize color names from text or images.
        The color name should be a simple, common color like 'red', 'blue', 'yellow', etc.
        """

        simple_color_name: str = pydantic.Field(
            description="The basic color name (e.g., 'red', 'blue', 'yellow', 'green', 'orange', 'purple')"
        )

        @pydantic.field_validator("simple_color_name", mode="after")
        @classmethod
        def lower(_, value):
            return value.lower()

    return Color(simple_color_name="yellow")


@pytest.mark.parametrize("model_fixture", ["streaming_model", "non_streaming_model"])
def test_agent_invoke(model_fixture, tools, request):
    model = request.getfixturevalue(model_fixture)
    agent = Agent(model=model, tools=tools)
    result = agent("What is the time and weather in New York?")
    text = result.message["content"][0]["text"].lower()

    assert all(string in text for string in ["12:00", "sunny"])


@pytest.mark.parametrize("model_fixture", ["streaming_model", "non_streaming_model"])
@pytest.mark.asyncio
async def test_agent_invoke_async(model_fixture, tools, request):
    model = request.getfixturevalue(model_fixture)
    agent = Agent(model=model, tools=tools)
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


def test_agent_invoke_reasoning(agent, model):
    model.update_config(
        params={
            "thinking": {
                "budget_tokens": 1024,
                "type": "enabled",
            },
        },
    )

    result = agent("Please reason about the equation 2+2.")

    assert "reasoningContent" in result.message["content"][0]
    assert result.message["content"][0]["reasoningContent"]["reasoningText"]["text"]


@pytest.mark.parametrize("model_fixture", ["streaming_model", "non_streaming_model"])
def test_structured_output(model_fixture, weather, request):
    model = request.getfixturevalue(model_fixture)
    agent = Agent(model=model)
    tru_weather = agent.structured_output(type(weather), "The time is 12:00 and the weather is sunny")
    exp_weather = weather
    assert tru_weather == exp_weather


@pytest.mark.parametrize("model_fixture", ["streaming_model", "non_streaming_model"])
@pytest.mark.asyncio
async def test_agent_structured_output_async(model_fixture, weather, request):
    model = request.getfixturevalue(model_fixture)
    agent = Agent(model=model)
    tru_weather = await agent.structured_output_async(type(weather), "The time is 12:00 and the weather is sunny")
    exp_weather = weather
    assert tru_weather == exp_weather


def test_invoke_multi_modal_input(agent, yellow_img):
    content = [
        {"text": "Is this image red, blue, or yellow?"},
        {
            "image": {
                "format": "png",
                "source": {
                    "bytes": yellow_img,
                },
            },
        },
    ]
    result = agent(content)
    text = result.message["content"][0]["text"].lower()

    assert "yellow" in text


def test_structured_output_multi_modal_input(agent, yellow_img, yellow_color):
    content = [
        {"text": "what is in this image"},
        {
            "image": {
                "format": "png",
                "source": {
                    "bytes": yellow_img,
                },
            },
        },
    ]
    tru_color = agent.structured_output(type(yellow_color), content)
    exp_color = yellow_color
    assert tru_color == exp_color


def test_structured_output_unsupported_model(model, nested_weather):
    # Mock supports_response_schema to return False to test fallback mechanism
    with (
        unittest.mock.patch.multiple(
            "strands.models.litellm",
            supports_response_schema=unittest.mock.DEFAULT,
        ) as mocks,
        unittest.mock.patch.object(
            model, "_structured_output_using_tool", wraps=model._structured_output_using_tool
        ) as mock_tool,
        unittest.mock.patch.object(
            model, "_structured_output_using_response_schema", wraps=model._structured_output_using_response_schema
        ) as mock_schema,
    ):
        mocks["supports_response_schema"].return_value = False

        # Test that structured output still works via tool calling fallback
        agent = Agent(model=model)
        prompt = "The time is 12:00 in New York, USA and the weather is sunny with temperature 25 degrees Celsius"
        tru_weather = agent.structured_output(NestedWeather, prompt)
        exp_weather = nested_weather
        assert tru_weather == exp_weather

        # Verify that the tool method was called and schema method was not
        mock_tool.assert_called_once()
        mock_schema.assert_not_called()


@pytest.mark.parametrize("model_fixture", ["streaming_model", "non_streaming_model"])
def test_streaming_returns_usage_metrics(model_fixture, request):
    """Test that streaming returns usage metrics.

    This test verifies that the streaming flow correctly extracts and returns
    usage data from the model response. This is a regression test for the bug
    where accessing 'usage' attribute on ModelResponseStream raised AttributeError.

    Regression test for: 'ModelResponseStream' object has no attribute 'usage'
    """
    model = request.getfixturevalue(model_fixture)
    agent = Agent(model=model)
    result = agent("Say hello")

    # Verify usage metrics are returned - this would fail if streaming breaks
    assert result.metrics.accumulated_usage is not None
    assert result.metrics.accumulated_usage["inputTokens"] > 0
    assert result.metrics.accumulated_usage["outputTokens"] > 0
    assert result.metrics.accumulated_usage["totalTokens"] > 0


@pytest.mark.asyncio
@pytest.mark.parametrize("streaming", [True, False])
async def test_cache_read_tokens_multi_turn(model, streaming):
    """Integration test for cache read tokens in multi-turn conversation."""
    from strands.types.content import SystemContentBlock

    system_prompt_content: list[SystemContentBlock] = [
        # Caching only works when prompts are large
        {"text": f"You are helpful assistant No. {uuid4()}  Always be concise." * 200},
        {"cachePoint": {"type": "default"}},
    ]

    model.update_config(stream=streaming)
    agent = Agent(model=model, system_prompt=system_prompt_content)

    # First turn - establishes cache
    first_result = await agent.invoke_async("Hello, what's 2+2?")
    assert first_result.metrics.latest_agent_invocation.usage["cacheReadInputTokens"] == 0
    assert first_result.metrics.latest_agent_invocation.usage["cacheWriteInputTokens"] > 0

    result = await agent.invoke_async("What's 3+3?")
    assert result.metrics.latest_agent_invocation.usage["cacheReadInputTokens"] > 0
    assert result.metrics.latest_agent_invocation.usage["cacheWriteInputTokens"] == 0


@retry_on_flaky("The model may occasionally not elect to call both tools", retry_on=[AssertionError])
def test_gemini_thinking_model_tool_call(tools):
    """Test that Gemini thinking models preserve thought_signature through multi-turn tool calls.

    Regression test for https://github.com/strands-agents/harness-sdk/issues/1764
    """
    model = LiteLLMModel(model_id="gemini/gemini-2.5-flash", client_args={"api_key": os.environ.get("GOOGLE_API_KEY")})
    agent = Agent(model=model, tools=tools)
    # Direct the model to use the tools: an open-ended question lets Gemini decline
    # (e.g. "I can only report my own location"), which is unrelated to what we test here.
    result = agent("Use the available tools to look up the current time and weather, then tell me both.")

    # Assert on the structure of the multi-turn cycle rather than the model's free-text
    # wording (non-deterministic). Without thought_signature preservation the follow-up
    # model call after the tool results would fail, so reaching a final assistant text
    # turn that incorporates both tool results is what proves the regression is fixed.
    called_tools = {
        block["toolUse"]["name"] for message in agent.messages for block in message["content"] if "toolUse" in block
    }
    assert {"tool_time", "tool_weather"} <= called_tools

    tool_results = [
        block["toolResult"] for message in agent.messages for block in message["content"] if "toolResult" in block
    ]
    # Both tools ran cleanly and returned their values, so the follow-up model call
    # operates on real results rather than error placeholders.
    assert all(tool_result["status"] == "success" for tool_result in tool_results)
    tool_result_text = " ".join(
        content_block["text"]
        for tool_result in tool_results
        for content_block in tool_result["content"]
        if "text" in content_block
    )
    assert "12:00" in tool_result_text and "sunny" in tool_result_text

    # The agent loop ran to completion with a final assistant turn after the tool results.
    assert result.message["role"] == "assistant"
    assert any("text" in block for block in result.message["content"])

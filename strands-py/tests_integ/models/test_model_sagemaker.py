import os

import pytest

import strands
from strands import Agent
from strands.models.sagemaker import SageMakerAIModel


@pytest.fixture
def model():
    endpoint_config = SageMakerAIModel.SageMakerAIEndpointConfig(
        endpoint_name=os.getenv("SAGEMAKER_ENDPOINT_NAME", ""), region_name="us-east-1"
    )
    payload_config = SageMakerAIModel.SageMakerAIPayloadSchema(max_tokens=1024, temperature=0.7, stream=False)
    return SageMakerAIModel(endpoint_config=endpoint_config, payload_config=payload_config)


@pytest.fixture
def tools():
    @strands.tool
    def tool_time(location: str) -> str:
        """Get the current time for a location."""
        return f"The time in {location} is 12:00 PM"

    @strands.tool
    def tool_weather(location: str) -> str:
        """Get the current weather for a location."""
        return f"The weather in {location} is sunny"

    return [tool_time, tool_weather]


@pytest.fixture
def system_prompt():
    return "You are a helpful assistant that provides concise answers."


@pytest.fixture
def agent(model, tools, system_prompt):
    return Agent(model=model, tools=tools, system_prompt=system_prompt)


@pytest.mark.skipif(
    "SAGEMAKER_ENDPOINT_NAME" not in os.environ,
    reason="SAGEMAKER_ENDPOINT_NAME environment variable missing",
)
def test_agent_with_tools(agent):
    result = agent("What is the time and weather in New York?")
    text = result.message["content"][0]["text"].lower()

    assert "12:00" in text and "sunny" in text


@pytest.mark.skipif(
    "SAGEMAKER_ENDPOINT_NAME" not in os.environ,
    reason="SAGEMAKER_ENDPOINT_NAME environment variable missing",
)
def test_agent_without_tools(model, system_prompt):
    agent = Agent(model=model, system_prompt=system_prompt)
    result = agent("Hello, how are you?")

    assert result.message["content"][0]["text"]
    assert len(result.message["content"][0]["text"]) > 0


@pytest.mark.skipif(
    "SAGEMAKER_ENDPOINT_NAME" not in os.environ,
    reason="SAGEMAKER_ENDPOINT_NAME environment variable missing",
)
@pytest.mark.parametrize("location", ["Tokyo", "London", "Sydney"])
def test_agent_different_locations(agent, location):
    result = agent(f"What is the weather in {location}?")
    text = result.message["content"][0]["text"].lower()

    assert location.lower() in text and "sunny" in text

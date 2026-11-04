"""Integration tests for ``BedrockModel.Messages`` against both Bedrock endpoints that serve the Messages API.

The shared conformance suite covers the bedrock-runtime default; this covers what is specific to Bedrock: both
endpoints, signed with an explicit boto3 session.
"""

import boto3
import pytest

from strands import Agent, tool
from strands.models import BedrockModel


@tool
def get_weather(city: str) -> dict:
    """Get the current weather for a city."""
    return {"status": "success", "content": [{"json": {"city": city, "temperature_c": 21}}]}


@pytest.mark.parametrize(
    ("endpoint", "model_id"),
    [
        ("bedrock-runtime", "global.anthropic.claude-sonnet-4-6"),
        ("bedrock-mantle", "anthropic.claude-haiku-4-5"),
    ],
)
def test_tool_use_with_session_credentials(endpoint, model_id):
    model = BedrockModel.Messages(
        model_id=model_id, max_tokens=1024, endpoint=endpoint, boto_session=boto3.Session(region_name="us-west-2")
    )
    agent = Agent(model=model, tools=[get_weather], callback_handler=None)

    result = agent("What is the weather in Paris? Use the tool, then answer in one short sentence.")

    assert "21" in str(result)
    assert result.metrics.accumulated_usage["inputTokens"] > 0

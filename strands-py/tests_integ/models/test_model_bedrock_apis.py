"""Integration tests for the nested ``BedrockModel`` API classes on both Bedrock endpoints.

Each call is signed with an explicit boto3 session. The shared conformance suite covers ``BedrockModel.Messages``
and ``BedrockModel.ChatCompletions`` on the bedrock-runtime default.
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
    ("model_class", "endpoint", "model_id"),
    [
        ("Messages", "bedrock-runtime", "global.anthropic.claude-sonnet-4-6"),
        ("Messages", "bedrock-mantle", "anthropic.claude-haiku-4-5"),
        ("ChatCompletions", "bedrock-runtime", "openai.gpt-oss-120b-1:0"),
        ("ChatCompletions", "bedrock-mantle", "openai.gpt-oss-120b"),
        ("Responses", "bedrock-mantle", "openai.gpt-oss-120b"),
    ],
)
def test_tool_use_with_session_credentials(model_class, endpoint, model_id):
    settings = {"max_tokens": 1024} if model_class == "Messages" else {}
    model = getattr(BedrockModel, model_class)(
        model_id=model_id, endpoint=endpoint, boto_session=boto3.Session(region_name="us-west-2"), **settings
    )
    agent = Agent(model=model, tools=[get_weather], callback_handler=None)

    result = agent("What is the weather in Paris? Use the tool, then answer in one short sentence.")

    assert "21" in str(result)
    assert result.metrics.accumulated_usage["inputTokens"] > 0

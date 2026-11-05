"""Integration tests for the nested ``BedrockModel`` API classes.

The shared conformance suite covers ``BedrockModel.Messages`` on the bedrock-runtime default. The OpenAI classes run
on bedrock-mantle in us-east-1, like ``test_model_mantle.py``: bearer tokens on bedrock-runtime need the
``bedrock:CallWithBearerToken`` permission.
"""

import pytest

from strands import Agent, tool
from strands.models import BedrockModel


@tool
def get_weather(city: str) -> dict:
    """Get the current weather for a city."""
    return {"status": "success", "content": [{"json": {"city": city, "temperature_c": 21}}]}


@pytest.mark.parametrize(
    ("model_class", "endpoint", "region_name", "model_id"),
    [
        ("Messages", "bedrock-runtime", "us-west-2", "global.anthropic.claude-sonnet-4-6"),
        ("Messages", "bedrock-mantle", "us-west-2", "anthropic.claude-haiku-4-5"),
        ("ChatCompletions", "bedrock-mantle", "us-east-1", "openai.gpt-oss-120b"),
        ("Responses", "bedrock-mantle", "us-east-1", "openai.gpt-oss-120b"),
    ],
)
def test_tool_use(model_class, endpoint, region_name, model_id):
    settings = {"max_tokens": 1024} if model_class == "Messages" else {}
    model = getattr(BedrockModel, model_class)(
        model_id=model_id, endpoint=endpoint, region_name=region_name, **settings
    )
    agent = Agent(model=model, tools=[get_weather], callback_handler=None)

    result = agent("What is the weather in Paris? Use the tool, then answer in one short sentence.")

    assert "21" in str(result)
    assert result.metrics.accumulated_usage["inputTokens"] > 0

"""Integration tests for AnthropicModel with injected Bedrock clients.

Covers bedrock-runtime InvokeModel (``AsyncAnthropicBedrock``) and bedrock-mantle (``AsyncAnthropicBedrockMantle``),
including server-side summarization. Credentials come from the ambient AWS credential chain.
"""

import anthropic
import pytest

from strands import Agent
from strands.models.anthropic import AnthropicModel

_REGION = "us-east-1"


def _runtime_model():
    return AnthropicModel(
        client=anthropic.AsyncAnthropicBedrock(aws_region=_REGION),
        model_id="us.anthropic.claude-haiku-5-5",
        max_tokens=1024,
    )


def _mantle_model():
    if not hasattr(anthropic, "AsyncAnthropicBedrockMantle"):
        pytest.skip("installed anthropic has no AsyncAnthropicBedrockMantle")
    return AnthropicModel(
        client=anthropic.AsyncAnthropicBedrockMantle(aws_region=_REGION),
        model_id="anthropic.claude-opus-5-5",
        max_tokens=1024,
    )


@pytest.fixture(params=[_runtime_model, _mantle_model], ids=["runtime", "mantle"])
def model(request):
    return request.param()


def test_agent_invoke(model):
    result = Agent(model=model)("What is 2 + 2? Reply with only the number.")

    assert "4" in str(result)


@pytest.mark.asyncio
async def test_summarize_round_trip(model):
    messages = [
        {"role": "user", "content": [{"text": "My name is Ada and I live in Lisbon. Remember that."}]},
        {"role": "assistant", "content": [{"text": "Got it, Ada from Lisbon."}]},
        {"role": "user", "content": [{"text": "My favourite colour is teal."}]},
        {"role": "assistant", "content": [{"text": "Noted: teal."}]},
    ]
    assert model.model_info.capabilities.server_side_summary is True

    result = await model.summarize(messages, system_prompt="You are helpful.")

    [block] = result.content
    assert block["summary"]["provider"] == "anthropic"
    assert block["summary"]["signature"]

    # Mirrors how the summarize strategy splices the summary into history.
    agent = Agent(
        model=model,
        system_prompt="You are helpful.",
        messages=[messages[0], {"role": "assistant", "content": [block]}],
    )
    result = await agent.invoke_async("What is my name and which city do I live in?")

    assert all(word in str(result).lower() for word in ("ada", "lisbon"))

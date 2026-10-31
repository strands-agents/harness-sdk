"""Integration tests for ``BedrockInvokeModel``.

Hits real Bedrock; requires AWS credentials. The imported-model test is gated on
``STRANDS_BEDROCK_INVOKE_IMPORTED_MODEL_ARN`` since ARNs are account-specific.
"""

import os
from uuid import uuid4

import pydantic
import pytest

from strands import Agent, tool
from strands.models.bedrock import DEFAULT_BEDROCK_MODEL_ID
from strands.models.bedrock_invoke import BedrockInvokeModel
from strands.models.model import CacheConfig


@tool
def string_length(string_to_measure: str) -> str:
    """Return the length of the string passed in."""
    return str(len(string_to_measure))


@pytest.mark.parametrize("streaming", [False, True])
def test_bedrock_invoke_basic_text_generation(streaming: bool) -> None:
    agent = Agent(
        BedrockInvokeModel(model_id=DEFAULT_BEDROCK_MODEL_ID, max_tokens=64, temperature=0.0, streaming=streaming)
    )
    result = agent("Reply with the single word: ack")
    assert result.message["content"]
    assert result.stop_reason in ("end_turn", "stop_sequence", "max_tokens")


@pytest.mark.parametrize("streaming", [False, True])
def test_bedrock_invoke_tool_use(streaming: bool) -> None:
    tool_called: list[str] = []

    @tool
    def measure_string(string_to_measure: str) -> str:
        """Return the length of the string passed in."""
        tool_called.append(string_to_measure)
        return string_length(string_to_measure)

    agent = Agent(
        BedrockInvokeModel(model_id=DEFAULT_BEDROCK_MODEL_ID, max_tokens=256, temperature=0.0, streaming=streaming),
        tools=[measure_string],
    )
    result = agent(f'Use the {measure_string.tool_name} tool to measure the string "abcdef".')
    assert tool_called == ["abcdef"]
    assert result.message["content"]


@pytest.mark.parametrize("streaming", [False, True])
def test_bedrock_invoke_structured_output(streaming: bool) -> None:
    class Person(pydantic.BaseModel):
        name: str
        age: int

    agent = Agent(
        BedrockInvokeModel(model_id=DEFAULT_BEDROCK_MODEL_ID, max_tokens=128, temperature=0.0, streaming=streaming)
    )
    person = agent.structured_output(Person, "Return name=Ada and age=36 as JSON.")
    assert person == Person(name="Ada", age=36)


@pytest.mark.parametrize("streaming", [False, True])
def test_bedrock_invoke_prompt_caching(streaming: bool) -> None:
    """Verify native cache placement and usage accounting across two invocations."""
    system_prompt = f"Cache test {uuid4()}. " + (
        "You are a helpful assistant. Answer each user request with a single short sentence. " * 512
    )
    agent = Agent(
        BedrockInvokeModel(
            model_id=DEFAULT_BEDROCK_MODEL_ID,
            max_tokens=64,
            temperature=0.0,
            streaming=streaming,
            cache_config=CacheConfig(),
        ),
        system_prompt=system_prompt,
        callback_handler=None,
    )
    first = agent("Reply with the single word: ack")
    assert first.metrics.latest_agent_invocation.usage.get("cacheWriteInputTokens", 0) > 0
    second = agent("Reply with the single word: ready")
    assert second.metrics.latest_agent_invocation.usage.get("cacheReadInputTokens", 0) > 0


@pytest.mark.parametrize("streaming", [False, True])
@pytest.mark.skipif(
    not os.environ.get("STRANDS_BEDROCK_INVOKE_IMPORTED_MODEL_ARN"),
    reason="Set STRANDS_BEDROCK_INVOKE_IMPORTED_MODEL_ARN to run against an imported model",
)
def test_bedrock_invoke_with_imported_model(streaming: bool) -> None:
    arn = os.environ["STRANDS_BEDROCK_INVOKE_IMPORTED_MODEL_ARN"]
    agent = Agent(BedrockInvokeModel(model_id=arn, streaming=streaming), tools=[string_length])
    assert agent("Generate a random string, then tell me its length.").message["content"]

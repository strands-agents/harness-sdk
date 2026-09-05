"""Integration tests for ``BedrockInvokeModel``.

Hits real Bedrock; requires AWS credentials. The imported-model test is gated on
``STRANDS_BEDROCK_INVOKE_IMPORTED_MODEL_ARN`` since ARNs are account-specific.
"""

import os

import pydantic
import pytest

from strands import Agent, tool
from strands.models.bedrock import DEFAULT_BEDROCK_MODEL_ID
from strands.models.bedrock_invoke import BedrockInvokeModel


@tool
def string_length(string_to_measure: str) -> str:
    """Return the length of the string passed in."""
    return str(len(string_to_measure))


def test_bedrock_invoke_basic_text_generation():
    agent = Agent(BedrockInvokeModel(model_id=DEFAULT_BEDROCK_MODEL_ID, max_tokens=64, temperature=0.0))
    result = agent("Reply with the single word: ack")
    assert result.message["content"]
    assert result.stop_reason in ("end_turn", "stop_sequence", "max_tokens")


def test_bedrock_invoke_tool_use():
    agent = Agent(
        BedrockInvokeModel(model_id=DEFAULT_BEDROCK_MODEL_ID, max_tokens=256, temperature=0.0),
        tools=[string_length],
    )
    assert agent('Use the string_length tool to measure the string "abcdef".').message["content"]


def test_bedrock_invoke_structured_output():
    class Person(pydantic.BaseModel):
        name: str
        age: int

    agent = Agent(BedrockInvokeModel(model_id=DEFAULT_BEDROCK_MODEL_ID, max_tokens=128, temperature=0.0))
    person = agent.structured_output(Person, "Return name=Ada and age=36 as JSON.")
    assert isinstance(person, Person)


@pytest.mark.skipif(
    not os.environ.get("STRANDS_BEDROCK_INVOKE_IMPORTED_MODEL_ARN"),
    reason="Set STRANDS_BEDROCK_INVOKE_IMPORTED_MODEL_ARN to run against an imported model",
)
def test_bedrock_invoke_with_imported_model():
    arn = os.environ["STRANDS_BEDROCK_INVOKE_IMPORTED_MODEL_ARN"]
    agent = Agent(BedrockInvokeModel(model_id=arn), tools=[string_length])
    assert agent("Generate a random string, then tell me its length.").message["content"]

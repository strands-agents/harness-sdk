"""Live integration tests for the decision-model primitive."""

import pytest

from strands import LLMDecisionModel, Uncertain
from strands.models import BedrockModel

_HAIKU_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"


def _bedrock_decision_model() -> LLMDecisionModel:
    return LLMDecisionModel(model=BedrockModel(model_id=_HAIKU_MODEL_ID, max_tokens=512))


@pytest.mark.asyncio
async def test_answers_each_question_with_the_typed_value_and_reports_usage_and_latency():
    decision = _bedrock_decision_model()

    result = await decision.ask(
        "The fruit is a ripe banana.",
        {
            "color": {"question": "What color is the fruit?", "choices": ["red", "yellow", "blue"]},
            "is_fruit": {"question": "Is the thing described a fruit?", "choices": "boolean", "uncertainty": False},
        },
    )

    assert result.answers["color"] == "yellow"
    assert result.answers["is_fruit"] is True
    assert result.usage is not None
    assert result.usage["inputTokens"] > 0
    assert result.usage["outputTokens"] > 0
    assert result.metadata.latency_ms > 0


@pytest.mark.asyncio
async def test_returns_uncertain_with_a_reason_when_the_state_cannot_answer_the_question():
    decision = _bedrock_decision_model()

    result = await decision.ask(
        "There is a round object on the table.",
        {"color": {"question": "What color is the object?", "choices": ["red", "green", "blue"]}},
    )

    answer = result.answers["color"]
    assert isinstance(answer, Uncertain)
    assert answer.reason is not None
    assert str(answer).startswith("Uncertain")

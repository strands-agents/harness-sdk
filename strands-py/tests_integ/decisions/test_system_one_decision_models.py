"""Live integration tests for the System One decision models (Jev, decisionapi.net, SageMaker)."""

import os
from collections.abc import Callable

import pytest

from strands.decisions import DecisionModel, DecisionsAPIDecisionModel, SageMakerDecisionModel, TypeSafeDecisionModel

_PROVIDERS = [
    pytest.param(
        TypeSafeDecisionModel,
        "typesafe",
        "TYPESAFE_API_KEY",
        id="TypeSafeDecisionModel",
        marks=pytest.mark.skipif(not os.environ.get("TYPESAFE_API_KEY"), reason="TYPESAFE_API_KEY not set"),
    ),
    pytest.param(
        DecisionsAPIDecisionModel,
        "decisions_api",
        "JEV_API_KEY",
        id="DecisionsAPIDecisionModel",
        marks=pytest.mark.skipif(not os.environ.get("JEV_API_KEY"), reason="JEV_API_KEY not set"),
    ),
    pytest.param(
        # A strands-decider endpoint deployed with strands-decider's deploy/sagemaker, in the default AWS region.
        lambda: SageMakerDecisionModel(os.environ["SAGEMAKER_DECISION_ENDPOINT"]),
        "sagemaker",
        "SAGEMAKER_DECISION_ENDPOINT",
        id="SageMakerDecisionModel",
        marks=pytest.mark.skipif(
            not os.environ.get("SAGEMAKER_DECISION_ENDPOINT"), reason="SAGEMAKER_DECISION_ENDPOINT not set"
        ),
    ),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("model_factory, provider_name, _env", _PROVIDERS)
async def test_answers_noul_and_choice_questions_and_reports_provider_metadata(
    model_factory: Callable[[], DecisionModel], provider_name: str, _env: str
):
    decision = model_factory()

    result = await decision.ask(
        "The fruit is a ripe yellow banana.",
        {
            "color": {
                "question": "What color is the fruit?",
                "choices": ["red", "yellow", "blue"],
                "uncertainty": False,
            },
            "is_fruit": {"question": "Is the thing described a fruit?", "choices": "boolean", "uncertainty": False},
        },
    )

    assert result.answers == {"color": "yellow", "is_fruit": True}
    assert result.metadata.provider_name == provider_name
    assert result.metadata.model_id
    assert result.metadata.probabilities is not None
    assert result.metadata.probabilities["color"]
    assert result.metadata.probabilities["is_fruit"]
    assert result.metadata.confidence is not None
    assert result.metadata.confidence["color"] >= 0
    assert result.metadata.confidence["is_fruit"] >= 0
    assert result.metadata.latency_ms > 0

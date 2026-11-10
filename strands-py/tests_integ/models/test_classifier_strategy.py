"""Live integration test for classifier-driven model routing."""

import logging

from strands import Agent
from strands.models import BedrockModel, ClassifierStrategy, ModelRouter, RoutingCandidate
from strands.types.exceptions import ModelThrottledException
from tests_integ.conftest import retry_on_flaky

_HAIKU_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
_NOVA_LITE_MODEL_ID = "us.amazon.nova-lite-v1:0"
_NOVA_PRO_MODEL_ID = "us.amazon.nova-pro-v1:0"


@retry_on_flaky(
    "Bedrock capacity may be transiently unavailable",
    max_attempts=2,
    retry_on=[ModelThrottledException],
)
def test_model_router_selects_expected_model_from_three_candidates(caplog):
    """The public Agent entry point classifies and serves a request on the expected candidate."""
    fast_model = BedrockModel(model_id=_HAIKU_MODEL_ID, max_tokens=512, streaming=False)
    balanced_model = BedrockModel(model_id=_NOVA_LITE_MODEL_ID, max_tokens=512, streaming=False)
    advanced_model = BedrockModel(model_id=_NOVA_PRO_MODEL_ID, max_tokens=512, streaming=False)
    router = ModelRouter(
        models=[
            RoutingCandidate(
                fast_model,
                name="fast model",
                description="Best suited to concise factual questions and routine requests.",
                metadata={"provider": "bedrock", "model_id": _HAIKU_MODEL_ID},
            ),
            RoutingCandidate(
                advanced_model,
                name="advanced model",
                description="Best suited to complex systems design with several interacting constraints.",
                metadata={"provider": "bedrock", "model_id": _NOVA_PRO_MODEL_ID},
            ),
            RoutingCandidate(
                balanced_model,
                name="balanced model",
                description="Best suited to summaries and moderately complex general requests.",
                metadata={"provider": "bedrock", "model_id": _NOVA_LITE_MODEL_ID},
            ),
        ],
        strategy=ClassifierStrategy(
            BedrockModel(
                model_id=_HAIKU_MODEL_ID,
                max_tokens=64,
                streaming=False,
                temperature=0,
            )
        ),
    )
    agent = Agent(
        model=router,
        system_prompt="You are just an agent",
        load_tools_from_directory=False,
        callback_handler=None,
    )
    request = (
        "Design a backward-compatible migration from region-local to globally unique idempotency keys for an "
        "active-active payment service. Account for concurrent requests, mixed-version deployments, rollback, "
        "reconciliation, and monitoring. Return exactly three concise bullets."
    )

    with caplog.at_level(logging.INFO, logger="strands.models.routing.router"):
        result = agent(request)

    assert result.stop_reason == "end_turn"
    assert str(result).strip()
    expected_log = (
        "strategy=<ClassifierStrategy>, candidate=<advanced model>, "
        f"model=<BedrockModel/{_NOVA_PRO_MODEL_ID}> | candidate selected"
    )
    assert any(expected_log in record.getMessage() for record in caplog.records)

import pytest

from strands import Agent
from strands.experimental.decisions import DecisionStrategy, LLMDecisionModel
from strands.models import ModelRouter, RoutingAttempt, RoutingCandidate
from strands.models.routing.strategy import RoutingContext
from tests.fixtures.mocked_decision_model import MockedDecisionModel, choice
from tests.fixtures.mocked_model_provider import MockedModelProvider


def _model(text):
    return MockedModelProvider([{"role": "assistant", "content": [{"text": text}]}])


def _router(strategy):
    return ModelRouter(
        models=[
            RoutingCandidate(_model("routine"), name="routine", description="Simple lookups"),
            RoutingCandidate(
                _model("complex"), name="complex", description="Multi-step reasoning", metadata={"tier": 3}
            ),
        ],
        strategy=strategy,
    )


def _context(router, attempts=()):
    return RoutingContext(
        messages=[{"role": "user", "content": [{"text": "Prove sqrt(2) is irrational"}]}],
        system_prompt="Be precise",
        tool_specs=[],
        candidates=router.candidates,
        invocation_state={},
        attempts=attempts,
    )


@pytest.mark.asyncio
async def test_select_routes_agent_to_chosen_candidate():
    decisions = MockedDecisionModel({"candidate": choice("c1", {"c0": 0.1, "c1": 0.9}, 0.85)})
    agent = Agent(model=_router(DecisionStrategy(decisions)), callback_handler=None)

    tru_result = agent("Prove sqrt(2) is irrational")

    assert str(tru_result).strip() == "complex"
    state, questions = decisions.requests[0]
    assert state == {"request": "Prove sqrt(2) is irrational", "agent_instructions": ""}
    assert questions["candidate"].options == {
        "c0": '{"name": "routine", "description": "Simple lookups"}',
        "c1": '{"name": "complex", "description": "Multi-step reasoning", "metadata": {"tier": 3}}',
    }


@pytest.mark.asyncio
async def test_select_declines_on_low_confidence():
    decisions = MockedDecisionModel({"candidate": choice("c1", {"c0": 0.45, "c1": 0.55}, 0.1)})
    strategy = DecisionStrategy(decisions, min_confidence=0.7)
    router = _router(strategy)

    assert await strategy.select(_context(router)) is None


@pytest.mark.asyncio
async def test_select_declines_on_error_and_after_failure(caplog):
    strategy = DecisionStrategy(MockedDecisionModel(RuntimeError("boom")))
    router = _router(strategy)

    assert await strategy.select(_context(router)) is None
    assert "reason=<decision_error>" in caplog.text
    failed = (RoutingAttempt(router.candidates[0], RuntimeError("x")),)
    assert await strategy.select(_context(router, failed)) is None


@pytest.mark.asyncio
async def test_select_single_candidate_skips_decision():
    decisions = MockedDecisionModel()
    strategy = DecisionStrategy(decisions)
    router = ModelRouter(models=[_model("only")], strategy=strategy)

    assert await strategy.select(_context(router)) is router.candidates[0]
    assert decisions.requests == []


def test_init_rejects_min_confidence_on_uncalibrated_model():
    with pytest.raises(ValueError, match=r"DecisionStrategy\(min_confidence=0.7\) needs a calibrated DecisionModel"):
        DecisionStrategy(LLMDecisionModel(_model("x")), min_confidence=0.7)


def test_init_rejects_non_positive_budget():
    with pytest.raises(ValueError, match="greater than zero"):
        DecisionStrategy(MockedDecisionModel(), max_request_tokens=0)


def test_decision_strategy_is_reexported_from_routing():
    from strands.experimental.decisions import DecisionStrategy
    from strands.models import routing

    assert routing.DecisionStrategy is DecisionStrategy
    assert "DecisionStrategy" in routing.__all__
    with pytest.raises(AttributeError):
        routing.NotAStrategy  # noqa: B018

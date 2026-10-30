"""Tests for FallbackStrategy: what it decides from the attempt log, independent of the router."""

import pytest

from strands.models.routing import FallbackStrategy, ModelRouter, RoutingAttempt, RoutingContext
from strands.types.exceptions import ContextWindowOverflowException
from tests.fixtures.mocked_model_provider import MockedModelProvider


def _model(text="hi", context_window_limit=None):
    """A model that streams one text response."""
    model = MockedModelProvider([{"role": "assistant", "content": [{"text": text}]}])
    model.get_config = lambda: {"context_window_limit": context_window_limit}
    return model


def _routing_context(candidates, attempts=()):
    return RoutingContext(
        messages=[],
        system_prompt=None,
        tool_specs=[],
        candidates=candidates,
        invocation_state={},
        attempts=attempts,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("count", "history", "expected"),
    [
        (2, lambda c, e: (), 0),
        (2, lambda c, e: (RoutingAttempt(c[0], e),), 1),
        (2, lambda c, e: (RoutingAttempt(c[0], e), RoutingAttempt(c[1], e)), None),
        # A success clears the failures before it, so the earlier candidate is eligible again.
        (2, lambda c, e: (RoutingAttempt(c[0], e), RoutingAttempt(c[1]), RoutingAttempt(c[1], e)), 0),
        # With an untouched candidate available, the one carrying a failure is demoted below it.
        (3, lambda c, e: (RoutingAttempt(c[0], e), RoutingAttempt(c[1]), RoutingAttempt(c[1], e)), 2),
    ],
    ids=["opening-choice", "advances", "exhausted", "rearms-after-success", "prefers-least-failed"],
)
async def test_fallback_strategy_decides_from_the_attempt_log(count, history, expected):
    router = ModelRouter(models=[_model() for _ in range(count)])
    attempts = history(router.candidates, ValueError("down"))

    chosen = await FallbackStrategy().select(_routing_context(router.candidates, attempts=attempts))

    assert chosen is (None if expected is None else router.candidates[expected])


@pytest.mark.asyncio
async def test_fallback_strategy_filters_failover_errors():
    router = ModelRouter(models=[_model(), _model()])
    context = _routing_context(router.candidates, (RoutingAttempt(router.candidates[0], ValueError("bad")),))

    assert await FallbackStrategy(fail_over_on=TimeoutError).select(context) is None
    assert (
        await FallbackStrategy(fail_over_on=lambda error: isinstance(error, ValueError)).select(context)
        is router.candidates[1]
    )


@pytest.mark.asyncio
async def test_fallback_strategy_cooldown_skips_failed_candidate_across_invocations(monkeypatch):
    router = ModelRouter(models=[_model(), _model()])
    strategy = FallbackStrategy(cooldown=60)
    now = 0.0
    monkeypatch.setattr("strands.models.routing.fallback_strategy.time.monotonic", lambda: now)

    failed = _routing_context(router.candidates, (RoutingAttempt(router.candidates[0], TimeoutError("down")),))
    assert await strategy.select(failed) is router.candidates[1]

    now = 10.0
    assert await strategy.select(_routing_context(router.candidates)) is router.candidates[1]

    now = 61.0
    assert await strategy.select(_routing_context(router.candidates)) is router.candidates[0]


@pytest.mark.asyncio
async def test_fallback_strategy_uses_earliest_expiring_candidate_when_all_are_cooling(monkeypatch):
    router = ModelRouter(models=[_model(), _model()])
    strategy = FallbackStrategy(cooldown=60)
    now = 0.0
    monkeypatch.setattr("strands.models.routing.fallback_strategy.time.monotonic", lambda: now)

    first_failure = _routing_context(
        router.candidates,
        (RoutingAttempt(router.candidates[0], TimeoutError("first down")),),
    )
    assert await strategy.select(first_failure) is router.candidates[1]

    now = 10.0
    second_failure = _routing_context(
        router.candidates,
        (
            RoutingAttempt(router.candidates[0], TimeoutError("first down")),
            RoutingAttempt(router.candidates[1], TimeoutError("second down")),
        ),
    )
    assert await strategy.select(second_failure) is None

    now = 20.0
    assert await strategy.select(_routing_context(router.candidates)) is router.candidates[0]


@pytest.mark.asyncio
async def test_fallback_strategy_overflow_only_uses_a_larger_context_without_cooldown(monkeypatch):
    router = ModelRouter(
        models=[
            _model(context_window_limit=8_000),
            _model(context_window_limit=4_000),
            _model(context_window_limit=16_000),
        ]
    )
    strategy = FallbackStrategy(cooldown=60)
    monkeypatch.setattr("strands.models.routing.fallback_strategy.time.monotonic", lambda: 0.0)
    overflow = ContextWindowOverflowException("too large")

    failed = _routing_context(router.candidates, (RoutingAttempt(router.candidates[0], overflow),))
    assert await strategy.select(failed) is router.candidates[2]
    assert await strategy.select(_routing_context(router.candidates)) is router.candidates[0]


@pytest.mark.parametrize("cooldown", [-1, -0.1, float("inf"), float("nan")])
def test_fallback_strategy_rejects_invalid_cooldown(cooldown):
    with pytest.raises(ValueError, match="cooldown"):
        FallbackStrategy(cooldown=cooldown)

"""Tests for FallbackStrategy: what it decides from the attempt log, independent of the router."""

import pytest

from strands.models.routing import FallbackStrategy, ModelRouter, RoutingAttempt, RoutingContext
from tests.fixtures.mocked_model_provider import MockedModelProvider


def _model(text="hi"):
    """A model that streams one text response."""
    return MockedModelProvider([{"role": "assistant", "content": [{"text": text}]}])


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

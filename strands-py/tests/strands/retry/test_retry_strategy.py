import math

import pytest

from strands.retry import RetryDecision


def test_retry_decision_with_delay():
    decision = RetryDecision(retry=True, delay=1.5)

    assert decision.retry is True
    assert decision.delay == 1.5


def test_no_retry_decision_ignores_delay():
    assert RetryDecision(retry=False, delay=3).retry is False


@pytest.mark.parametrize("delay", [None, -1, math.inf, math.nan])
def test_retry_decision_rejects_invalid_delay(delay):
    with pytest.raises(ValueError, match="delay must be a non-negative finite number"):
        RetryDecision(retry=True, delay=delay)


def test_retry_decision_is_keyword_only():
    with pytest.raises(TypeError):
        RetryDecision(True, 1)  # type: ignore[misc]

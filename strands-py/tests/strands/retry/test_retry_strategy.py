import math

import pytest

from strands.retry import RetryDecision


def test_retry_decision_with_wait():
    decision = RetryDecision(retry=True, wait=1.5)

    assert decision.retry is True
    assert decision.wait == 1.5


def test_no_retry_decision_ignores_wait():
    assert RetryDecision(retry=False, wait=3).retry is False


@pytest.mark.parametrize("wait", [None, -1, math.inf, math.nan])
def test_retry_decision_rejects_invalid_wait(wait):
    with pytest.raises(ValueError, match="wait must be a non-negative finite number"):
        RetryDecision(retry=True, wait=wait)


def test_retry_decision_is_keyword_only():
    with pytest.raises(TypeError):
        RetryDecision(True, 1)  # type: ignore[misc]

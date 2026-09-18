"""Unit tests for retry backoff strategies."""

from unittest.mock import Mock

import pytest

from strands.retry import BackoffContext, ConstantBackoff, ExponentialBackoff, LinearBackoff


def _context(*, attempt: int = 1, last_delay: float | None = None) -> BackoffContext:
    return BackoffContext(attempt=attempt, elapsed_time=0, last_delay=last_delay)


def test_constant_backoff_returns_configured_delay():
    backoff = ConstantBackoff(delay=0.25)

    tru_delays = [backoff.next_delay(_context(attempt=1)), backoff.next_delay(_context(attempt=5))]
    exp_delays = [0.25, 0.25]
    assert tru_delays == exp_delays


def test_constant_backoff_uses_default_delay():
    assert ConstantBackoff().next_delay(_context()) == 1


@pytest.mark.parametrize("attempt", [0, -1, 1.5, True])
def test_backoff_rejects_invalid_attempt(attempt):
    with pytest.raises(ValueError, match="attempt must be an integer >= 1"):
        ExponentialBackoff().next_delay(_context(attempt=attempt))


def test_linear_backoff_grows_and_caps_without_jitter():
    backoff = LinearBackoff(base_delay=0.1, max_delay=0.25, jitter="none")

    tru_delays = [backoff.next_delay(_context(attempt=attempt)) for attempt in (1, 2, 3, 10)]
    exp_delays = [0.1, 0.2, 0.25, 0.25]
    assert tru_delays == exp_delays


def test_linear_backoff_applies_full_jitter_by_default(monkeypatch):
    monkeypatch.setattr("strands.retry.backoff.random.random", Mock(return_value=0.5))

    assert LinearBackoff(base_delay=0.1).next_delay(_context(attempt=4)) == pytest.approx(0.2)


def test_exponential_backoff_grows_with_multiplier_and_caps():
    backoff = ExponentialBackoff(base_delay=0.1, max_delay=0.5, multiplier=3, jitter="none")

    tru_delays = [backoff.next_delay(_context(attempt=attempt)) for attempt in (1, 2, 3, 10_000)]
    exp_delays = [0.1, 0.3, 0.5, 0.5]
    assert tru_delays == pytest.approx(exp_delays)


@pytest.mark.parametrize(
    "jitter,last_delay,max_delay,expected",
    [
        ("none", None, 0.5, 0.2),
        ("full", None, 0.5, 0.1),
        ("equal", None, 0.5, 0.15),
        ("decorrelated", None, 0.5, 0.1),
        ("decorrelated", 0.2, 1.0, 0.35),
        ("decorrelated", 1.0, 0.5, 0.3),
        ("decorrelated", 0.01, 0.5, 0.1),
    ],
)
def test_exponential_backoff_applies_jitter(monkeypatch, jitter, last_delay, max_delay, expected):
    monkeypatch.setattr("strands.retry.backoff.random.random", Mock(return_value=0.5))
    backoff = ExponentialBackoff(base_delay=0.1, max_delay=max_delay, jitter=jitter)

    assert backoff.next_delay(_context(attempt=2, last_delay=last_delay)) == pytest.approx(expected)

"""Unit tests for retry backoff strategies.

Parity cases mirror strands-ts/src/retry/__tests__/backoff-strategy.test.ts.
"""

from unittest.mock import Mock

import pytest

from strands.retry import BackoffContext, ConstantBackoff, ExponentialBackoff, LinearBackoff


def _context(*, attempt: int = 1, last_delay: float | None = None) -> BackoffContext:
    return BackoffContext(attempt=attempt, elapsed_time=0, last_delay=last_delay)


# ConstantBackoff parity cases


def test_constant_backoff_returns_configured_delay_regardless_of_attempt():
    backoff = ConstantBackoff(delay=0.25)

    assert backoff.next_delay(_context(attempt=1)) == 0.25
    assert backoff.next_delay(_context(attempt=5)) == 0.25


def test_constant_backoff_uses_default_delay():
    assert ConstantBackoff().next_delay(_context()) == 1


def test_constant_backoff_rejects_attempts_below_one():
    with pytest.raises(ValueError, match="attempt must be an integer >= 1"):
        ConstantBackoff().next_delay(_context(attempt=0))


# LinearBackoff parity cases


def test_linear_backoff_grows_as_base_delay_times_attempt():
    backoff = LinearBackoff(base_delay=0.1, jitter="none")

    assert backoff.next_delay(_context(attempt=1)) == pytest.approx(0.1)
    assert backoff.next_delay(_context(attempt=2)) == pytest.approx(0.2)
    assert backoff.next_delay(_context(attempt=3)) == pytest.approx(0.3)


def test_linear_backoff_clamps_to_max_delay_before_jitter():
    backoff = LinearBackoff(base_delay=1, max_delay=2.5, jitter="none")

    assert backoff.next_delay(_context(attempt=10)) == 2.5


def test_linear_backoff_applies_full_jitter_by_default(monkeypatch):
    monkeypatch.setattr("strands.retry.backoff.random.random", Mock(return_value=0.5))

    assert LinearBackoff(base_delay=0.1).next_delay(_context(attempt=4)) == pytest.approx(0.2)


def test_linear_backoff_rejects_attempts_below_one():
    with pytest.raises(ValueError, match="attempt must be an integer >= 1"):
        LinearBackoff().next_delay(_context(attempt=0))


# ExponentialBackoff parity cases


def test_exponential_backoff_grows_as_base_delay_times_multiplier_to_attempt_minus_one():
    backoff = ExponentialBackoff(base_delay=0.1, jitter="none")

    assert backoff.next_delay(_context(attempt=1)) == pytest.approx(0.1)
    assert backoff.next_delay(_context(attempt=2)) == pytest.approx(0.2)
    assert backoff.next_delay(_context(attempt=3)) == pytest.approx(0.4)
    assert backoff.next_delay(_context(attempt=4)) == pytest.approx(0.8)


def test_exponential_backoff_honors_custom_multiplier():
    backoff = ExponentialBackoff(base_delay=0.1, multiplier=3, jitter="none")

    assert backoff.next_delay(_context(attempt=3)) == pytest.approx(0.9)


def test_exponential_backoff_clamps_to_max_delay():
    backoff = ExponentialBackoff(base_delay=0.1, max_delay=0.5, jitter="none")

    assert backoff.next_delay(_context(attempt=10)) == 0.5


def test_exponential_backoff_applies_full_jitter_by_default(monkeypatch):
    monkeypatch.setattr("strands.retry.backoff.random.random", Mock(return_value=0.5))
    backoff = ExponentialBackoff(base_delay=0.1)

    assert backoff.next_delay(_context(attempt=3)) == pytest.approx(0.2)


def test_exponential_backoff_applies_equal_jitter(monkeypatch):
    monkeypatch.setattr("strands.retry.backoff.random.random", Mock(return_value=0.5))
    backoff = ExponentialBackoff(base_delay=0.1, jitter="equal")

    assert backoff.next_delay(_context(attempt=2)) == pytest.approx(0.15)


def test_exponential_backoff_applies_no_jitter_when_set_to_none():
    backoff = ExponentialBackoff(base_delay=0.1, jitter="none")

    assert backoff.next_delay(_context(attempt=3)) == pytest.approx(0.4)


def test_exponential_backoff_falls_back_to_full_jitter_when_last_delay_is_missing(monkeypatch):
    monkeypatch.setattr("strands.retry.backoff.random.random", Mock(return_value=0.5))
    backoff = ExponentialBackoff(base_delay=0.1, jitter="decorrelated")

    assert backoff.next_delay(_context(attempt=3)) == pytest.approx(0.2)


def test_exponential_backoff_applies_decorrelated_jitter(monkeypatch):
    monkeypatch.setattr("strands.retry.backoff.random.random", Mock(return_value=0.5))
    backoff = ExponentialBackoff(base_delay=0.1, max_delay=10, jitter="decorrelated")

    assert backoff.next_delay(_context(attempt=2, last_delay=0.2)) == pytest.approx(0.35)


def test_exponential_backoff_caps_decorrelated_upper_at_max_delay(monkeypatch):
    monkeypatch.setattr("strands.retry.backoff.random.random", Mock(return_value=0.5))
    backoff = ExponentialBackoff(base_delay=0.1, max_delay=0.5, jitter="decorrelated")

    assert backoff.next_delay(_context(attempt=2, last_delay=1)) == pytest.approx(0.3)


def test_exponential_backoff_floors_decorrelated_upper_at_base_delay(monkeypatch):
    monkeypatch.setattr("strands.retry.backoff.random.random", Mock(return_value=0.5))
    backoff = ExponentialBackoff(base_delay=0.1, max_delay=0.5, jitter="decorrelated")

    assert backoff.next_delay(_context(attempt=2, last_delay=0.01)) == pytest.approx(0.1)


def test_exponential_backoff_rejects_attempts_below_one():
    with pytest.raises(ValueError, match="attempt must be an integer >= 1"):
        ExponentialBackoff().next_delay(_context(attempt=0))


def test_exponential_backoff_rejects_non_integer_attempts():
    with pytest.raises(ValueError, match="attempt must be an integer >= 1"):
        ExponentialBackoff().next_delay(_context(attempt=1.5))


# Python-specific hardening cases


def test_exponential_backoff_rejects_negative_attempts():
    with pytest.raises(ValueError, match="attempt must be an integer >= 1"):
        ExponentialBackoff().next_delay(_context(attempt=-1))


def test_exponential_backoff_rejects_boolean_attempts():
    with pytest.raises(ValueError, match="attempt must be an integer >= 1"):
        ExponentialBackoff().next_delay(_context(attempt=True))


def test_exponential_backoff_caps_very_large_attempt_without_overflow():
    backoff = ExponentialBackoff(base_delay=0.1, max_delay=0.5, multiplier=3, jitter="none")

    assert backoff.next_delay(_context(attempt=10_000)) == 0.5

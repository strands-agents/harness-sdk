from unittest.mock import patch

import pytest

from strands.retry import BackoffContext, ConstantBackoff, ExponentialBackoff, LinearBackoff


@pytest.fixture
def random_value():
    with patch("strands.retry.backoff_strategy.random.random", return_value=0.5) as mock:
        yield mock


def _delays(backoff, attempts):
    return [backoff.next_delay(BackoffContext(attempt=attempt, elapsed=0)) for attempt in attempts]


def test_constant_backoff_returns_same_delay():
    assert _delays(ConstantBackoff(delay=2.5), [1, 2, 10]) == [2.5, 2.5, 2.5]


def test_constant_backoff_defaults_to_one_second():
    assert _delays(ConstantBackoff(), [1]) == [1]


def test_linear_backoff_grows_linearly_and_caps():
    backoff = LinearBackoff(base_delay=2, max_delay=7, jitter="none")

    assert _delays(backoff, [1, 2, 3, 4]) == [2, 4, 6, 7]


def test_exponential_backoff_grows_exponentially_and_caps():
    backoff = ExponentialBackoff(base_delay=1, max_delay=10, multiplier=3, jitter="none")

    assert _delays(backoff, [1, 2, 3, 4]) == [1, 3, 9, 10]


def test_exponential_backoff_defaults_to_doubling_with_cap():
    backoff = ExponentialBackoff(jitter="none")

    assert _delays(backoff, [1, 2, 5, 6, 7]) == [1, 2, 16, 30, 30]


@pytest.mark.parametrize(
    ("jitter", "exp_delay"),
    [
        ("none", 8),
        ("full", 4),  # 0.5 * 8
        ("equal", 6),  # 8/2 + 0.5 * 8/2
        ("decorrelated", 4),  # no last_delay: falls back to full
    ],
)
def test_jitter_modes(random_value, jitter, exp_delay):
    backoff = ExponentialBackoff(base_delay=2, max_delay=100, jitter=jitter)

    assert backoff.next_delay(BackoffContext(attempt=3, elapsed=0)) == exp_delay


def test_decorrelated_jitter_samples_between_base_and_three_times_last_delay(random_value):
    backoff = ExponentialBackoff(base_delay=2, max_delay=100, jitter="decorrelated")

    # uniform(2, 10 * 3) at 0.5
    assert backoff.next_delay(BackoffContext(attempt=2, elapsed=0, last_delay=10)) == 16


def test_decorrelated_jitter_caps_upper_bound_at_max_delay(random_value):
    backoff = LinearBackoff(base_delay=2, max_delay=12, jitter="decorrelated")

    # uniform(2, min(12, 30)) at 0.5
    assert backoff.next_delay(BackoffContext(attempt=2, elapsed=0, last_delay=10)) == 7


def test_decorrelated_jitter_with_max_below_base_returns_base(random_value):
    backoff = ExponentialBackoff(base_delay=5, max_delay=1, jitter="decorrelated")

    assert backoff.next_delay(BackoffContext(attempt=2, elapsed=0, last_delay=1)) == 5


def test_jitter_defaults_to_full(random_value):
    assert _delays(LinearBackoff(base_delay=4), [1]) == [2]
    assert _delays(ExponentialBackoff(base_delay=4), [1]) == [2]


@pytest.mark.parametrize("backoff_class", [LinearBackoff, ExponentialBackoff])
def test_invalid_jitter_raises(backoff_class):
    with pytest.raises(ValueError, match=f"{backoff_class.__name__}: jitter must be one of"):
        backoff_class(jitter="ful")


@pytest.mark.parametrize("backoff", [ConstantBackoff(), LinearBackoff(), ExponentialBackoff()])
@pytest.mark.parametrize("attempt", [0, -1, 1.5, True])
def test_invalid_attempt_raises(backoff, attempt):
    with pytest.raises(ValueError, match="attempt must be an integer >= 1"):
        backoff.next_delay(BackoffContext(attempt=attempt, elapsed=0))

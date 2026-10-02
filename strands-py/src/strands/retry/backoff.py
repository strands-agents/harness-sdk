"""Backoff strategies for computing delays between retry attempts."""

import random
from dataclasses import dataclass
from typing import Literal, Protocol, TypeAlias

JitterKind: TypeAlias = Literal["none", "full", "equal", "decorrelated"]


@dataclass(frozen=True)
class BackoffContext:
    """State supplied to a backoff strategy for one retry decision.

    Attributes:
        attempt: One-based index of the model attempt that failed.
        elapsed_time: Seconds elapsed since the first failure in this retry budget.
        last_delay: Previously computed delay in seconds, if one exists.
    """

    attempt: int
    elapsed_time: float
    last_delay: float | None = None


class BackoffStrategy(Protocol):
    """Compute the delay before the next retry attempt."""

    def next_delay(self, context: BackoffContext) -> float:
        """Return a non-negative delay in seconds.

        Args:
            context: State for the retry decision.

        Returns:
            Delay in seconds before the next attempt.
        """
        ...


def _validate_attempt(attempt: int, class_name: str) -> None:
    if isinstance(attempt, bool) or not isinstance(attempt, int) or attempt < 1:
        raise ValueError(f"{class_name}: attempt must be an integer >= 1 (got {attempt})")


def _jitter(
    raw_delay: float,
    kind: JitterKind,
    base_delay: float,
    max_delay: float,
    last_delay: float | None,
) -> float:
    if kind == "none":
        return raw_delay
    if kind == "full":
        return random.random() * raw_delay
    if kind == "equal":
        return raw_delay / 2 + random.random() * (raw_delay / 2)
    if last_delay is None:
        return random.random() * raw_delay

    upper = max(base_delay, min(max_delay, last_delay * 3))
    return base_delay + random.random() * (upper - base_delay)


class ConstantBackoff:
    """Return the same delay for every retry.

    Args:
        delay: Delay in seconds. Defaults to 1.
    """

    def __init__(self, *, delay: float = 1) -> None:
        """Initialize constant backoff.

        Args:
            delay: Delay in seconds. Defaults to 1.
        """
        self._delay = delay

    def next_delay(self, context: BackoffContext) -> float:
        """Return the configured delay.

        Args:
            context: State for the retry decision.

        Returns:
            The configured delay in seconds.
        """
        _validate_attempt(context.attempt, type(self).__name__)
        return self._delay


class LinearBackoff:
    """Increase the delay linearly, cap it, then apply jitter.

    Args:
        base_delay: Base delay in seconds. Defaults to 1.
        max_delay: Maximum delay before jitter. Defaults to 30.
        jitter: Jitter algorithm. Defaults to ``"full"``.
    """

    def __init__(
        self,
        *,
        base_delay: float = 1,
        max_delay: float = 30,
        jitter: JitterKind = "full",
    ) -> None:
        """Initialize linear backoff.

        Args:
            base_delay: Base delay in seconds. Defaults to 1.
            max_delay: Maximum delay before jitter. Defaults to 30.
            jitter: Jitter algorithm. Defaults to ``"full"``.
        """
        self._base_delay = base_delay
        self._max_delay = max_delay
        self._jitter = jitter

    def next_delay(self, context: BackoffContext) -> float:
        """Return ``base_delay * attempt``, capped and jittered.

        Args:
            context: State for the retry decision.

        Returns:
            Delay in seconds before the next attempt.
        """
        _validate_attempt(context.attempt, type(self).__name__)
        raw_delay = min(self._max_delay, self._base_delay * context.attempt)
        return _jitter(raw_delay, self._jitter, self._base_delay, self._max_delay, context.last_delay)


class ExponentialBackoff:
    """Increase the delay exponentially, cap it, then apply jitter.

    Args:
        base_delay: Base delay in seconds. Defaults to 1.
        max_delay: Maximum delay before jitter. Defaults to 30.
        multiplier: Growth factor per attempt. Defaults to 2.
        jitter: Jitter algorithm. Defaults to ``"full"``.
    """

    def __init__(
        self,
        *,
        base_delay: float = 1,
        max_delay: float = 30,
        multiplier: float = 2,
        jitter: JitterKind = "full",
    ) -> None:
        """Initialize exponential backoff.

        Args:
            base_delay: Base delay in seconds. Defaults to 1.
            max_delay: Maximum delay before jitter. Defaults to 30.
            multiplier: Growth factor per attempt. Defaults to 2.
            jitter: Jitter algorithm. Defaults to ``"full"``.
        """
        self._base_delay = base_delay
        self._max_delay = max_delay
        self._multiplier = multiplier
        self._jitter = jitter

    def next_delay(self, context: BackoffContext) -> float:
        """Return exponential delay capped and jittered.

        Args:
            context: State for the retry decision.

        Returns:
            Delay in seconds before the next attempt.
        """
        _validate_attempt(context.attempt, type(self).__name__)
        try:
            raw_delay = self._base_delay * self._multiplier ** (context.attempt - 1)
        except OverflowError:
            raw_delay = self._max_delay
        raw_delay = min(self._max_delay, raw_delay)
        return _jitter(raw_delay, self._jitter, self._base_delay, self._max_delay, context.last_delay)

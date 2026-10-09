"""Backoff strategies for computing delay between retry attempts.

A ``BackoffStrategy`` is pure delay math: given a ``BackoffContext``, it returns how long to wait before the
next attempt. Policy concerns (whether to retry, max attempts, time budgets) live in the retry strategy, not here.
"""

import random
from dataclasses import dataclass
from typing import Literal, Protocol, get_args

JitterKind = Literal["none", "full", "equal", "decorrelated"]
"""Supported jitter modes.

- ``none``: return the raw delay unchanged
- ``full``: uniform random in ``[0, raw]``
- ``equal``: ``raw/2 + uniform(0, raw/2)`` (half fixed, half random)
- ``decorrelated``: ``uniform(base_delay, last_delay * 3)``, capped at ``max_delay``; falls back to ``full`` on the
  first retry when ``last_delay`` is unavailable

For jitter outside these modes, implement ``BackoffStrategy`` directly.
"""

_JITTER_KINDS: tuple[str, ...] = get_args(JitterKind)


@dataclass(frozen=True, kw_only=True)
class BackoffContext:
    """Context passed to a ``BackoffStrategy`` for each retry decision.

    Treated as an additive-only contract: new optional fields may be added over time, but existing fields will not
    be removed or repurposed.

    Attributes:
        attempt: 1-based index of the attempt that just failed.
        elapsed: Seconds elapsed since the first retryable failure in the current retry budget.
        last_delay: Previously computed delay in seconds. None before the first retry.
    """

    attempt: int
    elapsed: float
    last_delay: float | None = None


class BackoffStrategy(Protocol):
    """Computes the delay before the next retry attempt."""

    def next_delay(self, context: BackoffContext) -> float:
        """Return the delay in seconds before the next attempt.

        Must be a non-negative finite number. Implementations should treat ``context.attempt < 1`` as a programmer
        error.

        Args:
            context: State for the current retry decision.

        Returns:
            Delay in seconds.
        """
        ...


def _validate_attempt(attempt: int, class_name: str) -> None:
    if isinstance(attempt, bool) or not isinstance(attempt, int) or attempt < 1:
        raise ValueError(f"{class_name}: attempt must be an integer >= 1 (got {attempt!r})")


def _validate_jitter(jitter: str, class_name: str) -> None:
    if jitter not in _JITTER_KINDS:
        raise ValueError(f"{class_name}: jitter must be one of {_JITTER_KINDS} (got {jitter!r})")


def _jitter(raw: float, kind: JitterKind, base_delay: float, max_delay: float, last_delay: float | None) -> float:
    if kind == "none":
        return raw
    if kind == "full":
        return random.random() * raw
    if kind == "equal":
        return raw / 2 + random.random() * (raw / 2)
    if last_delay is None:
        return random.random() * raw
    # max() guards against an inverted range when max_delay < base_delay.
    upper = max(base_delay, min(max_delay, last_delay * 3))
    return base_delay + random.random() * (upper - base_delay)


class ConstantBackoff:
    """Constant backoff: returns the same delay for every retry."""

    def __init__(self, *, delay: float = 1) -> None:
        """Initialize the backoff.

        Args:
            delay: Delay in seconds returned for every retry. Defaults to 1.
        """
        self._delay = delay

    def next_delay(self, context: BackoffContext) -> float:
        """Return the configured delay.

        Args:
            context: State for the current retry decision.

        Returns:
            Delay in seconds.
        """
        _validate_attempt(context.attempt, type(self).__name__)
        return self._delay


class LinearBackoff:
    """Linear backoff: delay grows as ``base_delay * attempt``, capped at ``max_delay``, then jittered."""

    def __init__(self, *, base_delay: float = 1, max_delay: float = 30, jitter: JitterKind = "full") -> None:
        """Initialize the backoff.

        Args:
            base_delay: Base delay in seconds. Defaults to 1.
            max_delay: Upper bound in seconds applied before jitter. Defaults to 30.
            jitter: Jitter mode. Defaults to ``"full"``.

        Raises:
            ValueError: If ``jitter`` is not a supported mode.
        """
        _validate_jitter(jitter, type(self).__name__)
        self._base_delay = base_delay
        self._max_delay = max_delay
        self._jitter: JitterKind = jitter

    def next_delay(self, context: BackoffContext) -> float:
        """Return the linear delay for the attempt.

        Args:
            context: State for the current retry decision.

        Returns:
            Delay in seconds.
        """
        _validate_attempt(context.attempt, type(self).__name__)
        raw = min(self._max_delay, self._base_delay * context.attempt)
        return _jitter(raw, self._jitter, self._base_delay, self._max_delay, context.last_delay)


class ExponentialBackoff:
    """Exponential backoff: delay grows as ``base_delay * multiplier^(attempt-1)``, capped at ``max_delay``.

    The capped delay is then jittered.
    """

    def __init__(
        self,
        *,
        base_delay: float = 1,
        max_delay: float = 30,
        multiplier: float = 2,
        jitter: JitterKind = "full",
    ) -> None:
        """Initialize the backoff.

        Args:
            base_delay: Base delay in seconds. Defaults to 1.
            max_delay: Upper bound in seconds applied before jitter. Defaults to 30.
            multiplier: Growth factor per attempt. Defaults to 2.
            jitter: Jitter mode. Defaults to ``"full"``.

        Raises:
            ValueError: If ``jitter`` is not a supported mode.
        """
        _validate_jitter(jitter, type(self).__name__)
        self._base_delay = base_delay
        self._max_delay = max_delay
        self._multiplier = multiplier
        self._jitter: JitterKind = jitter

    def next_delay(self, context: BackoffContext) -> float:
        """Return the exponential delay for the attempt.

        Args:
            context: State for the current retry decision.

        Returns:
            Delay in seconds.
        """
        _validate_attempt(context.attempt, type(self).__name__)
        raw = min(self._max_delay, self._base_delay * self._multiplier ** (context.attempt - 1))
        return _jitter(raw, self._jitter, self._base_delay, self._max_delay, context.last_delay)

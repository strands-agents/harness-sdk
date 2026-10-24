"""The default routing strategy: ordered failover that prefers the candidates failing least."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from math import isfinite
from typing import TYPE_CHECKING, Any, cast

from ...types.exceptions import ContextWindowOverflowException
from .strategy import RoutingContext, _attempts_since_success

if TYPE_CHECKING:
    from .router import RoutingCandidate


class FallbackStrategy:
    """Picks the healthiest candidate not yet tried since the last success.

    Candidates already tried since the last success are excluded, then the fewest recorded failures
    wins, ties going to the earlier declaration. So an invocation with no failures behind it is plain
    declaration order, and a model that keeps failing sinks below healthier ones rather than being
    re-tried in its declared slot.

    A success re-arms every candidate, since exclusion looks only at attempts since the last success, and
    clears the succeeding candidate's own failure count. Every other candidate keeps its failure history,
    so a model that fails repeatedly stays below healthier ones across successes. Returns ``None`` once
    every candidate has been tried since the last success.
    """

    def __init__(
        self,
        *,
        fail_over_on: type[Exception] | tuple[type[Exception], ...] | Callable[[Exception], bool] | None = None,
        cooldown: float = 0.0,
    ) -> None:
        """Configure selective failover and cross-invocation candidate cooldowns.

        Args:
            fail_over_on: Exception types or predicate that permit failover. ``None`` preserves the
                existing behavior of failing over on every unclaimed exception.
            cooldown: Seconds to skip a candidate after it causes failover. Zero disables cooldowns.

        Raises:
            TypeError: If ``fail_over_on`` is not exception types, a predicate, or ``None``.
            ValueError: If ``cooldown`` is negative.
        """
        if not isfinite(cooldown) or cooldown < 0:
            raise ValueError("cooldown must be a finite number greater than or equal to zero")
        if (
            fail_over_on is not None
            and not _exception_types(fail_over_on)
            and (isinstance(fail_over_on, type) or not callable(fail_over_on))
        ):
            raise TypeError("fail_over_on must be exception types, a predicate, or None")
        self._fail_over_on = fail_over_on
        self._cooldown = cooldown
        self._cool_until: dict[int, float] = {}
        self._lock = threading.Lock()

    async def select(self, context: RoutingContext, **kwargs: Any) -> RoutingCandidate | None:
        """Return the healthiest eligible candidate, or ``None`` when failover should stop."""
        latest = context.attempts[-1] if context.attempts else None
        if latest is not None and latest.exception is not None:
            if not self._should_fail_over(latest.exception):
                return None
            if self._cooldown and not isinstance(latest.exception, ContextWindowOverflowException):
                with self._lock:
                    self._cool_until[id(latest.candidate)] = time.monotonic() + self._cooldown

        failures: dict[int, int] = {}
        for attempt in context.attempts:
            if attempt.exception is None:
                failures.pop(id(attempt.candidate), None)
            else:
                failures[id(attempt.candidate)] = failures.get(id(attempt.candidate), 0) + 1

        tried_now = {id(attempt.candidate) for attempt in _attempts_since_success(context.attempts)}
        available = [candidate for candidate in context.candidates if id(candidate) not in tried_now]
        if not available:
            return None

        if latest is not None and isinstance(latest.exception, ContextWindowOverflowException):
            current_limit = _context_window_limit(latest.candidate)
            available = [candidate for candidate in available if _larger_context(candidate, current_limit)]
            if not available:
                return None

        now = time.monotonic()
        with self._lock:
            cooling = {id(candidate): self._cool_until.get(id(candidate), 0.0) for candidate in available}
            for candidate_id, deadline in cooling.items():
                if deadline <= now:
                    self._cool_until.pop(candidate_id, None)
        ready = [candidate for candidate in available if cooling[id(candidate)] <= now]
        if ready:
            available = ready
        else:
            earliest = min(cooling.values())
            available = [candidate for candidate in available if cooling[id(candidate)] == earliest]

        return min(available, key=lambda candidate: failures.get(id(candidate), 0))

    def _should_fail_over(self, error: Exception) -> bool:
        """Return whether ``error`` is eligible for failover."""
        if self._fail_over_on is None or isinstance(error, ContextWindowOverflowException):
            return True
        fail_over_on = self._fail_over_on
        if _exception_types(fail_over_on):
            return isinstance(error, fail_over_on)
        return cast(Callable[[Exception], bool], fail_over_on)(error)


def _exception_types(value: object) -> bool:
    """Return whether a value is an exception class or non-empty tuple of exception classes."""
    if isinstance(value, type):
        return issubclass(value, Exception)
    return (
        isinstance(value, tuple)
        and bool(value)
        and all(isinstance(item, type) and issubclass(item, Exception) for item in value)
    )


def _context_window_limit(candidate: RoutingCandidate) -> int | None:
    """Resolve a candidate's concrete default context-window limit."""
    model = candidate.model.default_model if hasattr(candidate.model, "default_model") else candidate.model
    return model.context_window_limit


def _larger_context(candidate: RoutingCandidate, current_limit: int | None) -> bool:
    """Return whether a candidate has a known context window larger than the current one."""
    candidate_limit = _context_window_limit(candidate)
    return current_limit is not None and candidate_limit is not None and candidate_limit > current_limit

"""The default routing strategy: ordered failover that prefers the candidates failing least."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

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

    async def select(self, context: RoutingContext, **kwargs: Any) -> RoutingCandidate | None:
        """Return the least-failed candidate not yet tried since the last success, else ``None``."""
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
        return min(available, key=lambda candidate: failures.get(id(candidate), 0))

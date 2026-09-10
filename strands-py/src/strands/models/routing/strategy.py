"""Routing strategy protocol, the attempt record it sees, and the context passed to it.

A ``RoutingStrategy`` decides which candidate an invocation uses. ``ModelRouter`` asks it for a
candidate before the first model call and again after a failed call, passing the attempts made so
far, so every routing decision -- initial choice, whether to fail over, and to what -- belongs to the
strategy. The router only orchestrates: it resolves the candidate, applies it to the call, manages
retry budgets and invocation state, and stops when the strategy has no further candidate.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

if TYPE_CHECKING:
    from ...agent.agent import Agent
    from ...types.content import Messages, SystemPrompt
    from ...types.tools import ToolSpec
    from .router import RoutingCandidate


@dataclass(frozen=True)
class RoutingAttempt:
    """A candidate this invocation already used, and how the attempt ended.

    ``candidate`` is the instance from ``RoutingContext.candidates``, not a copy. ``exception`` is
    ``None`` when the call succeeded, and otherwise is the model's error as ``AfterModelCallEvent``
    reports it, or the error raised while resolving a candidate that never produced a model. Attempts
    are in chronological order, so a strategy can tell a first failure from a repeated one and treat a
    candidate that recovered as healthy.
    """

    candidate: RoutingCandidate
    exception: Exception | None = None


@dataclass(frozen=True)
class RoutingContext:
    """Read-only inputs a strategy sees when choosing a candidate.

    ``messages``, ``system_prompt``, and ``tool_specs`` are fresh deep copies per ask, so mutating them
    changes nothing outside the ask and their object identity is not stable across asks. One failure can
    bring more than one ask, so that copy is paid per ask rather than per failure. ``candidates``
    and the ``candidate`` on each ``RoutingAttempt`` are the router's own instances and are stable for the
    router's lifetime, so a strategy may correlate attempts with candidates by identity.

    ``invocation_state`` is the live dict rather than a copy, and is read-only to a strategy: it is typed
    ``Mapping`` because writes would reach the agent's own state and the router's, which keeps its
    per-invocation state there under a ``strands:model_routing`` key. In a multi-agent run it may be
    shared across nodes, so its ``"agent"`` value may identify a sibling.

    A strategy is asked on every invocation, since the right model usually depends on the request. One
    that is expensive to evaluate should narrow what it looks at -- typically the latest turn rather
    than the whole transcript -- instead of caching a verdict across invocations.
    """

    messages: Messages
    system_prompt: SystemPrompt | None
    tool_specs: Sequence[ToolSpec]
    candidates: Sequence[RoutingCandidate]
    invocation_state: Mapping[str, Any]
    attempts: Sequence[RoutingAttempt] = field(default_factory=tuple)
    # SDK-internal owner handle for hook/metrics attribution; not part of the strategy
    # contract (invocation_state["agent"] may name a sibling in multi-agent runs).
    _agent: Agent | None = field(default=None, repr=False, compare=False)


@runtime_checkable
class RoutingStrategy(Protocol):
    """Chooses the candidate an invocation uses, including after a failure.

    ``ModelRouter`` requires only ``select``, so members added here later stay optional for
    strategies already written against this protocol.
    """

    async def select(self, context: RoutingContext, **kwargs: Any) -> RoutingCandidate | None:
        """Return the candidate to use, from ``context.candidates``, or ``None`` to decline.

        Asked once before the first model call, when ``context.attempts`` is empty, and again after each
        failed call with that failure appended to ``attempts``.

        The return value must be one of the ``context.candidates`` instances -- the router matches by
        identity, so an equal-looking ``RoutingCandidate`` built here is rejected.

        ``None`` declines: the opening ask then serves the request on the router's default model, and a
        later ask ends routing so the model's error surfaces. Raising, or returning anything that is not
        one of ``context.candidates``, propagates on the opening ask and ends routing after a failure,
        where the pending model error stays the one that surfaces. A strategy that prefers a default to
        an error should return one.

        A failure round uses each candidate at most once, where a round is the run of failures since the
        last success, and the candidate the round opens on already counts as used -- the opening choice,
        or the one that last succeeded. Naming a candidate the round already used ends routing exactly as
        ``None`` would, so a strategy that judges a failure transient should offer a different candidate
        and wait for the next success to re-arm this one. All of this is predictable from
        ``context.attempts``.

        One failure can bring more than one ask: naming a candidate the router cannot resolve to a model
        records that attempt, uses up the candidate, and asks again, so a round ends once every candidate
        is used rather than on the first answer it cannot apply.

        Failover is this method's job: the router applies what is returned and never substitutes a
        candidate of its own, so a strategy that ignores ``context.attempts`` gets no failover. Wrap or
        delegate to ``FallbackStrategy`` to get it.
        """
        ...


def _attempts_since_success(attempts: Sequence[RoutingAttempt]) -> Sequence[RoutingAttempt]:
    """Return the trailing attempts that all failed, dropping everything up to the last success."""
    for index in range(len(attempts) - 1, -1, -1):
        if attempts[index].exception is None:
            return attempts[index + 1 :]
    return attempts

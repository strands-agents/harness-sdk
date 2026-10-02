"""Graph edge conditions that route on a DecisionAgent node's recorded decision."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Protocol

from ._agent import DECISION_STATE_KEY
from ._types import Answer, ChoiceAnswer, Decision, YesNoAnswer

if TYPE_CHECKING:
    from ...multiagent.graph import GraphState


class DecisionEdgeCondition(Protocol):
    """A graph edge condition over a node's decision; receives ``invocation_state`` like any context condition."""

    def __call__(self, state: GraphState, *, invocation_state: dict[str, Any], **kwargs: Any) -> bool:
        """Return whether the edge should be traversed."""
        ...


def _decision(state: GraphState, node_id: str) -> Decision[Any] | None:
    node_result = state.results.get(node_id)
    agent_result = getattr(node_result, "result", None)
    node_state = getattr(agent_result, "state", None)
    decision = node_state.get(DECISION_STATE_KEY) if isinstance(node_state, dict) else None
    return decision if isinstance(decision, Decision) else None


def _answer(state: GraphState, node_id: str, field: str) -> Answer | None:
    decision = _decision(state, node_id)
    return decision.answers.get(field) if decision is not None else None


def when_choice(node_id: str, field: str, option: str, *, min_confidence: float | None = None) -> DecisionEdgeCondition:
    """Traverse when ``node_id`` chose ``option`` for ``field`` (and, if given, at or above ``min_confidence``).

    Not traversed when the node has not produced a decision.
    """

    def condition(state: GraphState, *, invocation_state: dict[str, Any], **kwargs: Any) -> bool:
        answer = _answer(state, node_id, field)
        if not isinstance(answer, ChoiceAnswer) or answer.choice != option:
            return False
        return min_confidence is None or (answer.confidence or 0.0) >= min_confidence

    return condition


def when_yes(node_id: str, field: str, *, threshold: float = 0.5) -> DecisionEdgeCondition:
    """Traverse when ``node_id``'s YesNo answer for ``field`` is at or above ``threshold``."""

    def condition(state: GraphState, *, invocation_state: dict[str, Any], **kwargs: Any) -> bool:
        answer = _answer(state, node_id, field)
        return isinstance(answer, YesNoAnswer) and answer.probability >= threshold

    return condition


def when_below(node_id: str, field: str, confidence: float) -> DecisionEdgeCondition:
    """Traverse when ``node_id`` is unsure about ``field``: confidence below ``confidence``, or unknown.

    Also traversed when the node produced no decision, so a fallback edge (for example to a person or a
    reasoning agent) fires rather than the graph silently stalling.
    """

    def condition(state: GraphState, *, invocation_state: dict[str, Any], **kwargs: Any) -> bool:
        answer = _answer(state, node_id, field)
        if answer is None or answer.confidence is None:
            return True
        return answer.confidence < confidence

    return condition

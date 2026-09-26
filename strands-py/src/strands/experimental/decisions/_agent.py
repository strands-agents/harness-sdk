"""DecisionAgent: a System One model as an agent, a front door, or a graph routing node."""

from __future__ import annotations

import inspect
import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from typing import Any, Generic, TypeAlias, TypeVar

from pydantic import BaseModel

from ..._async import run_async
from ...agent.agent_result import AgentResult
from ...agent.base import AgentBase
from ...telemetry.metrics import EventLoopMetrics
from ...types.agent import AgentInput
from ._model import DecisionModel
from ._schema import NO_MATCH_OPTION, compile_schema
from ._strategy import _require_calibrated
from ._types import Choice, ChoiceAnswer, Decision, DecisionState, ScoreAnswer, YesNoAnswer

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

RouteHandler: TypeAlias = Callable[[Decision[Any], AgentInput], "str | AgentResult | Awaitable[str | AgentResult]"]
"""A code route: receives the decision and the original prompt; returns reply text or an AgentResult."""

Route: TypeAlias = "AgentBase | RouteHandler"
StateBuilder: TypeAlias = Callable[[AgentInput], DecisionState]

DECISION_STATE_KEY = "decision"
"""Key under which every result's ``state`` carries the ``Decision`` (graph edge helpers read it)."""


class DecisionAgent(Generic[T]):
    """Decide with a System One model, optionally routing the input to a handler per choice.

    Implements ``AgentBase``, so it can be a ``Graph`` node, an A2A-served agent, or the entry point that sees
    external input first. Without ``routes`` it returns the decision: ``structured_output`` is the schema
    instance and ``state["decision"]`` the full ``Decision``. With ``routes`` it dispatches on the ``route_on``
    field and returns the route's result; the decision is still on ``state["decision"]``.

    Low confidence or the no-match option of an optional ``Choice`` go to ``fallback`` (typically a reasoning
    agent) when set, and otherwise raise, so an uncertain decision is never silently acted on. A failed
    decision goes to ``fallback`` only when it is an agent (a callable route needs a decision); otherwise the
    error propagates.
    """

    def __init__(
        self,
        model: DecisionModel,
        schema: type[T],
        *,
        route_on: str | None = None,
        routes: Mapping[str, Route] | None = None,
        min_confidence: float | None = None,
        fallback: Route | None = None,
        state_builder: StateBuilder | None = None,
        name: str = "decision_agent",
        description: str | None = None,
    ) -> None:
        """Initialize the agent.

        Args:
            model: The decision model.
            schema: The decision schema (see ``DecisionModel.decide``).
            route_on: Name of a ``Choice`` field of ``schema`` to dispatch on. Required with ``routes``.
            routes: Handler per option of ``route_on``: an agent (invoked with the original prompt) or a
                callable ``(decision, prompt) -> str | AgentResult`` (sync or async).
            min_confidence: Below this confidence on ``route_on`` the input goes to ``fallback``. Requires a
                calibrated model.
            fallback: Handles low-confidence, no-match, and failed decisions. Without it those raise.
            state_builder: Builds the decision state from the prompt. Defaults to the prompt's text.
            name: Agent name (used as the graph node id when none is given).
            description: Agent description.

        Raises:
            TypeError: If ``schema`` cannot be compiled.
            ValueError: If ``route_on``/``routes`` are inconsistent, an option is unrouted, or ``min_confidence``
                is set on an uncalibrated model.
        """
        self._compiled = compile_schema(schema)
        _require_calibrated("DecisionAgent", model, min_confidence)
        _validate_routes(self._compiled.questions, schema.__name__, route_on, routes, min_confidence)
        self._model = model
        self._schema = schema
        self._route_on = route_on
        self._routes = dict(routes or {})
        self._min_confidence = min_confidence
        self._fallback = fallback
        self._state_builder = state_builder or _prompt_text
        self.name = name
        self.description = description or f"Decides {schema.__name__} with a System One model"

    async def decide(self, prompt: AgentInput) -> Decision[T]:
        """Return the decision for ``prompt`` without routing."""
        return await self._model.decide(self._schema, self._state_builder(prompt))

    async def invoke_async(self, prompt: AgentInput = None, **kwargs: Any) -> AgentResult:
        """Decide, then route; return the final result."""
        result: AgentResult | None = None
        async for event in self.stream_async(prompt, **kwargs):
            if "result" in event:
                result = event["result"]
        assert result is not None
        return result

    def __call__(self, prompt: AgentInput = None, **kwargs: Any) -> AgentResult:
        """Synchronously decide, then route."""
        return run_async(lambda: self.invoke_async(prompt, **kwargs))

    async def stream_async(self, prompt: AgentInput = None, **kwargs: Any) -> AsyncIterator[Any]:
        """Decide, then route, streaming a delegated agent's events; the last event is ``{"result": ...}``."""
        try:
            decision = await self.decide(prompt)
        except Exception as error:
            if not isinstance(self._fallback, AgentBase):
                raise
            logger.warning(
                "agent=<%s>, error_type=<%s> | decision failed, using fallback", self.name, type(error).__name__
            )
            async for event in _run_route(self._fallback, None, prompt, kwargs):
                yield event
            return

        route = self._select_route(decision)
        if route is None:
            yield {"result": _decision_result(decision)}
            return
        async for event in _run_route(route, decision, prompt, kwargs):
            yield event

    def _select_route(self, decision: Decision[T]) -> Route | None:
        """Return the route for ``decision``; None means return the decision itself.

        Raises:
            ValueError: If the decision is uncertain or no-match and there is no fallback.
        """
        if self._route_on is None:
            return None
        answer = decision.answers[self._route_on]
        assert isinstance(answer, ChoiceAnswer)
        problem = _routing_problem(answer, self._min_confidence)
        if problem is None:
            return self._routes[answer.choice]
        if self._fallback is not None:
            logger.debug("agent=<%s>, reason=<%s> | routing to fallback", self.name, problem)
            return self._fallback
        raise ValueError(f"{self.name}: {problem} and no fallback is configured")


def _routing_problem(answer: ChoiceAnswer, min_confidence: float | None) -> str | None:
    if answer.choice == NO_MATCH_OPTION:
        return "no option matched"
    if min_confidence is not None and (answer.confidence or 0.0) < min_confidence:
        return f"confidence {answer.confidence} is below min_confidence {min_confidence} for {answer.choice!r}"
    return None


def _validate_routes(
    questions: Mapping[str, Any],
    schema_name: str,
    route_on: str | None,
    routes: Mapping[str, Route] | None,
    min_confidence: float | None,
) -> None:
    if route_on is None and (routes or min_confidence is not None):
        raise ValueError("routes= and min_confidence= need route_on= naming the Choice field to dispatch on")
    if route_on is None:
        return
    question = questions.get(route_on)
    if not isinstance(question, Choice):
        raise ValueError(f"route_on={route_on!r} must name a Choice field of {schema_name}")
    routable = [option for option in question.options if option != NO_MATCH_OPTION]
    handled = set(routes or {})
    unrouted = [option for option in routable if option not in handled]
    if unrouted:
        raise ValueError(f"routes is missing handlers for {route_on} options {unrouted}")
    unknown = sorted(handled - set(routable))
    if unknown:
        raise ValueError(f"routes has handlers for unknown {route_on} options {unknown}")


def _prompt_text(prompt: AgentInput) -> DecisionState:
    if isinstance(prompt, str):
        return prompt
    if not prompt:
        raise ValueError("DecisionAgent needs a prompt to decide about")
    texts: list[str] = []
    for item in prompt:
        raw: Mapping[str, Any] = item
        blocks = raw.get("content", []) if "role" in raw else [raw]
        texts.extend(block["text"] for block in blocks if isinstance(block.get("text"), str))
    if not texts:
        raise ValueError("DecisionAgent found no text in the prompt; pass state_builder= to build the state")
    return "\n".join(texts)


def _decision_result(decision: Decision[Any]) -> AgentResult:
    return AgentResult(
        stop_reason="end_turn",
        message={"role": "assistant", "content": [{"text": _summary(decision)}]},
        metrics=EventLoopMetrics(),
        state={DECISION_STATE_KEY: decision},
        structured_output=decision.output,
    )


def _summary(decision: Decision[Any]) -> str:
    parts = []
    for field_name, answer in decision.answers.items():
        if isinstance(answer, ChoiceAnswer):
            confidence = "" if answer.confidence is None else f" (confidence {answer.confidence:.2f})"
            parts.append(f"{field_name}: {answer.choice}{confidence}")
        elif isinstance(answer, ScoreAnswer):
            parts.append(f"{field_name}: {answer.score:.2f}")
        elif isinstance(answer, YesNoAnswer):
            parts.append(f"{field_name}: p={answer.probability:.2f}")
    return "; ".join(parts)


async def _run_route(
    route: Route, decision: Decision[Any] | None, prompt: AgentInput, kwargs: Mapping[str, Any]
) -> AsyncIterator[Any]:
    if isinstance(route, AgentBase):
        result: AgentResult | None = None
        async for event in route.stream_async(prompt, **kwargs):
            if "result" in event:
                result = event["result"]
                continue
            yield event
        if result is None:
            raise ValueError(f"route {getattr(route, 'name', route)!r} produced no result")
        yield {"result": _with_decision(result, decision)}
        return
    assert decision is not None, "callable routes only run with a decision"
    value = route(decision, prompt)
    if inspect.isawaitable(value):
        value = await value
    if isinstance(value, AgentResult):
        yield {"result": _with_decision(value, decision)}
        return
    yield {
        "result": AgentResult(
            stop_reason="end_turn",
            message={"role": "assistant", "content": [{"text": str(value)}]},
            metrics=EventLoopMetrics(),
            state={DECISION_STATE_KEY: decision},
        )
    }


def _with_decision(result: AgentResult, decision: Decision[Any] | None) -> AgentResult:
    if decision is not None and isinstance(result.state, dict):
        result.state[DECISION_STATE_KEY] = decision
    return result

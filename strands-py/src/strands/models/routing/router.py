"""ModelRouter: a reusable, immutable set of candidate models with a routing strategy.

A router is a ``Plugin``, so an agent accepts it through ``model=``. Its ``RoutingStrategy`` makes every
routing decision: the router asks for a candidate before the first model call, and again after a call
fails without a hook claiming the retry, passing the attempts so far.

The router orchestrates only. It resolves a candidate to a concrete model, applies it to the call, gives
each new candidate a fresh retry budget, and holds per-invocation state. It has no failover policy, so a
strategy can change routing behavior without changing the router.

The strategy defaults to ``FallbackStrategy``, which makes ``ModelRouter([a, b])`` ordered failover until
a candidate starts failing repeatedly; see ``fallback_strategy`` for what it decides and when it departs
from declaration order. ``max_switches`` caps switches per invocation.

What an answer does depends on whether a failed model call is pending. A candidate is resolved and
applied. ``None`` declines: the opening choice then runs the router's default model, the first declared
candidate resolved without consulting any strategy, and a later decline ends routing so the model's error
surfaces. A strategy that raises propagates on the opening choice and ends routing after a failure, where
the pending model error stays the one that surfaces. A candidate that will not resolve to a model
propagates on the opening choice; after a failure it takes its slot in the round and the strategy is asked
again, so one unusable candidate does not strand the healthy ones declared after it.

A failure round uses each candidate at most once, whether it was switched to or found unusable, so naming
one the round already used ends routing; a success starts a new round on the candidate that succeeded,
which counts as that round's first use just as the opening choice does.

A nested ``ModelRouter`` contributes **one** candidate: it is asked with its own candidates and no
attempts, and performs no internal failover, so when a nested pick fails the outer router moves off the
whole nested candidate rather than advancing within it. A nested strategy that declines serves that
router's default model; one that raises makes that candidate unusable, which propagates on the opening
choice and costs it its slot in the round after a failure.

Known limitation: a model that fails after streaming part of a response has already emitted those
events, so a streaming consumer sees that partial output followed by the replacement's full response.
``AfterModelCallEvent`` documents this for any hook-requested retry; routing reaches it more often
because it advances on any failure the retry strategy declines, not only throttling.

Known limitation: routing applies to ``InvokeModelStage``, so ``agent.model`` stays the first declared
candidate and subsystems reading it reason about that model rather than the one running. Proactive
compression sizes against ``agent.model``'s context window, so routing among candidates with
materially different windows can under-compress and overflow the routed model; the agent span reports
the first candidate's model id; and ``Agent.structured_output()`` calls the model directly, bypassing
routing entirely. Prefer candidates with comparable context windows and tokenizers until the selected
model is threaded to those consumers.
"""

from __future__ import annotations

import copy
import inspect
import json
import logging
from collections.abc import Awaitable, Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any, TypeAlias

from ..._middleware.stages import InvokeModelStage
from ...hooks.events import AfterInvocationEvent, AfterModelCallEvent, BeforeInvocationEvent
from ...hooks.registry import HookOrder
from ...plugins.plugin import Plugin
from ..model import Model
from .fallback_strategy import FallbackStrategy
from .strategy import RoutingAttempt, RoutingContext, RoutingStrategy

if TYPE_CHECKING:
    from ..._middleware.stages import InvokeModelContext
    from ...agent.agent import Agent
    from ...types.content import Messages, SystemPrompt
    from ...types.tools import ToolSpec

logger = logging.getLogger(__name__)


_JSONValue: TypeAlias = str | int | float | bool | None | list["_JSONValue"] | dict[str, "_JSONValue"]


@dataclass(frozen=True)
class RoutingCandidate:
    """A model or model group with optional classifier-facing evidence.

    ``model`` may be a nested ``ModelRouter``, which contributes one opaque candidate. Its strategy selects from its
    own candidates, and the group performs no internal failover. Metadata must be a JSON-serializable mapping;
    classifier-based strategies may send it across provider boundaries, so it must not contain secrets. The candidate
    stores the caller's mapping without copying, so it must not be mutated after construction.

    Raises:
        TypeError: If metadata is not a mapping with string keys.
        ValueError: If metadata is not JSON-serializable.
    """

    model: Model | ModelRouter
    name: str | None = None
    description: str | None = None
    metadata: Mapping[str, _JSONValue] | None = field(default=None, kw_only=True)

    def __post_init__(self) -> None:
        """Validate caller-owned metadata."""
        if self.metadata is None:
            return
        if not isinstance(self.metadata, Mapping):
            raise TypeError("metadata must be a mapping")
        if not all(isinstance(key, str) for key in self.metadata):
            raise TypeError("metadata keys must be strings")
        try:
            json.dumps(self.metadata, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError) as error:
            raise ValueError(f"metadata must be JSON-serializable: {error}") from error


_ROUTING_KEY_PREFIX = "strands:model_routing"


@dataclass
class _RoutingState:
    """Per-invocation routing state for one agent/router pair.

    ``attempts`` is the record the strategy reads to make its next decision; the router appends to it
    but never reads it. ``switched_to`` holds the ids of candidates this failure round has already used,
    which is what bounds the round; a success resets it to the candidate that succeeded, since that
    candidate opens the next round. ``switches`` counts model changes so ``max_switches`` can cap them.
    """

    candidate: RoutingCandidate
    model: Model
    attempts: list[RoutingAttempt] = field(default_factory=list)
    switched_to: set[int] = field(default_factory=set)
    switches: int = 0


class ModelRouter(Plugin):
    """A reusable set of candidate models routed in strategy-defined preference order."""

    name = "strands:model-router"

    def __init__(
        self,
        models: Sequence[CandidateInput],
        *,
        strategy: RoutingStrategy | None = None,
        max_switches: int | None = None,
    ) -> None:
        """Initialize the router.

        Args:
            models: The models to route among, as a sequence. Each is a ``Model``, a nested
                ``ModelRouter``, or a ``RoutingCandidate`` wrapping one with a name, description, and metadata.
                The first is the router's default, used when a strategy declines, and each is normalized into the
                ``RoutingCandidate`` a strategy chooses from.
            strategy: Chooses the candidate for each model call, and is asked again after a failed
                call. Defaults to ``FallbackStrategy``, which prefers the candidate with the fewest
                recorded failures and breaks ties by declaration order, so an invocation with no
                failures behind it is ordered failover. A success re-arms every candidate.
            max_switches: Cap on model switches within one invocation, after which the router stops
                asking and lets the error surface. Selection is asked once per invocation, but every
                failed model call can switch, so an invocation running a long tool loop has many
                chances to switch. Defaults to ``None``, leaving the stop decision to the strategy.

        Raises:
            TypeError: If ``models`` is not a sequence, a candidate is not a ``Model`` or
                ``ModelRouter``, or ``strategy`` does not implement ``RoutingStrategy``.
            ValueError: If ``models`` is empty, candidate names collide, a model is routed to more than
                once -- including through a nested router -- any candidate is a stateful model, or
                ``max_switches`` is negative.
        """
        super().__init__()
        if strategy is not None and not inspect.iscoroutinefunction(getattr(strategy, "select", None)):
            raise TypeError("strategy must implement RoutingStrategy: an async select(context) method")
        if max_switches is not None and max_switches < 0:
            raise ValueError("max_switches must be zero or greater")
        normalized = _normalize(models)
        if not normalized:
            raise ValueError("ModelRouter requires at least one candidate model")
        _reject_stateful(normalized)
        _reject_duplicates(normalized)
        self._candidates = normalized
        self._strategy: RoutingStrategy = strategy or FallbackStrategy()
        self._max_switches = max_switches

    # ---- Configuration ----

    @property
    def candidates(self) -> tuple[RoutingCandidate, ...]:
        """The normalized candidates, in declaration order."""
        return self._candidates

    @property
    def default_model(self) -> Model:
        """The first declared candidate resolved to a concrete model, without consulting a strategy."""
        model = self._candidates[0].model
        if isinstance(model, ModelRouter):
            return model.default_model
        return model

    # ---- Agent integration ----

    def init_agent(self, agent: Agent) -> None:
        """Register routing middleware and hooks; reject attachment through ``plugins=[...]``.

        Args:
            agent: The agent the router is attached to.

        Raises:
            ValueError: If the router was not attached through ``Agent(model=...)``.
        """
        if agent._model_router is not self:
            raise ValueError("ModelRouter must be passed through Agent(model=...), not plugins=[...]")

        agent._middleware_registry.add_middleware(InvokeModelStage.Input, self._selection_middleware())
        # Fallback must see whether ModelRetryStrategy (DEFAULT) already claimed the retry.
        agent.hooks.add_callback(AfterModelCallEvent, self._on_model_result, order=HookOrder.MODEL_ROUTING)
        # One invocation_state dict can span several Before/After pairs, because Agent._run_loop
        # re-enters them for continuations and because callers may supply their own dict. Teardown
        # runs last so other end-of-invocation callbacks still observe the selection; entry clears
        # again so a dict that outlived its teardown cannot pin the next invocation to a stale model.
        agent.hooks.add_callback(AfterInvocationEvent, self._clear_state, order=HookOrder.SDK_LAST)
        agent.hooks.add_callback(BeforeInvocationEvent, self._clear_state, order=HookOrder.SDK_FIRST)

    # ---- Asking the strategy ----

    @property
    def _strategy_name(self) -> str:
        """Strategy class name, for logs that explain a routing decision."""
        return type(self._strategy).__name__

    async def _ask(self, context: RoutingContext) -> RoutingCandidate | None:
        """Ask the strategy for a candidate and validate the answer."""
        return self._validated(await self._strategy.select(context), context)

    def _validated(self, candidate: object, context: RoutingContext) -> RoutingCandidate | None:
        """Return the candidate, raising if the strategy broke its contract."""
        if candidate is None:
            return None
        if not isinstance(candidate, RoutingCandidate):
            raise TypeError(f"strategy.select must return a RoutingCandidate or None; got {type(candidate).__name__}")
        if not any(candidate is configured for configured in context.candidates):
            raise ValueError("strategy.select must return a candidate from context.candidates")
        return candidate

    async def _open(self, context: RoutingContext) -> tuple[RoutingCandidate, Model]:
        """Choose and resolve the candidate to start on.

        A decline serves the default model. A strategy that raises, and a candidate that will not
        resolve to a model, both propagate.
        """
        candidate = await self._ask(context)
        if candidate is None:
            candidate = self._candidates[0]
            model = self.default_model
            logger.info(
                "strategy=<%s>, candidate=<%s>, model=<%s> | strategy declined the opening choice, using the "
                "default model",
                self._strategy_name,
                _candidate_label(candidate),
                _model_label(model),
            )
            return candidate, model

        model = await self._resolve(candidate, context)
        logger.info(
            "strategy=<%s>, candidate=<%s>, model=<%s> | candidate selected",
            self._strategy_name,
            _candidate_label(candidate),
            _model_label(model),
        )
        return candidate, model

    # ---- Resolving a candidate to a model ----

    async def _resolve(self, candidate: RoutingCandidate, context: RoutingContext) -> Model:
        """Resolve a candidate to a concrete model, recursing into a nested router's selection.

        A nested router is asked with its own candidates and no attempts, so it contributes one
        candidate and never advances internally.
        """
        model = candidate.model
        if isinstance(model, ModelRouter):
            return await model._select_model(replace(context, candidates=model.candidates, attempts=()))
        return model

    async def _select_model(self, context: RoutingContext) -> Model:
        """Resolve this router's chosen candidate, or its default model if the strategy declines."""
        candidate = await self._ask(context)
        if candidate is None:
            return self.default_model
        return await self._resolve(candidate, context)

    # ---- Applying the selection ----

    def _selection_middleware(self) -> Callable[[InvokeModelContext], Awaitable[InvokeModelContext]]:
        """Build an ``InvokeModelStage.Input`` handler that applies the per-invocation selection."""

        async def middleware(context: InvokeModelContext) -> InvokeModelContext:
            key = self._state_key(context.agent)
            state = _get_routing_state(context.invocation_state, key)
            if state is None:
                routing_context = self._routing_context(
                    context.messages,
                    context.system_prompt,
                    context.tool_specs,
                    context.invocation_state,
                )
                candidate, model = await self._open(routing_context)
                # The opening candidate counts as used for this round.
                state = _RoutingState(candidate=candidate, model=model, switched_to={id(candidate)})
                context.invocation_state[key] = state
            context.model = state.model
            return context

        return middleware

    async def _on_model_result(self, event: AfterModelCallEvent) -> None:
        """Record the outcome and, after an unclaimed failure, apply the strategy's next choice."""
        state = _get_routing_state(event.invocation_state, self._state_key(event.agent))
        if state is None:
            return
        if event.stop_response is not None:
            state.attempts.append(RoutingAttempt(candidate=state.candidate))
            # The candidate that succeeded opens the next round, counting as used like any opening
            # choice.
            state.switched_to = {id(state.candidate)}
            return
        if event.retry or event.exception is None:
            return

        state.attempts.append(RoutingAttempt(candidate=state.candidate, exception=event.exception))
        if self._max_switches is not None and state.switches >= self._max_switches:
            logger.warning("max_switches=<%d> | switch cap reached, leaving the error to surface", self._max_switches)
            return

        if await self._advance(event, state):
            event.retry = True

    async def _advance(self, event: AfterModelCallEvent, state: _RoutingState) -> bool:
        """Switch to the strategy's next candidate, returning whether the call should be retried.

        A usable new candidate is switched to. A strategy that raises, declines, or names a candidate the
        round already used leaves the model's error to surface. A candidate that will not resolve is
        unusable rather than unlucky, so it takes its slot in the round and the strategy is asked once
        more. Each pass either switches or consumes a slot, so the round stays bounded by the candidate
        count.
        """
        while True:
            routing_context = self._routing_context_from_agent(event.agent, event.invocation_state, state.attempts)
            try:
                # Validated inside the try: a model error is already pending, so a broken answer must
                # not replace it. The opening choice has nothing pending and lets the error surface.
                candidate = self._validated(await self._strategy.select(routing_context), routing_context)
            except Exception as error:
                logger.warning(
                    "strategy=<%s>, error=<%s> | routing failed, leaving the error to surface",
                    self._strategy_name,
                    error,
                )
                return False
            if candidate is None:
                return False

            # A round uses each candidate at most once, so a strategy that cycles cannot keep resetting
            # the retry budget.
            if id(candidate) in state.switched_to:
                logger.info(
                    "candidate=<%s> | already used this round, leaving the error to surface",
                    _candidate_label(candidate),
                )
                return False

            try:
                model = await self._resolve(candidate, routing_context)
            except Exception as error:
                logger.warning(
                    "candidate=<%s>, error=<%s> | candidate could not be resolved, asking again",
                    _candidate_label(candidate),
                    error,
                )
                # Recorded so a strategy reading attempts stops offering it, and slot-burned so
                # termination does not depend on the strategy doing that.
                state.attempts.append(RoutingAttempt(candidate=candidate, exception=error))
                state.switched_to.add(id(candidate))
                continue

            logger.info(
                "from_candidate=<%s>, to_candidate=<%s>, error=<%s> | model call failed, switching candidate",
                _candidate_label(state.candidate),
                _candidate_label(candidate),
                type(event.exception).__name__,
            )
            state.candidate = candidate
            state.model = model
            state.switched_to.add(id(candidate))
            state.switches += 1
            # ModelRetryStrategy exposes no public seam for a budget reset yet, so a rename in
            # _retry.py breaks this.
            event.agent._retry_strategy._reset_retry_state()
            return True

    # ---- Per-invocation state and context ----

    async def _clear_state(self, event: AfterInvocationEvent | BeforeInvocationEvent) -> None:
        """Drop this agent's routing state so it never spans invocations."""
        key = self._state_key(event.agent)
        if _get_routing_state(event.invocation_state, key) is not None:
            del event.invocation_state[key]

    def _state_key(self, agent: Agent) -> str:
        """Scope routing state to one agent/router pair.

        One ``invocation_state`` can serve several agents, and one router several agents, so neither
        identity alone is a sufficient key. ``agent_id`` cannot serve either: it is caller-supplied and
        defaults to ``"default"``, so two agents sharing a router would collide. Object identity is
        unique among live agents, and the state is cleared at both ends of an invocation, so a recycled
        id cannot match a live entry.

        The key carries no per-invocation component, so isolation between concurrent invocations relies
        on the agent allowing only one at a time, which is its default. Under
        ``ConcurrentInvocationMode.UNSAFE_REENTRANT`` overlapping invocations of one agent that share an
        ``invocation_state`` dict share this state too, as they already share ``agent.messages``.
        """
        return f"{_ROUTING_KEY_PREFIX}:{id(agent):x}:{id(self):x}"

    def _routing_context_from_agent(
        self, agent: Agent, invocation_state: Mapping[str, Any], attempts: Sequence[RoutingAttempt] = ()
    ) -> RoutingContext:
        """Build a ``RoutingContext`` from the agent, matching the shapes middleware passes."""
        system_prompt = (
            agent._system_prompt_content if agent._system_prompt_content is not None else agent.system_prompt
        )
        return self._routing_context(
            agent.messages,
            system_prompt,
            agent.tool_registry.get_all_tool_specs(),
            invocation_state,
            attempts,
        )

    def _routing_context(
        self,
        messages: Messages,
        system_prompt: SystemPrompt | None,
        tool_specs: Sequence[ToolSpec],
        invocation_state: Mapping[str, Any],
        attempts: Sequence[RoutingAttempt] = (),
    ) -> RoutingContext:
        """Build a ``RoutingContext`` over this router's candidates.

        Every ask goes through here, so the request a strategy sees is always a copy: ``agent.messages``
        and the registry's own tool specs are never handed over directly. Mirrors the copy
        ``event_loop`` makes for each model call.
        """
        return RoutingContext(
            messages=copy.deepcopy(messages),
            system_prompt=copy.deepcopy(system_prompt),
            tool_specs=copy.deepcopy(tool_specs),
            candidates=self._candidates,
            invocation_state=invocation_state,
            attempts=tuple(attempts),
        )


CandidateInput: TypeAlias = Model | ModelRouter | RoutingCandidate
"""What ``ModelRouter(models=...)`` accepts for each entry."""


# ---- Module helpers ----


def _model_label(model: Model) -> str:
    """Return a model's provider and model id without risking the routed call."""
    provider = type(model).__name__
    try:
        config = model.get_config()
    except Exception:
        # Labels are built eagerly as log arguments, so one must never fail a routed call or mask
        # a construction error.
        return provider
    model_id = (
        config.get("model_id") if isinstance(config, dict) else getattr(config, "model_id", None) if config else None
    )
    return f"{provider}/{model_id}" if model_id else provider


def _candidate_label(candidate: RoutingCandidate) -> str:
    """Return the candidate's name, or its provider and model id when it has none."""
    if candidate.name:
        return candidate.name
    return _model_label(candidate.model) if isinstance(candidate.model, Model) else type(candidate.model).__name__


def _get_routing_state(invocation_state: Mapping[str, Any], key: str) -> _RoutingState | None:
    """Return the routing state stored under ``key``, ignoring any foreign value."""
    value = invocation_state.get(key)
    return value if isinstance(value, _RoutingState) else None


# ---- Construction guards ----


def _normalize(models: object) -> tuple[RoutingCandidate, ...]:
    """Coerce the input sequence into ``RoutingCandidate`` objects, validating candidate types."""
    if isinstance(models, (str, bytes, Mapping)) or not isinstance(models, Sequence):
        raise TypeError("models must be a sequence of candidates")
    return tuple(_as_candidate(item) for item in models)


def _as_candidate(item: CandidateInput) -> RoutingCandidate:
    """Wrap a candidate input in a ``RoutingCandidate``, validating its model type."""
    candidate = item if isinstance(item, RoutingCandidate) else RoutingCandidate(model=item)
    if not isinstance(candidate.model, (Model, ModelRouter)):
        raise TypeError(f"candidate must be a Model or ModelRouter; got {type(candidate.model).__name__}")
    return candidate


def _reachable_models(candidate: RoutingCandidate) -> Iterator[Model]:
    """Yield every concrete model this candidate can run, descending into a nested router."""
    model = candidate.model
    if isinstance(model, ModelRouter):
        for nested in model.candidates:
            yield from _reachable_models(nested)
    else:
        yield model


def _reject_stateful(candidates: tuple[RoutingCandidate, ...]) -> None:
    """Reject any stateful candidate model."""
    for candidate in candidates:
        if isinstance(candidate.model, Model) and candidate.model.stateful:
            raise ValueError(
                f"candidate=<{_candidate_label(candidate)}> is stateful; routing among stateful models is not supported"
            )


def _reject_duplicates(candidates: tuple[RoutingCandidate, ...]) -> None:
    """Reject repeated candidates, repeated models, or colliding names.

    Strategies track health per candidate, so one model behind two candidates would get two failure
    budgets and never be demoted. The model check reaches through a nested router; names stay per level,
    since a strategy only chooses among the candidates it is shown.
    """
    seen_candidates: set[int] = set()
    seen_models: set[int] = set()
    seen_names: set[str] = set()
    for candidate in candidates:
        identity = id(candidate)
        if identity in seen_candidates:
            raise ValueError("duplicate RoutingCandidate instance")
        seen_candidates.add(identity)

        for model in _reachable_models(candidate):
            if id(model) in seen_models:
                raise ValueError(
                    f"candidate=<{_candidate_label(candidate)}> repeats a model already routed to; "
                    "construct a separate instance so each candidate has its own health"
                )
            seen_models.add(id(model))

        if candidate.name is None:
            continue
        if candidate.name in seen_names:
            raise ValueError(f"duplicate candidate name=<{candidate.name}>")
        seen_names.add(candidate.name)

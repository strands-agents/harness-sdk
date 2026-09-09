"""Unit tests of ``_GraphStrategy.init_agent`` and the three hooks it registers.

Wiring, so almost every test here is about a count, a position or a boundary rather than about a
value. Four claims carry the design.

* **Exactly one of each, per agent.** One ``InvokeModelStage.Input`` handler, one
  ``MessageAddedEvent`` hook, one ``AfterToolCallEvent`` hook, one ``BeforeInvocationEvent`` hook —
  and one independent graph per agent when a single instance serves two of them.
* **Index zero.** The delivery handler is moved to the front of the stage, which resolves both
  required orderings whatever the order of the ``plugins=[...]`` list.
* **The choice is frozen and cheap.** ``BeforeInvocationEvent`` computes it once, stores it as an
  immutable mapping, advances the turn ordinal, and touches neither ``agent.messages`` nor a model.
* **The critical path never scans.** The rebuild scan runs on the writing half only, which is why the
  first turn and the first turn after a restore both go out whole.

The agent is a small weakref-able double carrying the real ``MiddlewareRegistry``: the ordering claim
is about that object's handler list, so doubling it would test nothing. The matcher is never real —
the suite makes zero network calls.
"""

from __future__ import annotations

import copy
import logging
from types import MappingProxyType
from typing import Any

import pytest

from strands._middleware import MiddlewareRegistry
from strands._middleware.stages import InvokeModelStage
from strands.agent.conversation_manager import (
    NullConversationManager,
    SlidingWindowConversationManager,
    SummarizingConversationManager,
)
from strands.hooks.events import AfterToolCallEvent, BeforeInvocationEvent, MessageAddedEvent
from strands.vended_plugins.context_graph.cards import rebuild
from strands.vended_plugins.context_graph.matcher import EmbeddingSimilarityMatcher
from strands.vended_plugins.context_graph.plugin import ContextStrategy, _GraphStrategy

from .stubs import StubMatcher

PLUGIN_LOGGER = "strands.vended_plugins.context_graph.plugin"
"""Logger the strategy's own warnings come from, so unrelated records never inflate a count."""

CONFIG = {
    "description_tokens": 100,
    "tags_per_card": 5,
    "rarity_weight": 0.70,
    "link_threshold": 0.50,
}
"""The construction defaults, for the scan the tests compare the incremental path against."""


class FakeToolRegistry:
    """Just the attribute Requirement 1.3 is about."""

    def __init__(self) -> None:
        self.registry: dict[str, Any] = {}


class FakeAgent:
    """Weakref-able agent double carrying only what the strategy touches.

    ``add_hook`` records instead of dispatching, which is what makes "exactly one handler of each
    type" observable. ``_middleware_registry`` is the real one, because the ordering guarantee is a
    claim about its handler list.
    """

    def __init__(
        self,
        messages: list[dict[str, Any]] | None = None,
        conversation_manager: Any = None,
    ) -> None:
        self.messages: list[dict[str, Any]] = messages if messages is not None else []
        self.system_prompt = "you answer questions"
        self.tool_registry = FakeToolRegistry()
        self._middleware_registry = MiddlewareRegistry()
        self.hooks: list[tuple[Any, Any]] = []
        # The recommended pairing, so a test about anything else never trips the warning.
        self.conversation_manager = conversation_manager or NullConversationManager()

    def add_hook(self, callback: Any, event_type: Any = None, **_kwargs: Any) -> None:
        """Record the registration, the way the real registry would store it."""
        self.hooks.append((callback, event_type))

    def hooks_for(self, event_type: Any) -> list[Any]:
        """Callbacks registered for one event type."""
        return [callback for callback, registered in self.hooks if registered is event_type]

    def input_handlers(self) -> list[Any]:
        """The handlers as registered, in the order the chain will run them.

        The registry wraps every input handler in an adapter, so the entry in the list is not the
        object that was handed over. Reading it back out of the adapter's closure is what lets a test
        assert *which* handler is first rather than only how many there are.
        """
        return [_unwrap(tagged.handler) for tagged in self._middleware_registry._handlers.get(InvokeModelStage, [])]


def _unwrap(adapted: Any) -> Any:
    """The handler an adapter closes over, or the adapter itself when it closes over nothing."""
    for cell in adapted.__closure__ or ():
        if callable(cell.cell_contents):
            return cell.cell_contents
    return adapted


# --- conversation helpers -----------------------------------------------------------------------


def user(text: str, tracking_id: str) -> dict[str, Any]:
    """A user message, which is a turn boundary."""
    return {"role": "user", "content": [{"text": text}], "tracking_id": tracking_id}


def assistant(text: str, tracking_id: str) -> dict[str, Any]:
    """An assistant message, which never opens a turn."""
    return {"role": "assistant", "content": [{"text": text}], "tracking_id": tracking_id}


def conversation(turns: int) -> list[dict[str, Any]]:
    """A conversation of ``turns`` boundaries, each followed by one assistant reply."""
    messages: list[dict[str, Any]] = []
    for index in range(turns):
        messages.append(user(f"question {index} about subject {index}", f"u{index}"))
        messages.append(assistant(f"answer {index} with 1{index},00 in it", f"a{index}"))
    return messages


def graph_of(plugin: ContextStrategy) -> _GraphStrategy:
    """The graph strategy behind a ``ContextStrategy(strategy="graph")``."""
    return plugin._impl


def wired(matcher: Any = None, **overrides: Any) -> tuple[_GraphStrategy, FakeAgent]:
    """Build a graph strategy and an agent, wired together."""
    plugin = ContextStrategy(strategy="graph", matcher=matcher or StubMatcher(), **overrides)
    agent = FakeAgent()
    graph = graph_of(plugin)
    graph.init_agent(agent)  # type: ignore[arg-type]
    return graph, agent


def start_turn(graph: _GraphStrategy, agent: FakeAgent, messages: list[dict[str, Any]] | None = None) -> None:
    """Fire the single registered ``BeforeInvocationEvent`` hook."""
    (hook,) = agent.hooks_for(BeforeInvocationEvent)
    hook(BeforeInvocationEvent(agent=agent, messages=messages))  # type: ignore[arg-type]


def add_message(graph: _GraphStrategy, agent: FakeAgent, message: dict[str, Any]) -> None:
    """Append ``message`` to the history and fire the single ``MessageAddedEvent`` hook."""
    agent.messages.append(message)
    (hook,) = agent.hooks_for(MessageAddedEvent)
    hook(MessageAddedEvent(agent=agent, message=message))  # type: ignore[arg-type]


def finish_tool(graph: _GraphStrategy, agent: FakeAgent, result: Any, tool_name: str = "run_query") -> None:
    """Fire the single ``AfterToolCallEvent`` hook with ``result``."""
    (hook,) = agent.hooks_for(AfterToolCallEvent)
    hook(
        AfterToolCallEvent(
            agent=agent,  # type: ignore[arg-type]
            selected_tool=None,
            tool_use={"toolUseId": "tu1", "name": tool_name, "input": {}},
            invocation_state={},
            result=result,
        )
    )


OFFLOADED_PREVIEW = (
    "[Offloaded: 1 block, ~3,000 tokens]\n"
    "Tool result was offloaded to external storage due to size.\n\n"
    "row 1: 10,00\n\n"
    "[Stored references:]\n"
    "  mem_1_tu1_0 (text, 4,096 chars)"
)
"""The preview the offloader leaves behind over a single stored textual block."""


def offloaded_result(preview: str = OFFLOADED_PREVIEW) -> dict[str, Any]:
    """A tool result in the shape the offloader leaves behind."""
    return {"toolUseId": "tu1", "status": "success", "content": [{"text": preview}]}


# --- registration -------------------------------------------------------------------------------


class TestInitAgentWiring:
    """Requirement 1.2: exactly four engagement points, one of each kind."""

    def test_registers_one_handler_of_each_kind(self):
        _graph, agent = wired()

        assert len(agent.hooks_for(MessageAddedEvent)) == 1
        assert len(agent.hooks_for(AfterToolCallEvent)) == 1
        assert len(agent.hooks_for(BeforeInvocationEvent)) == 1
        assert len(agent.hooks) == 3
        assert len(agent.input_handlers()) == 1

    def test_the_handler_lands_on_the_invoke_model_input_phase(self):
        graph, agent = wired()

        assert agent.input_handlers() == [graph._delivery_handler]

    def test_completes_without_touching_the_prompt_the_history_or_the_tools(self):
        """Requirement 1.3."""
        agent = FakeAgent(conversation(2))
        before = copy.deepcopy(agent.messages)

        graph_of(ContextStrategy(strategy="graph")).init_agent(agent)  # type: ignore[arg-type]

        assert agent.system_prompt == "you answer questions"
        assert agent.messages == before
        assert agent.tool_registry.registry == {}

    def test_a_wired_agent_with_no_message_presents_an_empty_graph(self):
        """Requirement 14.11."""
        graph, agent = wired()
        state = graph._states[agent]

        assert state.cards == {}
        assert state.links == {}
        assert state.turn == 0

    def test_the_first_state_is_a_full_pass_before_any_turn_starts(self):
        """A fresh state is the regression short circuit, so an unused agent behaves as it does today."""
        graph, agent = wired()

        assert graph._states[agent].choice.full_pass is True


class TestDestructiveWindowManagement:
    """Requirements 15.1 to 15.4: one warning, then wired anyway. Degraded, never blocked."""

    def _init_with(self, manager: Any, caplog: Any) -> tuple[_GraphStrategy, FakeAgent, list[Any]]:
        agent = FakeAgent(conversation_manager=manager)
        graph = graph_of(ContextStrategy(strategy="graph"))
        with caplog.at_level(logging.WARNING, logger=PLUGIN_LOGGER):
            graph.init_agent(agent)  # type: ignore[arg-type]
        return graph, agent, [record for record in caplog.records if record.name == PLUGIN_LOGGER]

    @pytest.mark.parametrize(
        "manager",
        [
            SlidingWindowConversationManager(window_size=4),
            SummarizingConversationManager(),
        ],
        ids=["sliding-window", "summarizing"],
    )
    def test_a_destructive_manager_is_warned_about_exactly_once(self, manager, caplog):
        """Requirement 15.1: the manager is named, and the limit of recovery is stated."""
        _graph, _agent, warnings = self._init_with(manager, caplog)

        assert len(warnings) == 1
        message = warnings[0].getMessage()
        assert type(manager).__name__ in message
        assert "may not recover the message" in message

    def test_the_warning_does_not_stop_the_wiring(self, caplog):
        """Requirement 15.2: handler, hooks and tools are registered exactly as they are without it."""
        graph, agent, warnings = self._init_with(SlidingWindowConversationManager(window_size=4), caplog)

        assert warnings
        assert len(agent.hooks_for(MessageAddedEvent)) == 1
        assert len(agent.hooks_for(AfterToolCallEvent)) == 1
        assert len(agent.hooks_for(BeforeInvocationEvent)) == 1
        assert agent.input_handlers() == [graph._delivery_handler]
        assert graph._states[agent].turn == 0

    def test_the_three_tools_still_reach_the_registry(self):
        """Requirement 15.2: the tools are the plugin's own, and a warned wiring keeps all three."""
        plugin = ContextStrategy(strategy="graph")

        assert {tool.tool_name for tool in plugin._tools} == {"expand_card", "expand_artifact", "find_context"}

    def test_the_manager_is_left_exactly_as_it_was(self, caplog):
        """Requirement 15.3: not removed, not replaced, not reconfigured."""
        manager = SlidingWindowConversationManager(window_size=4)
        before = dict(vars(manager))

        _graph, agent, _warnings = self._init_with(manager, caplog)

        assert agent.conversation_manager is manager
        assert vars(manager) == before

    def test_the_recommended_pairing_completes_in_silence(self, caplog):
        """Requirement 15.4: ``NullConversationManager`` has nothing to warn about."""
        _graph, _agent, warnings = self._init_with(NullConversationManager(), caplog)

        assert warnings == []


class TestLivingWithTheOtherTwoPlugins:
    """Requirements 15.5, 15.7, 15.8, 15.9: a missing neighbour is a shape, not an error."""

    def test_without_the_offloader_the_subject_cards_carry_the_conversation(self):
        """Requirement 15.5: no artifact Card, and nothing raised for the lack of one."""
        graph, agent = wired()

        for message in conversation(4):
            add_message(graph, agent, message)

        cards = graph._states[agent].cards
        assert cards
        assert {card.kind for card in cards.values()} == {"subject"}

    def test_the_offloader_configuration_comes_out_as_it_went_in(self):
        """Requirement 15.7: preview strategy, relevance threshold and preview budget are untouched."""
        from strands.vended_plugins.context_offloader import ContextOffloader

        offloader = ContextOffloader(preview_tokens=123)
        before = dict(vars(offloader))
        agent = FakeAgent()

        graph_of(ContextStrategy(strategy="graph")).init_agent(agent)  # type: ignore[arg-type]

        assert offloader._preview_strategy == before["_preview_strategy"]
        assert offloader._preview_tokens == 123
        assert vars(offloader) == before

    def test_the_disclosure_configuration_comes_out_as_it_went_in(self):
        """Requirement 15.8: ``catalog_tokens``, ``ttl_cycles``, ``always_available`` and ``top_k``."""
        from strands.vended_plugins.progressive_tool_disclosure import ProgressiveToolDisclosure

        disclosure = ProgressiveToolDisclosure(
            catalog_tokens=40, ttl_cycles=7, always_available=("run_query",), top_k=2
        )
        before = dict(vars(disclosure))
        agent = FakeAgent()

        graph_of(ContextStrategy(strategy="graph")).init_agent(agent)  # type: ignore[arg-type]

        assert (disclosure._catalog_tokens, disclosure._ttl_cycles) == (40, 7)
        assert (disclosure._always_available, disclosure._top_k) == (("run_query",), 2)
        assert vars(disclosure) == before

    def test_the_graph_configuration_comes_out_as_it_went_in(self):
        """Requirement 2.18: the values fixed at construction survive the wiring unchanged."""
        plugin = ContextStrategy(strategy="graph", expand_threshold=0.8, collapse_floor=0.2, body_budget=500)
        graph = graph_of(plugin)
        before = dict(vars(graph))

        graph.init_agent(FakeAgent())  # type: ignore[arg-type]

        assert (graph._expand_threshold, graph._collapse_floor, graph._body_budget) == (0.8, 0.2, 500)
        # ``_states`` gained the agent; nothing else moved.
        assert {key: value for key, value in vars(graph).items() if key != "_states"} == {
            key: value for key, value in before.items() if key != "_states"
        }

    def test_no_memory_store_is_read_and_no_threshold_is_touched(self):
        """Requirement 15.9: the graph reads messages, and nothing that retrieves entries."""
        graph, agent = wired(min_cards=2)
        agent.messages = conversation(5)
        graph._states[agent] = rebuild(agent.messages, **CONFIG)

        start_turn(graph, agent, [user("and the other one?", "u9")])
        for message in conversation(2):
            add_message(graph, agent, message)

        assert not hasattr(agent, "memory")
        assert not hasattr(graph, "_store")


class TestTheHandlerGoesToIndexZero:
    """Requirement 9.7, resolved by position rather than by the order of ``plugins=[...]``."""

    def test_a_handler_registered_earlier_ends_up_behind_the_graph(self):
        def other(context):
            return context

        agent = FakeAgent()
        agent._middleware_registry.add_middleware(InvokeModelStage.Input, other)
        graph = graph_of(ContextStrategy(strategy="graph"))
        graph.init_agent(agent)  # type: ignore[arg-type]

        assert agent.input_handlers() == [graph._delivery_handler, other]

    def test_a_handler_registered_later_ends_up_behind_the_graph_too(self):
        def other(context):
            return context

        graph, agent = wired()
        agent._middleware_registry.add_middleware(InvokeModelStage.Input, other)

        assert agent.input_handlers() == [graph._delivery_handler, other]


class TestOneInstanceOnTwoAgents:
    """Requirements 1.5 and 14.4: per-agent handlers, per-agent graph, nothing shared."""

    def test_each_agent_gets_its_own_four_engagement_points(self):
        plugin = ContextStrategy(strategy="graph")
        first, second = FakeAgent(), FakeAgent()

        graph_of(plugin).init_agent(first)  # type: ignore[arg-type]
        graph_of(plugin).init_agent(second)  # type: ignore[arg-type]

        for agent in (first, second):
            assert len(agent.hooks_for(MessageAddedEvent)) == 1
            assert len(agent.hooks_for(AfterToolCallEvent)) == 1
            assert len(agent.hooks_for(BeforeInvocationEvent)) == 1
            assert len(agent.input_handlers()) == 1

    def test_each_agent_gets_its_own_state(self):
        plugin = ContextStrategy(strategy="graph")
        graph = graph_of(plugin)
        first, second = FakeAgent(), FakeAgent()

        graph.init_agent(first)  # type: ignore[arg-type]
        graph.init_agent(second)  # type: ignore[arg-type]

        assert graph._states[first] is not graph._states[second]

    def test_the_turn_ordinal_advances_independently(self):
        plugin = ContextStrategy(strategy="graph", matcher=StubMatcher())
        graph = graph_of(plugin)
        first, second = FakeAgent(), FakeAgent()
        graph.init_agent(first)  # type: ignore[arg-type]
        graph.init_agent(second)  # type: ignore[arg-type]

        start_turn(graph, first)
        start_turn(graph, first)
        start_turn(graph, second)

        assert graph._states[first].turn == 2
        assert graph._states[second].turn == 1

    def test_a_card_derived_for_one_agent_says_nothing_about_the_other(self):
        plugin = ContextStrategy(strategy="graph", matcher=StubMatcher())
        graph = graph_of(plugin)
        first, second = FakeAgent(), FakeAgent()
        graph.init_agent(first)  # type: ignore[arg-type]
        graph.init_agent(second)  # type: ignore[arg-type]

        for message in conversation(2):
            add_message(graph, first, message)

        assert graph._states[first].cards
        assert graph._states[second].cards == {}


# --- the reading half ---------------------------------------------------------------------------


class TestTheTurnChoiceIsFrozenAndCheap:
    """Requirements 8.1, 8.2, 8.10, 8.11."""

    def test_the_first_turn_is_a_full_pass(self):
        """Requirement 8.11: nothing to choose between, so everything travels whole."""
        matcher = StubMatcher()
        graph, agent = wired(matcher)

        start_turn(graph, agent, [user("what is this?", "u0")])

        assert graph._states[agent].choice.full_pass is True
        assert matcher.call_count == 0, "a decision the graph size already made costs no embedding"

    def test_a_graph_below_min_cards_is_a_full_pass_without_an_embedding(self):
        """Requirement 7.7: the warm-up short circuit never reaches the matcher."""
        matcher = StubMatcher()
        graph, agent = wired(matcher, min_cards=5)
        agent.messages = conversation(4)
        graph._states[agent] = rebuild(agent.messages, **CONFIG)

        start_turn(graph, agent, [user("and the other one?", "u9")])

        assert graph._states[agent].choice.full_pass is True
        assert matcher.call_count == 0

    def test_a_warm_graph_is_scored_once_and_every_card_is_in_the_choice(self):
        """Requirement 8.9 and Property 6: no Card is ever dropped from the call."""
        matcher = StubMatcher()
        graph, agent = wired(matcher, min_cards=2)
        agent.messages = conversation(5)
        state = rebuild(agent.messages, **CONFIG)
        graph._states[agent] = state

        start_turn(graph, agent, [user("and the other one?", "u9")])

        assert matcher.call_count == 1, "one embedding round per turn"
        assert state.choice.full_pass is False
        assert set(state.choice.by_title) == set(state.cards)

    def test_the_question_comes_from_the_invocation_and_not_from_the_history(self):
        """``BeforeInvocationEvent`` fires before the turn's message is appended."""
        matcher = StubMatcher()
        graph, agent = wired(matcher, min_cards=2)
        agent.messages = conversation(5)
        graph._states[agent] = rebuild(agent.messages, **CONFIG)

        start_turn(graph, agent, [user("the question of this turn", "u9")])

        assert matcher.calls[0][0] == "the question of this turn"

    def test_the_history_is_read_when_the_invocation_carries_no_message(self):
        matcher = StubMatcher()
        graph, agent = wired(matcher, min_cards=2)
        agent.messages = conversation(5)
        graph._states[agent] = rebuild(agent.messages, **CONFIG)

        start_turn(graph, agent, None)

        assert matcher.calls[0][0] == "question 4 about subject 4"

    def test_the_choice_is_an_immutable_mapping(self):
        """Requirement 8.1: stored as an immutable mapping, so no caller can shift it mid-turn."""
        graph, agent = wired(min_cards=2)
        agent.messages = conversation(5)
        graph._states[agent] = rebuild(agent.messages, **CONFIG)

        start_turn(graph, agent, [user("and the other one?", "u9")])
        choice = graph._states[agent].choice

        assert isinstance(choice.by_title, MappingProxyType)
        with pytest.raises(TypeError):
            choice.by_title["turn one"] = None  # type: ignore[index]

    def test_the_same_choice_object_serves_every_call_of_the_turn(self):
        """Requirement 8.2: including the calls of the autonomous tool loop."""
        graph, agent = wired(min_cards=2)
        agent.messages = conversation(5)
        graph._states[agent] = rebuild(agent.messages, **CONFIG)

        start_turn(graph, agent, [user("and the other one?", "u9")])
        frozen = graph._states[agent].choice

        # Everything a tool cycle does within the turn: messages arrive, tools finish. None of it
        # recomputes the choice, because only the turn boundary does.
        add_message(graph, agent, assistant("mid-turn reply", "a9"))
        finish_tool(graph, agent, offloaded_result())

        assert graph._states[agent].choice is frozen

    def test_the_turn_ordinal_advances_once_per_turn(self):
        graph, agent = wired()

        start_turn(graph, agent)
        start_turn(graph, agent)
        start_turn(graph, agent)

        assert graph._states[agent].turn == 3

    def test_the_hook_leaves_the_history_untouched(self):
        """Requirement 8.10: no model call, no disk, and ``agent.messages`` unchanged."""
        graph, agent = wired(min_cards=2)
        agent.messages = conversation(5)
        graph._states[agent] = rebuild(agent.messages, **CONFIG)
        before = copy.deepcopy(agent.messages)

        start_turn(graph, agent, [user("and the other one?", "u9")])

        assert agent.messages == before

    def test_a_state_with_no_card_is_recovered_before_the_choice(self):
        """A fresh process holding a restored history derives the graph in time to decide with it.

        Requirement 14.6 kept the scan off the critical path, on the reading that a restore is rare.
        It is not rare in a per-invocation runtime: restore populates ``agent.messages`` directly and
        fires no ``MessageAddedEvent``, so the writing half never runs before the choice and every
        invocation decided a full pass — the strategy present and never engaging.
        """
        graph, agent = wired(min_cards=2)
        agent.messages = conversation(5)

        start_turn(graph, agent, [user("and the other one?", "u9")])

        assert graph._states[agent].cards != {}
        assert graph._states[agent].choice.full_pass is False

    def test_a_recovered_graph_resolves_its_active_subject(self):
        """What the turn ordinal is *for*, asserted where it can be wrong without raising.

        Recovery assigns ``state.turn`` from the count of closed turns, and the increment that follows
        is what makes ``_active_subject`` — which reads ``state.turn - 1`` — land on the Card of the
        last closed turn. Recovering after the increment instead would leave it pointing one past the
        last Card, and continuity would silently stop applying to anything.
        """
        graph, agent = wired(min_cards=2)
        agent.messages = conversation(5)

        start_turn(graph, agent, [user("and the other one?", "u9")])

        state = graph._states[agent]
        last_closed = max(card.turn for card in state.cards.values())
        active = [title for title, card in state.cards.items() if card.turn == last_closed]
        assert state.choice.by_title[active[0]].dialogue == "full"

    def test_an_empty_conversation_is_not_recovered_and_keeps_its_ordinal(self):
        """Recovery is guarded on a closed turn existing, and the guard is about the ordinal.

        ``rebuild_into`` assigns ``state.turn`` from the count of closed turns, so running it over a
        conversation with none would reset the ordinal every turn.
        """
        graph, agent = wired()

        start_turn(graph, agent)
        start_turn(graph, agent)

        assert graph._states[agent].cards == {}
        assert graph._states[agent].turn == 2

    def test_a_retrieval_cycle_count_starts_each_turn_at_zero(self):
        graph, agent = wired()
        graph._states[agent].retrieval_cycles = 4

        start_turn(graph, agent)

        assert graph._states[agent].retrieval_cycles == 0

    def test_a_failing_matcher_degrades_to_a_full_pass_with_one_warning(self, caplog):
        """Requirements 16.1, 16.2: the failure costs tokens, never the call."""
        graph, agent = wired(StubMatcher(fail=RuntimeError("embedding down")), min_cards=2)
        agent.messages = conversation(5)
        graph._states[agent] = rebuild(agent.messages, **CONFIG)

        with caplog.at_level(logging.DEBUG):
            start_turn(graph, agent, [user("and the other one?", "u9")])

        assert graph._states[agent].choice.full_pass is True

    def test_a_choice_that_raises_degrades_to_a_full_pass_with_one_warning(self, caplog, monkeypatch):
        """Requirement 16.2: one record with ``exc_info``, and the next turn tries again."""
        graph, agent = wired(min_cards=2)
        agent.messages = conversation(5)
        graph._states[agent] = rebuild(agent.messages, **CONFIG)
        monkeypatch.setattr(
            graph, "_matcher_for", lambda: (_ for _ in ()).throw(RuntimeError("no matcher")), raising=True
        )

        with caplog.at_level(logging.WARNING, logger=PLUGIN_LOGGER):
            start_turn(graph, agent, [user("and the other one?", "u9")])

        warnings = [record for record in caplog.records if record.name == PLUGIN_LOGGER]
        assert len(warnings) == 1
        assert warnings[0].exc_info is not None
        assert graph._states[agent].choice.full_pass is True


class TestTheDefaultMatcherIsResolvedLazily:
    """Requirement 2.16: construction opens no client, so the default cannot be built there."""

    def test_a_supplied_matcher_is_the_one_used(self):
        matcher = StubMatcher()
        graph, _agent = wired(matcher)

        assert graph._matcher_for() is matcher

    def test_the_default_is_built_on_first_need_and_only_once(self):
        graph = graph_of(ContextStrategy(strategy="graph"))

        assert graph._resolved_matcher is None

        first = graph._matcher_for()

        assert isinstance(first, EmbeddingSimilarityMatcher)
        assert graph._matcher_for() is first
        # The supplied configuration stays observable as the configuration it was.
        assert graph._matcher is None


# --- the writing half ---------------------------------------------------------------------------


class TestTheCardIsClosedOnTheMessageClock:
    """Requirement 14.3, and Property 15: the same Card whichever path derived it."""

    def test_a_conversation_with_no_closed_turn_derives_nothing(self):
        graph, agent = wired()

        add_message(graph, agent, user("first ask", "u0"))
        add_message(graph, agent, assistant("first answer", "a0"))

        assert graph._states[agent].cards == {}

    def test_a_mid_turn_message_derives_nothing(self):
        graph, agent = wired()
        for message in conversation(2):
            add_message(graph, agent, message)
        cards_after_the_boundary = dict(graph._states[agent].cards)

        add_message(graph, agent, assistant("still the same turn", "a9"))

        assert graph._states[agent].cards == cards_after_the_boundary

    def test_driving_the_hook_turn_by_turn_produces_what_the_scan_produces(self):
        """The property that dispenses with persistence, as an example over six turns."""
        graph, agent = wired()
        messages = conversation(6)

        for message in messages:
            add_message(graph, agent, message)

        state = graph._states[agent]
        scanned = rebuild(messages, **CONFIG)

        assert state.cards == scanned.cards
        assert state.links == scanned.links

    def test_the_turn_ordinals_are_the_positions_of_the_closed_boundaries(self):
        graph, agent = wired()

        for message in conversation(4):
            add_message(graph, agent, message)

        state = graph._states[agent]
        assert sorted(card.turn for card in state.cards.values()) == [0, 1, 2]

    def test_a_state_lost_to_a_restart_is_rebuilt_by_scan(self):
        """Requirement 14.5: no I/O, no model call, no serialized format."""
        graph, agent = wired()
        agent.messages = conversation(4)
        del graph._states[agent]

        add_message(graph, agent, user("the turn after the restore", "u9"))

        state = graph._states[agent]
        assert set(state.cards) == set(rebuild(agent.messages, **CONFIG).cards)

    def test_every_addressed_identity_exists_in_the_history(self):
        """Requirement 14.8."""
        graph, agent = wired()
        for message in conversation(5):
            add_message(graph, agent, message)

        live = {message["tracking_id"] for message in agent.messages}
        addressed = {
            identity
            for card in graph._states[agent].cards.values()
            for identity in (*card.dialogue_ids, *card.evidence_ids)
        }
        assert addressed <= live

    def test_a_turn_whose_messages_carry_no_identity_derives_no_card(self):
        """Requirement 3.5: messages without a Card, which project whole."""
        graph, agent = wired()
        for message in conversation(2):
            add_message(graph, agent, message)
        # A turn nobody can address: no durable identity anywhere in it.
        add_message(graph, agent, {"role": "user", "content": [{"text": "anonymous ask"}]})
        add_message(graph, agent, {"role": "assistant", "content": [{"text": "anonymous answer"}]})
        before = dict(graph._states[agent].cards)

        add_message(graph, agent, user("next ask", "u9"))

        assert graph._states[agent].cards == before

    def test_a_derivation_that_raises_leaves_the_graph_alone_with_one_warning(self, caplog, monkeypatch):
        """Requirements 16.4, 16.8: the turn's messages go whole, and nothing propagates."""
        graph, agent = wired()
        for message in conversation(2):
            add_message(graph, agent, message)
        before = dict(graph._states[agent].cards)
        monkeypatch.setattr(
            "strands.vended_plugins.context_graph.plugin.closed_turn_ranges",
            lambda _messages: (_ for _ in ()).throw(RuntimeError("scan down")),
        )

        with caplog.at_level(logging.WARNING, logger=PLUGIN_LOGGER):
            add_message(graph, agent, user("next ask", "u9"))

        warnings = [record for record in caplog.records if record.name == PLUGIN_LOGGER]
        assert len(warnings) == 1
        assert warnings[0].exc_info is not None
        assert graph._states[agent].cards == before


class TestTheArtifactCardIsRegisteredOnTheToolClock:
    """Requirement 15.5: a result that stored nothing registers nothing, and says nothing about it."""

    def test_a_stored_reference_becomes_an_artifact_card(self):
        graph, agent = wired()
        for message in conversation(3):
            add_message(graph, agent, message)

        finish_tool(graph, agent, offloaded_result())

        card = graph._states[agent].cards["mem_1_tu1_0"]
        assert card.kind == "artifact"
        assert card.reference == "mem_1_tu1_0"

    def test_the_artifact_carries_the_ordinal_of_the_open_turn(self):
        graph, agent = wired()
        start_turn(graph, agent)
        for message in conversation(3):
            add_message(graph, agent, message)
        turn = graph._states[agent].turn

        finish_tool(graph, agent, offloaded_result())

        assert graph._states[agent].cards["mem_1_tu1_0"].turn == turn

    def test_a_result_that_stored_nothing_registers_nothing_and_logs_nothing(self, caplog):
        graph, agent = wired()

        with caplog.at_level(logging.DEBUG, logger=PLUGIN_LOGGER):
            finish_tool(graph, agent, {"toolUseId": "tu1", "status": "success", "content": [{"text": "42 rows"}]})

        assert graph._states[agent].cards == {}
        assert [record for record in caplog.records if record.name == PLUGIN_LOGGER] == []

    def test_a_failed_tool_call_carrying_an_exception_completes_quietly(self, caplog):
        graph, agent = wired()

        with caplog.at_level(logging.DEBUG, logger=PLUGIN_LOGGER):
            finish_tool(graph, agent, RuntimeError("the tool blew up"))

        assert graph._states[agent].cards == {}
        assert [record for record in caplog.records if record.name == PLUGIN_LOGGER] == []


class TestNothingIsWrittenOutsideThePerCallContext:
    """Requirements 1.10 and 14.2: no message metadata written, and no state on the agent."""

    def test_driving_every_hook_writes_no_message_metadata(self):
        graph, agent = wired(min_cards=2)

        for message in conversation(5):
            add_message(graph, agent, message)
        start_turn(graph, agent, [user("and the other one?", "u9")])
        finish_tool(graph, agent, offloaded_result())

        assert all("metadata" not in message for message in agent.messages)

    def test_the_graph_lives_in_the_per_agent_map_and_nowhere_else(self):
        graph, agent = wired()

        for message in conversation(3):
            add_message(graph, agent, message)

        assert graph._states[agent].cards
        assert not hasattr(agent, "state")

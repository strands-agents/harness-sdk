"""Unit tests of ``ContextStrategy._delivery_handler``: one step, or none of it.

The handler is wiring, so almost every test here is about a boundary rather than about a value. Two
boundaries carry the design:

* **Object identity.** Below full content the handler builds a new context; at full content it returns
  the one it received. ``is`` is the assertion, not equality — a new list that happens to compare
  equal is exactly the regression Requirement 9.9 exists to forbid.
* **Atomicity.** The removal and the compaction fail together or not at all. The interesting case is a
  compaction that raises *after* the removal succeeded, because the injection primitive fails open on
  its own and would happily hand the removed context down the chain.

The stage is driven by calling the handler directly. The real registry has its own suite, and what is
under test here is what the handler returns, which the chain only forwards.
"""

import copy
import logging

import pytest

from strands._middleware.stages import InvokeModelContext
from strands.vended_plugins.context_graph import compaction as compaction_module
from strands.vended_plugins.context_graph.plugin import ContextStrategy
from strands.vended_plugins.context_graph.state import Card, CardChoice, _GraphState

from .conftest import frozen_choice


class FakeAgent:
    """Weak-referenceable stand-in for an agent: the two attributes the delivery path reads."""

    def __init__(self, messages):
        self.messages = messages
        self.state = {}


def _user(text, tracking_id):
    return {"role": "user", "content": [{"text": text}], "tracking_id": tracking_id}


def _assistant(text, tracking_id):
    return {"role": "assistant", "content": [{"text": text}], "tracking_id": tracking_id}


def _tool_result(tracking_id):
    return {
        "role": "user",
        "content": [{"toolResult": {"toolUseId": "tu-9", "status": "success", "content": [{"text": "42"}]}}],
        "tracking_id": tracking_id,
    }


def _conversation():
    """Three turns: turn zero, turn one, and turn two still open.

    Turn one is the only Card the choice collapses. Turn zero's user message is the first of the
    conversation and never leaves anyway, and turn two is the turn in progress.
    """
    return [
        _user("turn zero ask", "d0"),
        _assistant("answer zero", "a0"),
        _user("turn one ask", "d1"),
        _assistant("answer one", "a1"),
        _user("turn two ask", "d2"),
    ]


def _card(title, turn, dialogue_ids, evidence_ids=(), description=""):
    return Card(
        title=title,
        kind="subject",
        turn=turn,
        dialogue_ids=tuple(dialogue_ids),
        evidence_ids=tuple(evidence_ids),
        pairs=(),
        tool_names=frozenset(),
        references=(),
        numeric_lines=(),
        tags=(),
        description=description,
    )


def _collapsing_state():
    """A state whose choice puts turn one's dialogue in description and leaves the rest alone."""
    state = _GraphState()
    state.cards["turn one ask"] = _card(
        "turn one ask",
        1,
        ("d1", "a1"),
        description="turn one ask\nbalance: 1.200,00",
    )
    state.turn = 2
    state.choice = frozen_choice({"turn one ask": CardChoice(dialogue="description", evidence="full")})
    return state


def _full_pass_state():
    """A state whose choice is the regression short circuit."""
    state = _collapsing_state()
    state.choice = frozen_choice(
        {"turn one ask": CardChoice(dialogue="description", evidence="full")},
        full_pass=True,
    )
    return state


def _graph(**overrides):
    """The strategy, built the way production builds it."""
    return ContextStrategy(strategy="graph", **overrides)


def _context(agent, messages=None):
    """The per-call context the stage hands its input handlers."""
    return InvokeModelContext(
        agent=agent,
        messages=agent.messages if messages is None else messages,
        system_prompt="be brief",
        tool_specs=[],
        tool_choice=None,
        invocation_state={},
        model=object(),
        projected_input_tokens=7,
        dynamic_trailing_blocks=0,
    )


def _wire(graph, agent, state):
    """Attach ``state`` to ``agent`` inside ``graph``, the way the hooks will."""
    graph._states[agent] = state


def _texts(messages):
    """The text of every block of every message, flattened, so a fold is visible."""
    return [block["text"] for message in messages for block in message["content"] if "text" in block]


# --- the short circuit returns the object it received ---------------------------------------------


@pytest.mark.asyncio
async def test_a_full_pass_returns_the_received_context_itself():
    """Requirements 9.9, 1.11, 2.20: nothing below full content, so nothing is allocated."""
    agent = FakeAgent(_conversation())
    graph = _graph()
    _wire(graph, agent, _full_pass_state())
    context = _context(agent)

    assert await graph._delivery_handler(context) is context


@pytest.mark.asyncio
async def test_an_agent_with_no_state_returns_the_received_context_itself():
    """A state that does not exist yet is a fresh state, and a fresh state is a full pass."""
    agent = FakeAgent(_conversation())
    context = _context(agent)

    assert await _graph()._delivery_handler(context) is context


@pytest.mark.asyncio
async def test_an_empty_request_returns_the_received_context_itself():
    """Requirement 9.9's other half: a choice that collapses nothing asks for nothing."""
    agent = FakeAgent(_conversation())
    state = _collapsing_state()
    state.choice = frozen_choice({"turn one ask": CardChoice(dialogue="full", evidence="full")})
    graph = _graph()
    _wire(graph, agent, state)
    context = _context(agent)

    assert await graph._delivery_handler(context) is context


@pytest.mark.asyncio
async def test_an_empty_conversation_delivers_an_empty_removal_and_no_block():
    """Requirement 9.8: an empty list in, an empty list out, and nothing to fold into.

    Not an identity case: the request is derived from the graph, and a graph holding Cards over a list
    that holds nothing still asks for them. What the requirement pins down is the removal, and the
    removal of nothing is nothing.
    """
    agent = FakeAgent([])
    graph = _graph()
    _wire(graph, agent, _collapsing_state())

    delivered = await graph._delivery_handler(_context(agent))

    assert delivered.messages == []
    assert delivered.dynamic_trailing_blocks == 0


# --- the delivery itself --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_removal_and_the_final_block_arrive_together():
    """Requirements 9.2, 9.4, 9.5: the collapsed turn leaves, and its description folds at the end."""
    agent = FakeAgent(_conversation())
    graph = _graph()
    _wire(graph, agent, _collapsing_state())

    delivered = await graph._delivery_handler(_context(agent))

    texts = _texts(delivered.messages)
    assert "turn one ask" not in texts
    assert "answer one" not in texts
    assert any("<collapsed_turns>" in text for text in texts)
    assert any("balance: 1.200,00" in text for text in texts)


@pytest.mark.asyncio
async def test_the_final_block_lands_on_the_last_user_message_and_is_counted():
    """Requirements 9.4, 9.5: appended to the existing message, and counted as a trailing block."""
    agent = FakeAgent(_conversation())
    graph = _graph()
    _wire(graph, agent, _collapsing_state())

    delivered = await graph._delivery_handler(_context(agent))

    last = delivered.messages[-1]
    assert last["role"] == "user"
    assert last["content"][0]["text"] == "turn two ask"
    assert "<collapsed_turns>" in last["content"][-1]["text"]
    assert delivered.dynamic_trailing_blocks == 1


@pytest.mark.asyncio
async def test_no_field_other_than_messages_and_the_block_count_changes():
    """Requirement 9.2: a replaced context, with every other field carried over untouched."""
    agent = FakeAgent(_conversation())
    graph = _graph()
    _wire(graph, agent, _collapsing_state())
    context = _context(agent)

    delivered = await graph._delivery_handler(context)

    assert delivered is not context
    assert delivered.agent is context.agent
    assert delivered.system_prompt == context.system_prompt
    assert delivered.tool_specs is context.tool_specs
    assert delivered.tool_choice is context.tool_choice
    assert delivered.invocation_state is context.invocation_state
    assert delivered.model is context.model
    assert delivered.projected_input_tokens == context.projected_input_tokens


@pytest.mark.asyncio
async def test_the_received_context_and_the_agent_history_are_untouched():
    """Requirements 9.3, 1.4: nothing is mutated in place, and ``agent.messages`` least of all."""
    agent = FakeAgent(_conversation())
    graph = _graph()
    _wire(graph, agent, _collapsing_state())
    context = _context(agent, messages=list(agent.messages))
    before_context = copy.deepcopy(context.messages)
    before_agent = copy.deepcopy(agent.messages)

    await graph._delivery_handler(context)

    assert context.messages == before_context
    assert context.dynamic_trailing_blocks == 0
    assert agent.messages == before_agent


@pytest.mark.asyncio
async def test_two_runs_over_the_same_input_deliver_the_same_thing():
    """Requirement 9.11: same list, same choice, same messages and same block count."""
    agent = FakeAgent(_conversation())
    graph = _graph()
    _wire(graph, agent, _collapsing_state())

    first = await graph._delivery_handler(_context(agent))
    second = await graph._delivery_handler(_context(agent))

    assert first.messages == second.messages
    assert first.dynamic_trailing_blocks == second.dynamic_trailing_blocks


@pytest.mark.asyncio
async def test_the_removal_is_applied_even_when_no_fragment_is_produced(monkeypatch):
    """A block of ``None`` leaves ``dynamic_trailing_blocks`` alone, and the removal still travels."""
    agent = FakeAgent(_conversation())
    graph = _graph()
    _wire(graph, agent, _collapsing_state())
    monkeypatch.setattr(
        "strands.vended_plugins.context_graph.plugin.render_final_block", lambda *_args, **_kwargs: None
    )

    delivered = await graph._delivery_handler(_context(agent))

    assert "turn one ask" not in _texts(delivered.messages)
    assert delivered.dynamic_trailing_blocks == 0


# --- trigger ---------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_tool_result_turn_still_receives_the_final_block():
    """Requirement 9.6: ``trigger="everyTurn"``, so the autonomous tool loop is not skipped."""
    messages = [*_conversation(), _tool_result("e2")]
    agent = FakeAgent(messages)
    graph = _graph()
    _wire(graph, agent, _collapsing_state())

    delivered = await graph._delivery_handler(_context(agent))

    assert any("<collapsed_turns>" in text for text in _texts(delivered.messages))
    assert delivered.dynamic_trailing_blocks == 1


# --- atomic degradation ----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_failing_removal_returns_the_received_context_with_one_warning(monkeypatch, caplog):
    """Requirement 16.2: the received object, by identity, and exactly one warning with ``exc_info``."""
    agent = FakeAgent(_conversation())
    graph = _graph()
    _wire(graph, agent, _collapsing_state())
    context = _context(agent)
    monkeypatch.setattr(
        "strands.vended_plugins.context_graph.removal.apply_removal",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("removal exploded")),
    )

    with caplog.at_level(logging.WARNING, logger="strands.vended_plugins.context_graph.plugin"):
        assert await graph._delivery_handler(context) is context

    warnings = [record for record in caplog.records if record.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert warnings[0].exc_info is not None


@pytest.mark.asyncio
async def test_a_failing_compaction_undoes_the_removal_too(monkeypatch, caplog):
    """Requirement 16.2: removal applied with compaction failed is a state the handler never delivers.

    The primitive fails open on a ``render_content`` that raises — it would return the context it was
    handed, which already carries the removal. The handler's record is what turns that into the
    received context instead.
    """
    agent = FakeAgent(_conversation())
    graph = _graph()
    _wire(graph, agent, _collapsing_state())
    context = _context(agent)
    monkeypatch.setattr(
        "strands.vended_plugins.context_graph.plugin.render_final_block",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("compaction exploded")),
    )

    with caplog.at_level(logging.WARNING):
        delivered = await graph._delivery_handler(context)

    assert delivered is context
    assert delivered.messages == agent.messages
    plugin_warnings = [
        record
        for record in caplog.records
        if record.levelno == logging.WARNING and record.name.endswith("context_graph.plugin")
    ]
    assert len(plugin_warnings) == 1
    assert plugin_warnings[0].exc_info is not None


@pytest.mark.asyncio
async def test_no_failure_state_survives_the_call(monkeypatch):
    """Requirement 16.3: the very next call attempts the delivery again."""
    agent = FakeAgent(_conversation())
    graph = _graph()
    _wire(graph, agent, _collapsing_state())
    real = compaction_module.render_final_block
    calls = {"count": 0}

    def flaky(*args, **kwargs):
        calls["count"] += 1
        if calls["count"] == 1:
            raise RuntimeError("compaction exploded")
        return real(*args, **kwargs)

    monkeypatch.setattr("strands.vended_plugins.context_graph.plugin.render_final_block", flaky)

    first = await graph._delivery_handler(_context(agent))
    second = await graph._delivery_handler(_context(agent))

    assert first.dynamic_trailing_blocks == 0
    assert second.dynamic_trailing_blocks == 1
    assert any("<collapsed_turns>" in text for text in _texts(second.messages))


@pytest.mark.asyncio
async def test_the_delivery_record_is_cleared_after_every_call():
    """The context variable is per call: nothing about one delivery is readable by the next."""
    from strands.vended_plugins.context_graph.plugin import _DELIVERY

    agent = FakeAgent(_conversation())
    graph = _graph()
    _wire(graph, agent, _collapsing_state())

    await graph._delivery_handler(_context(agent))

    assert _DELIVERY.get() is None


@pytest.mark.asyncio
async def test_the_render_is_inert_outside_a_delivery():
    """Called with no delivery in flight it folds nothing, rather than guessing a request."""
    from strands.injection.types import InjectionContext

    agent = FakeAgent(_conversation())
    graph = _graph()
    _wire(graph, agent, _collapsing_state())

    assert graph._render(InjectionContext(messages=[], state=None, agent=agent)) is None


# --- the two agents of one instance ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_two_agents_of_one_instance_deliver_independently():
    """Requirement 1.5: one state per agent, so a full pass on one is not a full pass on the other."""
    graph = _graph()
    collapsing = FakeAgent(_conversation())
    passing = FakeAgent(_conversation())
    _wire(graph, collapsing, _collapsing_state())
    _wire(graph, passing, _full_pass_state())

    passing_context = _context(passing)
    collapsed = await graph._delivery_handler(_context(collapsing))

    assert await graph._delivery_handler(passing_context) is passing_context
    assert collapsed.dynamic_trailing_blocks == 1


def test_the_fold_is_built_once_per_strategy():
    """Requirement 9.6: one fold, constructed with the strategy and never rebuilt per call."""
    graph = _graph()

    assert isinstance(graph, ContextStrategy)
    assert graph._fold is graph._fold
    assert callable(graph._fold)

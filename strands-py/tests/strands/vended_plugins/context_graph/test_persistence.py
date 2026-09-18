"""Keeping the graph across processes, and the two ways a stored graph can be wrong.

The store is ``agent.state``, which every session manager persists — so these tests use a real
``FileSessionManager`` over a temporary directory once, to prove the round trip actually reaches disk,
and the in-memory ``AgentState`` everywhere else, because what the rest of the module decides has
nothing to do with which backend is behind it.

The two guards are the whole subject. A stored Card holds durable identities into ``agent.messages``
and can outlive the message it addresses; and Tags, Descriptions and rarity are functions of the
configuration, so a Card stored under one is not the Card the current one would derive. Both fall back
to the rebuild scan, which is the behavior that was correct before persistence existed.
"""

import json
from types import SimpleNamespace

import pytest

from strands.agent.state import AgentState
from strands.vended_plugins.context_graph import persistence
from strands.vended_plugins.context_graph.state import Card, Link, ToolPair, _GraphState

CONFIG = {"description_tokens": 100, "tags_per_card": 5, "rarity_weight": 0.70, "link_threshold": 0.50}
"""The values the graph is derived under, and therefore the fingerprint's inputs.

``link_threshold`` is one of them because it decides which edges the scan creates: a payload stored
under one value and loaded under another carries a link set the scan would never have produced, and
no guard downstream can tell.
"""


def _card(title, turn, *, kind="subject", dialogue=(), evidence=()):
    return Card(
        title=title,
        kind=kind,
        turn=turn,
        dialogue_ids=tuple(dialogue),
        evidence_ids=tuple(evidence),
        pairs=(ToolPair("tu-1", "run_query", tuple(evidence), True),) if evidence else (),
        tool_names=frozenset({"run_query"}) if evidence else frozenset(),
        references=("ref-7",) if kind == "artifact" else (),
        numeric_lines=("total: R$ 1.200,00",),
        tags=("btg", "extrato"),
        description=f"about {title}",
        reference="ref-7" if kind == "artifact" else None,
        content_type="text/plain" if kind == "artifact" else None,
        size_bytes=4096 if kind == "artifact" else None,
    )


def _agent(*tracking_ids, state=None):
    """An agent double carrying only the two things persistence touches."""
    return SimpleNamespace(
        state=state or AgentState(),
        messages=[
            {"role": "user", "content": [{"text": identity}], "tracking_id": identity} for identity in tracking_ids
        ],
    )


def _state(*cards, links=None, reuse=None, turn=None):
    state = _GraphState()
    for card in cards:
        state.cards[card.title] = card
        state.links[card.title] = []
    for title, edges in (links or {}).items():
        state.links[title] = list(edges)
    state.reuse = dict(reuse or {})
    state.turn = turn if turn is not None else len(state.cards)
    return state


class TestTheRoundTrip:
    def test_cards_links_reuse_and_the_ordinal_come_back(self):
        card = _card("extratos", 0, dialogue=("d0",), evidence=("e0",))
        saved = _state(card, links={"extratos": [Link("tool", "run_query", 0.6)]}, reuse={"extratos": (1.0, 7)}, turn=4)
        agent = _agent("d0", "e0")
        persistence.save(agent, saved, **CONFIG)

        restored = _GraphState()
        assert persistence.load(agent, restored, **CONFIG) is True
        assert restored.cards == saved.cards
        assert restored.links == saved.links
        assert restored.reuse == saved.reuse
        assert restored.turn == 4

    def test_the_frozenset_and_tuple_fields_survive_as_themselves(self):
        """JSON has lists, the Card has tuples and a frozenset, and the decode has to restore both."""
        card = _card("extratos", 0, dialogue=("d0",), evidence=("e0",))
        agent = _agent("d0", "e0")
        persistence.save(agent, _state(card), **CONFIG)

        restored = _GraphState()
        persistence.load(agent, restored, **CONFIG)

        recovered = restored.cards["extratos"]
        assert isinstance(recovered.tool_names, frozenset)
        assert isinstance(recovered.dialogue_ids, tuple)
        assert isinstance(recovered.pairs[0].tracking_ids, tuple)

    def test_the_payload_is_json_and_lands_under_a_namespaced_key(self):
        """It rides the session sync, so it has to be JSON, and it must not squat the app's namespace."""
        agent = _agent("d0")
        persistence.save(agent, _state(_card("t", 0, dialogue=("d0",))), **CONFIG)

        stored = agent.state.get()
        assert list(stored) == ["strands:context-graph"]
        json.dumps(stored)

    def test_two_saves_of_the_same_graph_produce_the_same_bytes(self):
        """So a diff of the session is readable, and a no-op turn is a no-op write."""
        agent = _agent("d0")
        state = _state(_card("t", 0, dialogue=("d0",), evidence=("e0",)))

        persistence.save(agent, state, **CONFIG)
        first = json.dumps(agent.state.get(persistence._STATE_KEY), sort_keys=True)
        persistence.save(agent, state, **CONFIG)

        assert json.dumps(agent.state.get(persistence._STATE_KEY), sort_keys=True) == first


class TestWhatAnUnchangedGraphCosts:
    def test_saving_the_same_graph_twice_does_not_touch_the_store(self):
        """The session syncs on a state version change, and ``set`` bumps it on every call.

        So an unconditional write turns every turn boundary into a full rewrite of the session's agent
        record — measured at ~150KB for two dozen Cards — whether or not the graph moved.
        """
        agent = _agent("d0")
        state = _state(_card("t", 0, dialogue=("d0",)))
        persistence.save(agent, state, **CONFIG)
        version = agent.state._get_version()

        persistence.save(agent, state, **CONFIG)

        assert agent.state._get_version() == version

    def test_a_graph_that_moved_is_written(self):
        agent = _agent("d0", "d1")
        persistence.save(agent, _state(_card("t", 0, dialogue=("d0",))), **CONFIG)
        version = agent.state._get_version()

        persistence.save(agent, _state(_card("t", 0, dialogue=("d0",)), _card("u", 1, dialogue=("d1",))), **CONFIG)

        assert agent.state._get_version() > version


class TestWhatIsDeliberatelyNotStored:
    def test_the_frozen_choice_and_the_published_names_do_not_travel(self):
        """Per-call values. Restoring either applies the last invocation's decision to this one."""
        agent = _agent("d0")
        state = _state(_card("t", 0, dialogue=("d0",)))
        state.referenced = frozenset({"run_query"})

        persistence.save(agent, state, **CONFIG)

        payload = agent.state.get(persistence._STATE_KEY)
        assert "choice" not in payload
        assert "referenced" not in payload

    def test_the_vector_cache_does_not_travel(self):
        """A cache. Losing it costs one embedding round trip; carrying it costs megabytes of floats
        through a session sync that fires on every message."""
        agent = _agent("d0")
        state = _state(_card("t", 0, dialogue=("d0",)))
        state.vectors = {"t": ("about t", (0.1, 0.2, 0.3))}

        persistence.save(agent, state, **CONFIG)

        assert "vectors" not in agent.state.get(persistence._STATE_KEY)

    def test_a_load_leaves_the_vector_cache_alone(self):
        """It is per-process and still valid, so a restore must not clear what this process warmed."""
        agent = _agent("d0")
        persistence.save(agent, _state(_card("t", 0, dialogue=("d0",))), **CONFIG)

        restored = _GraphState()
        restored.vectors = {"t": ("about t", (0.1,))}
        persistence.load(agent, restored, **CONFIG)

        assert restored.vectors == {"t": ("about t", (0.1,))}


class TestTheGuardAgainstMessagesThatAreGone:
    def test_a_card_addressing_an_absent_message_is_dropped(self):
        """The reconciliation the rebuild scan avoided by never storing anything."""
        agent = _agent("d0")
        kept = _card("kept", 0, dialogue=("d0",))
        stale = _card("stale", 1, dialogue=("d9",))
        persistence.save(agent, _state(kept, stale), **CONFIG)

        restored = _GraphState()
        assert persistence.load(agent, restored, **CONFIG) is True
        assert set(restored.cards) == {"kept"}

    def test_an_artifact_card_is_kept_on_its_reference_alone(self):
        """It addresses no message, so the identity guard has nothing to check it against."""
        agent = _agent("d0")
        artifact = _card("artifact ref-7", 0, kind="artifact")
        persistence.save(agent, _state(_card("kept", 0, dialogue=("d0",)), artifact), **CONFIG)

        restored = _GraphState()
        persistence.load(agent, restored, **CONFIG)

        assert "artifact ref-7" in restored.cards

    def test_an_edge_to_a_dropped_card_is_dropped_with_it(self):
        """So the loaded graph equals the derived one, which is what keeps both paths deciding alike."""
        agent = _agent("d0")
        kept = _card("kept", 0, dialogue=("d0",))
        stale = _card("stale", 1, dialogue=("d9",))
        persistence.save(
            agent,
            _state(kept, stale, links={"kept": [Link("similar", "stale", 0.9), Link("tool", "run_query", 0.6)]}),
            **CONFIG,
        )

        restored = _GraphState()
        persistence.load(agent, restored, **CONFIG)

        assert [link.kind for link in restored.links["kept"]] == ["tool"]

    def test_a_reuse_note_for_a_dropped_card_is_dropped_with_it(self):
        agent = _agent("d0")
        persistence.save(
            agent,
            _state(_card("kept", 0, dialogue=("d0",)), _card("stale", 1, dialogue=("d9",)), reuse={"stale": (1.0, 9)}),
            **CONFIG,
        )

        restored = _GraphState()
        persistence.load(agent, restored, **CONFIG)

        assert restored.reuse == {}

    def test_every_card_gone_falls_back_to_the_scan(self):
        agent = _agent("d0")
        persistence.save(agent, _state(_card("stale", 0, dialogue=("d9",))), **CONFIG)

        assert persistence.load(agent, _GraphState(), **CONFIG) is False


class TestTheFingerprint:
    @pytest.mark.parametrize("parameter", list(CONFIG))
    def test_a_configuration_change_discards_the_payload(self, parameter):
        """Tags and rarity are functions of the configuration, and the difference is otherwise silent."""
        agent = _agent("d0")
        persistence.save(agent, _state(_card("t", 0, dialogue=("d0",))), **CONFIG)

        changed = {**CONFIG, parameter: CONFIG[parameter] + 1}
        assert persistence.load(agent, _GraphState(), **changed) is False

    def test_a_changed_link_threshold_discards_the_payload(self):
        """The stored links are a function of it, and a loaded link set is not re-measured."""
        agent = _agent("d0")
        persistence.save(agent, _state(_card("t", 0, dialogue=("d0",))), **CONFIG)

        assert persistence.load(agent, _GraphState(), **{**CONFIG, "link_threshold": 0.65}) is False

    def test_an_unknown_version_discards_the_payload(self):
        agent = _agent("d0")
        persistence.save(agent, _state(_card("t", 0, dialogue=("d0",))), **CONFIG)
        payload = agent.state.get(persistence._STATE_KEY)
        agent.state.set(persistence._STATE_KEY, {**payload, "version": persistence._VERSION + 1})

        assert persistence.load(agent, _GraphState(), **CONFIG) is False


class TestFailingOpen:
    def test_no_payload_reports_that_the_caller_should_scan(self):
        assert persistence.load(_agent("d0"), _GraphState(), **CONFIG) is False

    @pytest.mark.parametrize("payload", ["not a dict", 7, [], None], ids=["str", "int", "list", "none"])
    def test_a_payload_of_the_wrong_shape_reports_the_same(self, payload):
        agent = _agent("d0")
        agent.state.set(persistence._STATE_KEY, payload)

        assert persistence.load(agent, _GraphState(), **CONFIG) is False

    def test_a_corrupt_payload_does_not_raise(self):
        """A store is not ours to trust: what came back may not be what we wrote."""
        agent = _agent("d0")
        agent.state.set(persistence._STATE_KEY, {"version": persistence._VERSION, "cards": [{"title": "t"}]})

        assert persistence.load(agent, _GraphState(), **CONFIG) is False

    def test_a_store_that_refuses_the_write_does_not_raise(self):
        """A graph that could not be stored costs a scan on the next process, never a failed turn."""

        class Refusing:
            def set(self, key, value):
                raise RuntimeError("read-only")

            def get(self, key=None):
                return None

        agent = SimpleNamespace(state=Refusing(), messages=[])
        persistence.save(agent, _state(_card("t", 0, dialogue=("d0",))), **CONFIG)

    def test_a_load_failure_leaves_the_state_untouched(self):
        agent = _agent("d0")
        agent.state.set(persistence._STATE_KEY, {"version": persistence._VERSION, "cards": [{"title": "t"}]})
        state = _GraphState()

        persistence.load(agent, state, **CONFIG)

        assert state == _GraphState()


def test_the_payload_survives_a_real_session_manager(tmp_path):
    """The point of using ``agent.state``: file, S3, AgentCore and custom are the session manager's
    problem, not this module's. One backend exercised end to end is enough to prove the wiring."""
    from strands import Agent
    from strands.agent.conversation_manager import NullConversationManager
    from strands.session import FileSessionManager

    message = {"role": "user", "content": [{"text": "hi"}], "tracking_id": "d0"}

    manager = FileSessionManager(session_id="graph-round-trip", storage_dir=str(tmp_path))
    agent = Agent(conversation_manager=NullConversationManager(), session_manager=manager, callback_handler=None)
    agent.messages.append(message)
    # Through the manager, so the message reaches the session the way the hook would put it there.
    manager.append_message(message, agent)
    persistence.save(agent, _state(_card("extratos", 0, dialogue=("d0",))), **CONFIG)
    manager.sync_agent(agent)

    revived = Agent(
        conversation_manager=NullConversationManager(),
        session_manager=FileSessionManager(session_id="graph-round-trip", storage_dir=str(tmp_path)),
        callback_handler=None,
    )
    restored = _GraphState()

    # The message came back with its durable identity, so the identity guard has something to pass.
    assert [entry.get("tracking_id") for entry in revived.messages] == ["d0"]
    assert persistence.load(revived, restored, **CONFIG) is True
    assert "extratos" in restored.cards

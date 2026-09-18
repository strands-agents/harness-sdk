"""Unit tests of ``render_final_block``: the block derived from the list that actually left.

Every test here builds the pair the function reads — the request, and the removed list — and asserts on
the text that comes out. What the pair encodes is the one thing the module exists for: a part that
survived contributes nothing, so the request alone never decides anything.

The removed list is written by hand rather than produced by ``apply_removal``. The guards have their
own suite, and the interesting inputs here are the ones a guard produces *rarely* — a single pinned
message inside a collapsed Card, half a tool pair held back by protection — which are cheaper to state
directly than to coax a generator into drawing.

``InjectionContext`` is the real dataclass with ``state`` and ``agent`` left as ``None``: the render
reads ``messages`` and nothing else, and a double would only hide that.
"""

import copy

import pytest

from strands.injection.types import InjectionContext
from strands.vended_plugins.context_graph.compaction import (
    _FRAGMENT_INDENT,
    render_final_block,
)
from strands.vended_plugins.context_graph.state import Card, CardChoice, ToolPair, _GraphState

from .conftest import frozen_choice

_DESCRIPTION_TOKENS = 100
"""The plugin's own default, so the budgeting these tests see is the one production sees.

Wide enough that the small fixtures below never brush the ceiling: a test that silently started
hitting the budget would be asserting on the budget rather than on what it was written to assert.
"""


def _card(
    title,
    turn,
    dialogue_ids,
    evidence_ids,
    *,
    description="",
    numeric_lines=(),
    pairs=(),
    references=(),
    tool_names=frozenset(),
    kind="subject",
):
    """Build a Card carrying only the fields the final block reads."""
    return Card(
        title=title,
        kind=kind,
        turn=turn,
        dialogue_ids=tuple(dialogue_ids),
        evidence_ids=tuple(evidence_ids),
        pairs=tuple(pairs),
        tool_names=tool_names,
        references=tuple(references),
        numeric_lines=tuple(numeric_lines),
        tags=(),
        description=description,
        reference="ref-1" if kind == "artifact" else None,
    )


def _state(*cards, choice=None):
    """A graph state holding ``cards`` and, optionally, the frozen choice over them."""
    state = _GraphState()
    for card in cards:
        state.cards[card.title] = card
    state.turn = len(state.cards)
    if choice is not None:
        state.choice = choice
    return state


def _context(*tracking_ids):
    """An injection context over a removed list holding exactly ``tracking_ids``, in order."""
    messages = [
        {"role": "user", "content": [{"text": f"retained {tracking_id}"}], "tracking_id": tracking_id}
        for tracking_id in tracking_ids
    ]
    return InjectionContext(messages=messages, state=None, agent=None)


def _collapsed(state, requested, *retained_ids, description_tokens=_DESCRIPTION_TOKENS):
    """Render the block for ``requested`` against a removed list holding ``retained_ids``."""
    return render_final_block(
        _context(*retained_ids), state, frozenset(requested), description_tokens=description_tokens
    )


# --- a part contributes only when all of it left -----------------------------------------------


def test_a_part_that_fully_left_contributes_its_fragment():
    """Requirement 9.4: the dialogue in description folds the Card's description at the end."""
    card = _card("t0", 0, ("d0", "d1"), (), description="t0\nbalance: 1.200,00")
    state = _state(card, choice=frozen_choice({"t0": CardChoice("description", "full")}))

    block = _collapsed(state, {"d0", "d1"})

    assert "- t0" in block
    assert "balance: 1.200,00" in block


def test_a_part_preserved_by_a_guard_contributes_nothing():
    """Requirement 11.7: one surviving message makes the whole part full content, by derivation.

    The choice still says description, and the request still holds both identities. What changed is the
    result — ``d1`` came back — and the result is what the render reads.
    """
    card = _card("t0", 0, ("d0", "d1"), (), description="t0\nbalance: 1.200,00")
    state = _state(card, choice=frozen_choice({"t0": CardChoice("description", "full")}))

    assert _collapsed(state, {"d0", "d1"}, "d1") is None


def test_the_surviving_part_is_silent_while_the_other_still_speaks():
    """The two axes are read independently: a pinned dialogue message does not mute the evidence."""
    card = _card(
        "t0",
        0,
        ("d0",),
        ("e0", "e1"),
        description="t0\nignored",
        numeric_lines=("R$ 47.832,15",),
        pairs=(ToolPair("tu1", "run_query", ("e0", "e1"), consumed=True),),
    )
    state = _state(card, choice=frozen_choice({"t0": CardChoice("description", "description")}))

    block = _collapsed(state, {"d0", "e0", "e1"}, "d0")

    assert "R$ 47.832,15" in block
    assert "ignored" not in block


def test_content_never_appears_at_two_resolutions_in_the_same_call():
    """Requirements 11.7 and 9.4 together, over the shape a pin creates on one half of a tool pair.

    ``e1`` is retained, so the evidence is whole in the messages and must not be collapsed as well.
    """
    card = _card(
        "t0",
        0,
        ("d0",),
        ("e0", "e1"),
        description="t0",
        numeric_lines=("R$ 47.832,15",),
        pairs=(ToolPair("tu1", "run_query", ("e0", "e1"), consumed=True),),
    )
    state = _state(card, choice=frozen_choice({"t0": CardChoice("full", "description")}))

    assert _collapsed(state, {"e0", "e1"}, "e1") is None


def test_an_empty_part_contributes_nothing():
    """A turn with no tool call has no evidence to collapse, so it claims none.

    ``t1``'s evidence is empty and its resolution is description, which under a bare subset test would
    read as "wholly absent" and put the Card in the block with numeric lines nothing removed.
    """
    state = _state(
        _card("t0", 0, ("d0",), (), description="t0"),
        _card("t1", 1, ("d1",), (), description="t1", numeric_lines=("1200",)),
        choice=frozen_choice(
            {
                "t0": CardChoice("description", "full"),
                "t1": CardChoice("full", "description"),
            }
        ),
    )

    block = _collapsed(state, {"d0"})

    assert "- t1" not in block
    assert "1200" not in block


# --- what each axis contributes ------------------------------------------------------------------


def test_a_dialogue_in_title_contributes_the_title_line_and_nothing_else():
    """Requirement 4.2: the entry is the address, and the address alone is the whole entry."""
    card = _card("t0", 0, ("d0",), (), description="t0\nbalance: 1.200,00")
    state = _state(card, choice=frozen_choice({"t0": CardChoice("title", "full")}))

    block = _collapsed(state, {"d0"})

    assert "- t0" in block
    assert "balance: 1.200,00" not in block


def test_the_evidence_contributes_tools_references_and_the_numeric_lines():
    """Requirement 4.3's evidence half, folded literally at the end of the call."""
    card = _card(
        "t0",
        0,
        (),
        ("e0", "e1"),
        references=("ref-7", "ref-7", "ref-9"),
        numeric_lines=("| ativo | 12,50 |", "total: 3.451,90 BRL"),
        pairs=(
            ToolPair("tu1", "run_query", ("e0",), consumed=True),
            ToolPair("tu2", "run_query", ("e1",), consumed=True),
        ),
    )
    state = _state(card, choice=frozen_choice({"t0": CardChoice("full", "description")}))

    block = _collapsed(state, {"e0", "e1"})

    assert "tools: run_query (2)" in block
    assert "references: ref-7, ref-9" in block
    assert "| ativo | 12,50 |" in block
    assert "total: 3.451,90 BRL" in block


def test_the_evidence_numeric_lines_are_bounded_by_the_description_budget():
    """A Card's entry costs the Description's ceiling, whatever the size of the table behind it.

    The regression this pins was measured and not imagined. ``Card.numeric_lines`` holds every line of
    the turn that carried a number, so a turn whose tool returned a table put its whole preview back
    into every call for the rest of the session — about a thousand tokens per call over 18 turns.
    """
    lines = tuple(f"row {index} | {index}.000,00 | {index * 7} ms" for index in range(200))
    card = _card("t0", 0, (), ("e0",), numeric_lines=lines)
    state = _state(card, choice=frozen_choice({"t0": CardChoice("full", "description")}))

    block = _collapsed(state, {"e0"}, description_tokens=100)

    fragments = [line for line in block.splitlines() if line.startswith(_FRAGMENT_INDENT)]
    # The budget covers the fragments, which is what grows with the table. The indent, the entry's
    # title line and the fixed markers are per Card and per call, and neither one scales with it.
    assert sum(len(fragment) - len(_FRAGMENT_INDENT) + 1 for fragment in fragments) <= 100 * 4
    assert lines[0] in block
    assert lines[-1] not in block
    # And the point of the ceiling: the whole table would have been an order of magnitude larger.
    assert len(block) < len("\n".join(lines)) // 5


def test_the_omitted_numeric_lines_are_counted_in_the_block():
    """Requirement 4.6 applied to the block: a gap the model can see is a gap it can close.

    Silently keeping the first rows of a table reads as the whole table, and a question asking for the
    largest value is then answered from a subset — wrong, and wrong without a symptom.
    """
    lines = tuple(f"row {index} | {index}.000,00" for index in range(200))
    card = _card("t0", 0, (), ("e0",), numeric_lines=lines)
    state = _state(card, choice=frozen_choice({"t0": CardChoice("full", "description")}))

    block = _collapsed(state, {"e0"}, description_tokens=100)

    assert "numeric lines omitted)" in block


def test_a_budget_too_small_for_a_single_line_keeps_the_addresses():
    """The tools and references lines are what make the gap closable, so they never lose the budget."""
    card = _card(
        "t0",
        0,
        (),
        ("e0",),
        references=("ref-7",),
        numeric_lines=("total: 3.451,90 BRL",),
        pairs=(ToolPair("tu1", "run_query", ("e0",), consumed=True),),
    )
    state = _state(card, choice=frozen_choice({"t0": CardChoice("full", "description")}))

    block = _collapsed(state, {"e0"}, description_tokens=1)

    assert "tools: run_query (1)" in block
    assert "references: ref-7" in block
    assert "total: 3.451,90 BRL" not in block
    assert "(+1 numeric lines omitted)" in block


def test_the_numeric_lines_are_copied_literally():
    """Requirement 4.4 downstream: the last place the numbers pass through does not rewrite them."""
    line = "BTG Pactual\u00a0..\u00a0R$ 47.832,15"
    card = _card("t0", 0, (), ("e0",), numeric_lines=(line,))
    state = _state(card, choice=frozen_choice({"t0": CardChoice("full", "description")}))

    assert line in _collapsed(state, {"e0"})


def test_a_line_contributes_once_per_card():
    """Both parts left, and the description already carries what the evidence would repeat."""
    card = _card(
        "t0",
        0,
        ("d0",),
        ("e0",),
        description="t0\ntools: run_query (1)\n1200",
        numeric_lines=("1200", "3400"),
        pairs=(ToolPair("tu1", "run_query", ("e0",), consumed=True),),
    )
    state = _state(card, choice=frozen_choice({"t0": CardChoice("description", "description")}))

    block = _collapsed(state, {"d0", "e0"})

    assert block.count("tools: run_query (1)") == 1
    assert block.count("1200") == 1
    assert "3400" in block  # what the description had to leave out still gets in


def test_the_title_is_never_repeated_inside_its_own_entry():
    """The description opens on the Card's title, and the entry's first line already is it."""
    card = _card("t0", 0, ("d0",), (), description="t0\nbalance: 1200")
    state = _state(card, choice=frozen_choice({"t0": CardChoice("description", "full")}))

    assert _collapsed(state, {"d0"}).count("t0") == 1


# --- no fragment at all ---------------------------------------------------------------------------


def test_nothing_dropped_returns_none():
    """Requirement 9.5: with no fragment the primitive leaves ``dynamic_trailing_blocks`` alone."""
    card = _card("t0", 0, ("d0",), ("e0",), description="t0")
    state = _state(card, choice=frozen_choice({"t0": CardChoice("description", "description")}))

    assert _collapsed(state, set()) is None


def test_an_empty_graph_returns_none():
    """The shape a fresh agent has: no Card, no block."""
    assert render_final_block(_context(), _GraphState(), frozenset(), description_tokens=_DESCRIPTION_TOKENS) is None


def test_a_request_wholly_preserved_by_the_guards_returns_none():
    """Every identity came back, so the removal removed nothing and there is nothing to fold."""
    card = _card("t0", 0, ("d0",), ("e0",), description="t0", numeric_lines=("1200",))
    state = _state(card, choice=frozen_choice({"t0": CardChoice("description", "description")}))

    assert _collapsed(state, {"d0", "e0"}, "d0", "e0") is None


def test_a_card_absent_from_the_choice_contributes_no_fragment():
    """A Card derived after the choice was frozen is read as full content, so it stays silent.

    Its identities cannot be in the request either — this pins the direction of the fail-safe, not a
    reachable state.
    """
    card = _card("t0", 0, ("d0",), (), description="t0\nbalance: 1200")
    state = _state(card, choice=frozen_choice({}))

    block = _collapsed(state, {"d0"})

    assert "- t0" in block
    assert "balance: 1200" not in block


# --- ordering and shape ---------------------------------------------------------------------------


def test_the_cards_come_out_in_ascending_turn_order():
    """Requirement 9.5: the block changes only where the resolution changed, so the order is the turn's."""
    state = _state(
        _card("late", 7, ("d7",), (), description="late"),
        _card("early", 2, ("d2",), (), description="early"),
        _card("middle", 4, ("d4",), (), description="middle"),
        choice=frozen_choice({title: CardChoice("description", "full") for title in ("late", "early", "middle")}),
    )

    block = _collapsed(state, {"d2", "d4", "d7"})

    assert block.index("- early") < block.index("- middle") < block.index("- late")


def test_every_card_that_lost_a_part_has_its_title_in_the_block():
    """Requirement 4.2: the Title of every Card is in the call — here, in the block."""
    state = _state(
        _card("t0", 0, ("d0",), (), description="t0"),
        _card("t1", 1, ("d1",), (), description="t1"),
        _card("t2", 2, ("d2",), (), description="t2"),
        choice=frozen_choice(
            {
                "t0": CardChoice("title", "full"),
                "t1": CardChoice("description", "full"),
                "t2": CardChoice("full", "full"),
            }
        ),
    )

    block = _collapsed(state, {"d0", "d1"})

    assert "- t0" in block
    assert "- t1" in block
    assert "- t2" not in block  # it lost nothing, so its content is in the retained messages


def test_the_block_names_the_three_retrieval_tools():
    """The gap has to read as closable, or the model answers from the summary instead of asking."""
    card = _card("t0", 0, ("d0",), (), description="t0")
    state = _state(card, choice=frozen_choice({"t0": CardChoice("description", "full")}))

    block = _collapsed(state, {"d0"})

    assert "expand_card" in block
    assert "expand_artifact" in block
    assert "find_context" in block


def test_the_return_is_plain_text():
    """The block has no ``role``, is not a message, and takes no position in the list."""
    card = _card("t0", 0, ("d0",), (), description="t0")
    state = _state(card, choice=frozen_choice({"t0": CardChoice("description", "full")}))

    assert isinstance(_collapsed(state, {"d0"}), str)


@pytest.mark.parametrize("kind", ["subject", "artifact"])
def test_an_artifact_card_renders_like_a_subject(kind):
    """Requirement 11.8 lives in the scoring; the render has no special case for an artifact."""
    card = _card("t0", 0, ("d0",), (), description="t0\nreference: ref-1", kind=kind)
    state = _state(card, choice=frozen_choice({"t0": CardChoice("description", "full")}))

    assert "reference: ref-1" in _collapsed(state, {"d0"})


# --- nothing is mutated, and two runs agree -------------------------------------------------------


def test_nothing_is_mutated():
    """Neither the removed list, nor the dicts inside it, nor the graph state comes out changed."""
    card = _card(
        "t0",
        0,
        ("d0",),
        ("e0",),
        description="t0\n1200",
        numeric_lines=("1200", "3400"),
        pairs=(ToolPair("tu1", "run_query", ("e0",), consumed=True),),
    )
    state = _state(card, choice=frozen_choice({"t0": CardChoice("description", "description")}))
    context = _context("kept")
    messages_before = copy.deepcopy(context.messages)
    cards_before = copy.deepcopy(state.cards)
    requested = frozenset({"d0", "e0"})

    render_final_block(context, state, requested, description_tokens=_DESCRIPTION_TOKENS)

    assert context.messages == messages_before
    assert state.cards == cards_before
    assert dict(state.choice.by_title) == {"t0": CardChoice("description", "description")}
    assert requested == frozenset({"d0", "e0"})


def test_two_runs_over_the_same_inputs_agree_character_for_character():
    """Requirement 9.11: same list, same choice, same block."""
    state = _state(
        _card("t0", 0, ("d0",), ("e0",), description="t0\n1200", numeric_lines=("1200", "3400")),
        _card("t1", 1, ("d1",), (), description="t1"),
        choice=frozen_choice(
            {
                "t0": CardChoice("description", "description"),
                "t1": CardChoice("title", "full"),
            }
        ),
    )

    assert _collapsed(state, {"d0", "e0", "d1"}) == _collapsed(state, {"d0", "e0", "d1"})


def test_a_retained_message_without_a_durable_identity_is_ignored():
    """An unaddressed message cannot preserve a part, because it names none."""
    card = _card("t0", 0, ("d0",), (), description="t0\nbalance: 1200")
    state = _state(card, choice=frozen_choice({"t0": CardChoice("description", "full")}))
    context = InjectionContext(
        messages=[{"role": "user", "content": [{"text": "no address at all"}]}],
        state=None,
        agent=None,
    )

    assert "balance: 1200" in render_final_block(
        context, state, frozenset({"d0"}), description_tokens=_DESCRIPTION_TOKENS
    )

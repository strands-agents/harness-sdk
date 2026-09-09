"""The Note, and the choice it decides. This step covers the first pass, the warm-up and propagation.

The Note is computed in two passes per turn. The first pass is everything that comes from outside the
graph — the similarity between the turn's question and each Card's description, the continuity of the
active subject, and the Fed-Back Note left by an explicit model request. Decay never touches it:
decay applies exclusively to inherited note and to the Fed-Back Note (Requirement 7.6), so the first
pass enters with no factor at all.

**The second pass reads a frozen ``base`` and writes ``note``.** No write is read within the same
pass, which is what makes propagation exactly one hop (Requirement 7.4) and confluent: the visit order
of the Cards cannot change the result, so permuting the insertion order of Cards or of links leaves
every note identical (Requirement 8.12).

**A tool name is not a Card and holds no note of its own.** It is the axis along which two Cards that
used the same tool reach each other in a single Card→Card step. Summing per hub first and then
subtracting each Card's own contribution — because a Card must not propagate note to itself through
its own tool — is what keeps the cost at ``O(Cards + Links)`` instead of degree squared
(Requirement 17.5).

**The warm-up short circuit runs before the matcher, not after**, so no embedding is paid for a
decision already determined by the size of the graph (Requirement 7.7). ``expand_threshold == 0.0`` is
the documented off switch, implemented as a fixed full pass rather than as "every note clears the
threshold".

**Failing open is the whole failure policy.** An exception, a timeout, an empty sequence, a length
that does not match the number of descriptions, or an answer that is not a sequence at all: all five
end the same way — full content everywhere, exactly one debug-level log carrying ``exc_info``, and no
exception reaching the agent loop (Requirements 7.11, 16.9). The malformed answers are turned into a
raised error *inside* the guarded block so that the single log carries a real traceback instead of an
empty ``exc_info``.

**Order of iteration is fixed.** Titles are always walked in ascending turn order, so every sum
happens in the same sequence on every run over the same state (Requirement 8.12).

**The resolution only ever steps down by budget, never by verdict.** ``distribute`` walks the Cards in
descending note and hands out full content until the body budget runs out, and a Card whose note
cleared ``expand_threshold`` but no longer fits steps down exactly one rung, to description, never to
title (Requirement 8.6). No Card is ever dropped from the returned mapping: the domain of the choice
is the whole set of Cards (Requirement 8.9).
"""

from __future__ import annotations

import logging
import math
from collections.abc import Mapping, Sequence
from types import MappingProxyType

from .matcher import SimilarityMatcher
from .state import Card, CardChoice, Resolution, TurnChoice, _GraphState

__all__ = [
    "compute_notes",
    "distribute",
    "expire_reuse",
    "full_pass_choice",
    "record_reuse",
    "select",
    "titles_in_turn_order",
    "warm_up_choice",
]

logger = logging.getLogger(__name__)

_CONTINUITY_BONUS = 1.0
"""Continuity added to the active subject in the first pass.

``1.0`` is greater than any admissible threshold, which makes Requirement 6.6 — the active subject's
dialogue in full content — hold by arithmetic instead of by a branch of code. Not exposed as a
parameter: a value below ``expand_threshold`` would break that requirement.
"""

_REUSE_BONUS = 1.0
"""Fed-back note granted by a successful retrieval request.

Same value and same arithmetic as ``_CONTINUITY_BONUS``: the model's explicit request has to beat the
threshold, or the tool would have no effect on the turn it was called in.
"""

_DECAY = 0.5
"""The single decay factor, used for neighbourhood note and for the Fed-Back Note alike.

One factor and not two, because Requirement 7.6 treats them as one: decay applies to inherited note
and to the fed-back note, and to nothing else. The value is not calibrated and is not exposed.
"""

_W_TOOL = 0.6
"""Weight of the tool-hub axis: two Cards that used the same tool reach each other through it."""

_W_ARTIFACT = 0.6
"""Weight of the artifact link, from the Card that cited a reference to the artifact's Card."""

_W_PREVIOUS = 0.4
"""Weight of the ``follows`` link, from a Card to the Card of the turn before it."""

_STRUCTURAL_WEIGHTS: Mapping[str, float] = MappingProxyType(
    {
        "follows": _W_PREVIOUS,
        "artifact": _W_ARTIFACT,
    }
)
"""Factor per link kind the note inherits along. Private, and none of the weights is calibrated.

Two kinds are absent, for different reasons. ``tool`` targets a tool name rather than a Card, so it
is not a note destination at all and is walked separately by :func:`_spread_over_tool_hubs`.
``similar`` targets a Card and is deliberately not inherited along: it answers *"can the call reach
this Card"*, which is the selection's question, and not *"is this Card pertinent to the question"*,
which is the note's. Its weight carries a cosine of 0.5 to 0.8, so one such edge would hand over up
to 0.4 while the whole band the matcher answers in spans 0.35 to 0.75 — the strongest channel in the
propagation would be the least informative one, and ``link_threshold`` only makes that rarer.
"""

_TOKENS_PER_MESSAGE = 250
"""Fallback estimate of the token cost of one addressed message, used when no cost table is supplied.

A Card holds addresses and never content (see ``state.py``), so it cannot measure its own parts: the
text lives in ``agent.messages``. The caller that *does* hold the messages passes ``costs``; without
it the count of durable identities stands in for the size. Coarse on purpose: a wrong estimate spends
budget and never breaks a call."""


def full_pass_choice() -> TurnChoice:
    """The regression short circuit: every Card keeps full content.

    Returns:
        A frozen, empty choice with ``full_pass`` set. The handler reading it returns the received
        context by object identity, so the assembled context is identical, field by field, to the one
        produced without the feature.
    """
    return TurnChoice(by_title=MappingProxyType({}), full_pass=True)


def warm_up_choice(
    state: _GraphState,
    *,
    expand_threshold: float,
    min_cards: int,
) -> TurnChoice | None:
    """Decide whether the whole choice is skipped, without ever reaching the matcher.

    Called before anything is scored, so no embedding call is made for a decision already determined by
    the size of the graph (Requirement 7.7).

    Args:
        state: The graph state. Read only; never mutated.
        expand_threshold: Note at or above which a Card is full content. ``0.0`` is the off switch.
        min_cards: Below this many Cards the choice is skipped entirely.

    Returns:
        A full-pass choice when the choice must be skipped, or ``None`` when scoring should proceed.
    """
    if expand_threshold == 0.0 or len(state.cards) < min_cards:
        return full_pass_choice()
    return None


def titles_in_turn_order(state: _GraphState) -> tuple[str, ...]:
    """Titles in ascending turn order, with the title itself breaking ties.

    The descriptions reach the matcher in this order, the scores come back aligned to it, and every
    later sum walks it unchanged.

    Args:
        state: The graph state. Read only; never mutated.

    Returns:
        Every Card title, ordered by ``(turn, title)``.
    """
    return tuple(sorted(state.cards, key=lambda title: (state.cards[title].turn, title)))


def record_reuse(state: _GraphState, title: str, cycle: int, *, reuse_ttl_cycles: int) -> None:
    """Grant ``title`` the fed-back note, restarting its countdown at ``reuse_ttl_cycles``.

    Called only when one of the three retrieval tools completed **successfully**; a completion with an
    error records nothing (Requirement 13.8).

    Granting and renewing are the same write: a Card that already holds a fed-back note simply has its
    countdown restarted (Requirement 13.5). The bonus goes in undecayed, so it clears any admissible
    threshold on the very turn of the call.

    ``reuse_ttl_cycles == 0`` writes nothing: the fed-back note is only ever read across turns
    (Requirement 13.6), and the elevation for the remainder of the current turn is the tool's own doing,
    not this map's.

    Args:
        state: Graph state of the agent. Mutated in place, and it is the only place the fed-back note
            ever lives (Requirement 13.7).
        title: Title of the Card the model asked for.
        cycle: Current cycle counter, ``agent.event_loop_metrics.cycle_count``.
        reuse_ttl_cycles: Cycles the fed-back note survives. At least ``0``.
    """
    if reuse_ttl_cycles == 0:
        return

    state.reuse[title] = (_REUSE_BONUS, cycle + reuse_ttl_cycles)


def expire_reuse(state: _GraphState, cycle: int, *, reuse_ttl_cycles: int) -> None:
    """Age every fed-back note by the cycle counter: decay what survives, drop what reached its expiry.

    Age is measured exclusively against the cycle counter (Requirement 13.3): no wall clock, no message
    count, so a slow provider call or a burst of messages inside one cycle never ages a note.

    The decay is applied **here**, at write time, which is the contract ``compute_notes`` reads against:
    the first pass adds ``state.reuse`` with no further factor, so decay never reaches the first pass'
    similarity (Requirement 7.6).

    A note whose expiry cycle has been reached is removed outright rather than left at a small bonus
    (Requirement 13.4), since a value that only ever decays never leaves the state.

    Args:
        state: Graph state of the agent. Mutated in place.
        cycle: Current cycle counter, ``agent.event_loop_metrics.cycle_count``.
        reuse_ttl_cycles: Cycles the fed-back note survives. At least ``0``.
    """
    # Materialize first: the map is mutated while the decision is applied.
    for title, (_bonus, expiry_cycle) in list(state.reuse.items()):
        if cycle >= expiry_cycle:
            del state.reuse[title]
            continue
        # Elapsed cycles since the grant, so the bonus is whole on the cycle it was granted on and
        # halves once per cycle after it. Recomputed from the expiry rather than compounded from the
        # stored value, so running this twice in one cycle cannot decay a note twice.
        elapsed = reuse_ttl_cycles - (expiry_cycle - cycle)
        state.reuse[title] = (_REUSE_BONUS * _DECAY**elapsed, expiry_cycle)


def compute_notes(
    state: _GraphState,
    question: str,
    matcher: SimilarityMatcher,
) -> Mapping[str, float]:
    """The Note per Card. This step is the first pass; propagation is added on top of it.

    The caller has already short-circuited the warm-up cases, so reaching here means the graph is
    worth scoring. Completes without mutating ``state``, and without mutating the sequence of
    descriptions handed to the matcher — the sequence crossing the boundary is a fresh tuple, so its
    elements, order and size are ours to guarantee (Requirement 7.12).

    Args:
        state: The graph state. Read only; never mutated.
        question: The turn's question, embedded under purpose ``"query"`` by the matcher.
        matcher: The similarity matcher. Invoked exactly once.

    Returns:
        One note per Card, keyed by title, never below the similarity that Card was scored with.
        Empty when the matcher failed or answered malformed, which the caller reads as "score nothing,
        send everything".
    """
    titles = titles_in_turn_order(state)
    descriptions = tuple(state.cards[title].description for title in titles)

    similarities = _score(question, descriptions, matcher)
    if similarities is None:
        return {}

    # ---- Pass 1: similarity, continuity, Fed-Back Note. No decay on any of the three. ----
    base = {title: similarities[index] for index, title in enumerate(titles)}

    active_subject = _active_subject(state)
    if active_subject is not None:
        base[active_subject] += _CONTINUITY_BONUS

    for title, (bonus, _expiry_cycle) in state.reuse.items():
        # Already decayed at write time, so it enters the first pass with no further factor. The
        # expiry cycle is spent where the reuse is recorded, not where it is read.
        if title in base:
            base[title] += bonus

    # ---- Pass 2: propagation, exactly one hop, over a frozen `base`. ----
    return _propagate(state, titles, base)


def _propagate(
    state: _GraphState,
    titles: Sequence[str],
    base: Mapping[str, float],
) -> dict[str, float]:
    """Spread the first pass over the links, exactly one hop, and only ever adding.

    ``base`` is frozen for the whole of this function: every read comes out of it and every write goes
    into ``note``, so no write is read within the same pass. That makes the hop single and the result
    confluent, hence the two link families may be walked in either order.

    Args:
        state: The graph state. Read only; never mutated.
        titles: Every Card title in fixed turn order.
        base: The first pass, complete. Read only.

    Returns:
        The note per Card, with ``note[title] >= base[title]`` for every Card.
    """
    note = dict(base)
    _spread_over_card_edges(state, titles, base, note)
    _spread_over_tool_hubs(state, titles, base, note)
    return note


def _spread_over_card_edges(
    state: _GraphState,
    titles: Sequence[str],
    base: Mapping[str, float],
    note: dict[str, float],
) -> None:
    """Card→Card edges — ``follows``, ``similar``, ``artifact`` — from source to target.

    A link pointing at a title the graph no longer holds is skipped rather than raising: the note is
    computed per turn and the links are rebuilt by scan, so a dangling target is a stale edge and not
    a corrupt state.

    Args:
        state: The graph state. Read only.
        titles: Every Card title in fixed turn order.
        base: The frozen first pass. Read only.
        note: Accumulator, mutated in place.
    """
    for title in titles:
        inherited = base[title] * _DECAY
        for link in state.links.get(title, ()):
            weight = _STRUCTURAL_WEIGHTS.get(link.kind)
            # `None` covers the two kinds the note does not inherit along: `tool`, whose target is a
            # tool name and never a note destination, and `similar`, which the selection walks
            # instead. See `_STRUCTURAL_WEIGHTS`.
            if weight is None or link.target not in note:
                continue
            note[link.target] += inherited * link.weight * weight


def _spread_over_tool_hubs(
    state: _GraphState,
    titles: Sequence[str],
    base: Mapping[str, float],
    note: dict[str, float],
) -> None:
    """Tool-name hubs, in ``O(Cards + Links)`` rather than in degree squared.

    Two walks instead of one nested walk: sum the frozen base per hub, then hand each Card the hub
    total minus its own contribution. Subtracting is what keeps a Card from propagating note to itself
    through its own tool, and the subtrahend is one of the addends of a sum of non-negative terms, so
    the difference is never negative and propagation only ever adds.

    Args:
        state: The graph state. Read only.
        titles: Every Card title in fixed turn order.
        base: The frozen first pass. Read only.
        note: Accumulator, mutated in place.
    """
    hub_total: dict[str, float] = {}
    for title in titles:
        for link in state.links.get(title, ()):
            if link.kind == "tool":
                hub_total[link.target] = hub_total.get(link.target, 0.0) + base[title]

    for title in titles:
        for link in state.links.get(title, ()):
            if link.kind == "tool":
                others = hub_total[link.target] - base[title]
                note[title] += others * link.weight * _W_TOOL * _DECAY


def select(
    notes: Mapping[str, float],
    state: _GraphState,
    *,
    recent_cards: int,
    select_top_k: int,
) -> frozenset[str]:
    """Titles the call addresses: the recency window, the note's pick, and one hop from that pick.

    Three sources, and each answers a question the other two cannot:

    - **The recency window** covers the referent of a question that carries no content words. "And
      that other one?" resembles nothing, so no score reaches it, but it is almost always about the
      last few turns.
    - **The note's pick** covers the return to an old subject, which recency by definition cannot.
    - **One hop from the pick** covers the question that names an intermediate rather than the answer.
      "That error in the report I asked for yesterday" resembles the Card about the error, which cites
      an artifact, which belongs to a Card about the report that resembles the question not at all.
      The edge is the only route there.

    Only Card→Card edges are followed. A ``tool`` edge targets a tool name, and a tool name is not a
    Card — it is the axis two Cards reach each other *through*, so the hop it enables is already
    accounted for in the note by :func:`_spread_over_tool_hubs`.

    This hop is the whole job of the ``similar`` edge: the note does not inherit along it (see
    ``_STRUCTURAL_WEIGHTS``), so widening what the call *reaches* is the only thing it does, and the
    ranking is left exactly as the matcher produced it.

    The hop is taken from the note's pick and not from the window: the window is the tail of the
    conversation, so its neighbours are almost all inside it already.

    Args:
        notes: One note per Card. A missing title reads as ``0.0``.
        state: The graph state. Read only; never mutated.
        recent_cards: How many of the most recent Cards are always addressed. ``0`` disables the
            window; a conversation with fewer Cards than this has all of them selected either way.
        select_top_k: How many Cards the note adds beyond the window.

    Returns:
        The addressed titles. A Card outside it does not reach the call at all, not even as its
        Title — the model learns it exists from the count the final block states, and reaches it with
        ``find_context``.
    """
    ordered = titles_in_turn_order(state)
    selected = set(ordered[len(ordered) - recent_cards :] if recent_cards > 0 else ())

    ranked = [title for title in _titles_by_descending_note(state, notes) if title not in selected]
    picked = ranked[:select_top_k] if select_top_k > 0 else []
    selected.update(picked)

    for title in picked:
        for link in state.links.get(title, ()):
            if link.kind != "tool" and link.target in state.cards:
                selected.add(link.target)

    return frozenset(selected)


def distribute(
    notes: Mapping[str, float],
    state: _GraphState,
    *,
    expand_threshold: float,
    collapse_floor: float,
    body_budget: int | None,
    costs: Mapping[tuple[str, str], int] | None = None,
    selected: frozenset[str] | None = None,
) -> TurnChoice:
    """Hand out the body budget in descending note, and let the resolution step down only by budget.

    Two axes, decided independently (Requirement 6.1), and they read different things:

    - **Dialogue, three rungs, decided by the note.** The active subject is full content, because
      ``_CONTINUITY_BONUS`` puts its note above any admissible threshold, which puts it first in the
      queue and therefore ahead of any competition for the budget (Requirement 6.6). A note at
      or above ``expand_threshold`` is full content when it fits the remaining budget and *description*
      when it does not — one rung down, never title (Requirements 8.3, 8.6). Between the two thresholds
      it is description; below ``collapse_floor`` it is title (Requirements 8.4, 8.5).
    - **Evidence, two rungs, decided by the order of the messages and never by the note.** Every pair
      consumed means the numbers were already carried into the assistant's own text, so what is left to
      preserve is the numeric lines: description. An unconsumed pair is work in progress and travels
      whole (Requirements 6.3, 6.5).

    An artifact Card never reaches full content here, whatever its note: search alone must never bring
    100k tokens back (Requirement 11.8). It is short-circuited *before* the debit, so the budget it
    would have spent is left for a Card that can use it.

    Args:
        notes: One note per Card, as returned by ``compute_notes``. A missing title reads as ``0.0``.
        state: The graph state. Read only; never mutated.
        expand_threshold: Note at or above which the dialogue is full content, budget permitting.
        collapse_floor: Note below which the dialogue is title only.
        body_budget: Token ceiling across the parts in full content, or ``None`` for no ceiling at all.
        costs: Estimated token cost per ``(title, part)``, where ``part`` is ``"dialogue"`` or
            ``"evidence"``. When omitted, the count of addressed messages stands in for the size.
        selected: Titles the call addresses, as :func:`select` returned them, or ``None`` when
            selection is off. A Card outside the selection is put at title on both axes so its
            messages leave the call, and the compaction then emits no entry for it — so it costs the
            call nothing at all, which is the point of selecting.

    Returns:
        The turn choice, with ``full_pass`` false and ``by_title`` frozen. Its domain is exactly the set
        of Cards: every Card is decided, whether or not the call addresses it.
    """
    active_subject = _active_subject(state)
    remaining = body_budget
    decided: dict[str, CardChoice] = {}

    for title in _titles_by_descending_note(state, notes):
        card = state.cards[title]
        value = notes.get(title, 0.0)
        is_artifact = card.kind == "artifact"

        if selected is not None and title not in selected:
            # Decided rather than omitted: the removal reads an absent entry as full content, so
            # leaving it out would keep in the call exactly the Card the selection just excluded.
            decided[title] = CardChoice(dialogue="title", evidence="title")
            continue

        # ---- Dialogue axis: three rungs, decided by the note. ----
        # The active subject enters the full-content path by name and not only by note, so continuity
        # survives a caller that scored the graph elsewhere. It still passes the ceiling: the
        # distribution never overruns the budget.
        dialogue: Resolution
        if title == active_subject or value >= expand_threshold:
            cost = _part_cost(card, "dialogue", costs)
            if is_artifact:
                dialogue = "description"
            elif remaining is None or cost <= remaining:
                dialogue = "full"
                remaining = remaining if remaining is None else remaining - cost
            else:
                # Budget exhausted, so it steps down one rung — never to title.
                dialogue = "description"
        elif value >= collapse_floor:
            dialogue = "description"
        else:
            dialogue = "title"

        # ---- Evidence axis: two rungs, decided by message order, never by the note. ----
        evidence: Resolution
        if is_artifact or all(pair.consumed for pair in card.pairs):
            evidence = "description"
        else:
            evidence = "full"
            if remaining is not None:
                # The floor wins over the arithmetic: an unconsumed pair travels whole regardless, so
                # what would have gone negative is clamped instead of denied.
                remaining = max(0, remaining - _part_cost(card, "evidence", costs))

        decided[title] = CardChoice(dialogue=dialogue, evidence=evidence)

    return TurnChoice(by_title=MappingProxyType(decided), full_pass=False, selected=selected)


def _titles_by_descending_note(state: _GraphState, notes: Mapping[str, float]) -> tuple[str, ...]:
    """Titles in descending note, with the turn ordinal and then the title breaking ties.

    Args:
        state: The graph state. Read only.
        notes: One note per Card. A missing title reads as ``0.0``.

    Returns:
        Every Card title, in the order the budget is handed out.
    """
    return tuple(
        sorted(
            state.cards,
            key=lambda title: (-notes.get(title, 0.0), state.cards[title].turn, title),
        )
    )


def _part_cost(card: Card, part: str, costs: Mapping[tuple[str, str], int] | None) -> int:
    """Estimated token cost of one part of a Card in full content.

    Args:
        card: The Card the part belongs to.
        part: ``"dialogue"`` or ``"evidence"``.
        costs: The caller's cost table, or ``None`` to fall back on the count of addressed messages.

    Returns:
        The estimate, never negative.
    """
    if costs is not None:
        return max(0, costs.get((card.title, part), 0))
    if part == "dialogue":
        return len(card.dialogue_ids) * _TOKENS_PER_MESSAGE
    unconsumed = sum(len(pair.tracking_ids) for pair in card.pairs if not pair.consumed)
    return unconsumed * _TOKENS_PER_MESSAGE


def _score(
    question: str,
    descriptions: Sequence[str],
    matcher: SimilarityMatcher,
) -> tuple[float, ...] | None:
    """Score the descriptions, or fail open with exactly one debug log carrying ``exc_info``.

    The malformed answers are raised inside the guarded block on purpose: one exit, one log, one
    traceback, whether the matcher raised or merely answered badly.

    Args:
        question: The turn's question.
        descriptions: The Cards' descriptions, already in fixed order.
        matcher: The similarity matcher.

    Returns:
        One clamped similarity per description, or ``None`` when the matcher was unusable.
    """
    try:
        similarities = matcher.score(question, descriptions)
        if len(similarities) != len(descriptions):
            # Covers the empty sequence too: with at least one Card, empty is a length mismatch.
            raise ValueError(f"similarity count=<{len(similarities)}> | expected=<{len(descriptions)}>")
        return tuple(_clamp(value) for value in similarities)
    except Exception:
        logger.debug(
            "graph similarity unavailable for %d description(s) | falling back to full content",
            len(descriptions),
            exc_info=True,
        )
        return None


def _active_subject(state: _GraphState) -> str | None:
    """Title of the active subject: the Card of the turn immediately before the current one.

    Args:
        state: The graph state. Read only.

    Returns:
        The title, or ``None`` when no Card stands for the previous turn.
    """
    previous = state.turn - 1
    for title in titles_in_turn_order(state):
        if state.cards[title].turn == previous:
            return title
    return None


def _clamp(value: object) -> float:
    """Clamp a similarity into ``[0.0, 1.0]``, mapping ``nan`` to ``0.0``.

    A note has to be totally ordered for the distribution to be deterministic, and ``nan`` is the one
    float that is not.

    Args:
        value: The similarity as answered. A non-numeric value raises, which the caller reads as a
            failure of the matcher.

    Returns:
        The similarity, within the closed interval.
    """
    # A non-numeric answer raises here, which the guarded block reads as a matcher failure.
    number = float(value)  # type: ignore[arg-type]
    if math.isnan(number):
        return 0.0
    return min(1.0, max(0.0, number))

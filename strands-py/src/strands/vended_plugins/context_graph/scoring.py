"""The Note, and the choice it decides. This step covers the first pass, the warm-up and propagation.

Two passes per turn. Pass 1 is everything from outside the graph — question-to-description similarity, the active
subject's continuity, the Fed-Back Note of an explicit model request — and enters with no factor, decay applying only to
inherited note and to the Fed-Back Note (Requirement 7.6). Pass 2 reads a frozen ``base`` and writes ``note``, so no
write is read within the same pass: propagation is exactly one hop (Requirement 7.4) and confluent. Titles are walked in
ascending turn order, so every sum happens in the same sequence on every run over the same state (Requirement 8.12).

A tool name is not a Card and holds no note of its own; it is the axis along which two Cards that used the same tool
reach each other in one Card→Card step. Summing per hub then subtracting each Card's own contribution, so a Card never
propagates note to itself through its own tool, keeps the cost at ``O(Cards + Links)`` rather than degree squared
(Requirement 17.5).

The warm-up short circuit runs before the matcher, so no embedding is paid for a decision the size of the graph already
made (Requirement 7.7). ``expand_threshold == 0.0`` is the documented off switch, a fixed full pass rather than every
note clearing the threshold.

Failing open is the whole failure policy: an exception, a timeout, an empty sequence, a length not matching the number
of descriptions, and a non-sequence answer all end as full content everywhere, one debug log carrying ``exc_info``, and
no exception reaching the agent loop (Requirements 7.11, 16.9). Malformed answers are raised inside the guarded block so
the single log carries a real traceback.

Resolution steps down by budget, never by verdict. ``distribute`` walks the Cards in descending note handing out full
content until the body budget runs out; a Card whose note cleared ``expand_threshold`` but no longer fits steps down one
rung, to description, never to title (Requirement 8.6). No Card is dropped from the returned mapping: the choice's
domain is the whole set of Cards (Requirement 8.9).
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
"""Continuity added to the active subject in the first pass. ``1.0`` exceeds any admissible threshold, so Req. 6.6
(the active subject's dialogue in full content) holds by arithmetic rather than by a branch. Not exposed: a value below
``expand_threshold`` would break that requirement."""

_REUSE_BONUS = 1.0
"""Fed-back note granted by a successful retrieval request. Same value and arithmetic as ``_CONTINUITY_BONUS``: the
model's explicit request must beat the threshold, or the tool would have no effect on the turn it was called in."""

_DECAY = 0.5
"""The single decay factor, for neighbourhood note and Fed-Back Note alike. One factor, not two: Requirement 7.6 applies
decay to inherited note and to the fed-back note and to nothing else. Not calibrated, not exposed."""

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

Two kinds are absent. ``tool`` targets a tool name rather than a Card, so it is no note destination and is walked
separately by :func:`_spread_over_tool_hubs`. ``similar`` targets a Card but is not inherited along: it answers whether
the call can reach a Card, the selection's question, not whether a Card is pertinent, the note's. Its weight carries a
cosine of 0.5 to 0.8, so one such edge would hand over up to 0.4 while the matcher's band spans 0.35 to 0.75, making the
strongest propagation channel the least informative one; ``link_threshold`` only makes that rarer.
"""

_TOKENS_PER_MESSAGE = 250
"""Fallback estimate of the token cost of one addressed message, used when no cost table is supplied.

A Card holds addresses and never content (see ``state.py``), so it cannot measure its own parts: the text lives in
``agent.messages``. The caller holding the messages passes ``costs``; without it the count of durable identities stands
in for the size. Coarse by design: a wrong estimate spends budget and never breaks a call."""


def full_pass_choice() -> TurnChoice:
    """The regression short circuit: every Card keeps full content.

    Returns:
        A frozen, empty choice with ``full_pass`` set. The handler reading it returns the received context by object
        identity, so the assembled context is identical field by field to the one produced without the feature.
    """
    return TurnChoice(by_title=MappingProxyType({}), full_pass=True)


def warm_up_choice(
    state: _GraphState,
    *,
    expand_threshold: float,
    min_cards: int,
) -> TurnChoice | None:
    """Decide whether the whole choice is skipped, without ever reaching the matcher.

    Called before anything is scored, so no embedding is paid for a decision already determined by the size of the graph
    (Requirement 7.7).

    Args:
        state: The graph state. Read only.
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

    The descriptions reach the matcher in this order, the scores come back aligned to it, and every later sum walks it
    unchanged.

    Args:
        state: The graph state. Read only.

    Returns:
        Every Card title, ordered by ``(turn, title)``.
    """
    return tuple(sorted(state.cards, key=lambda title: (state.cards[title].turn, title)))


def record_reuse(state: _GraphState, title: str, cycle: int, *, reuse_ttl_cycles: int) -> None:
    """Grant ``title`` the fed-back note, restarting its countdown at ``reuse_ttl_cycles``.

    Called only when one of the three retrieval tools completed successfully; a completion with an error records nothing
    (Requirement 13.8). Granting and renewing are the same write, so a Card already holding a fed-back note has its
    countdown restarted (Requirement 13.5), and the bonus goes in undecayed so it clears any admissible threshold on the
    turn of the call. ``reuse_ttl_cycles == 0`` writes nothing: the fed-back note is only read across turns (Requirement
    13.6), and the elevation for the rest of the current turn is the tool's own doing, not this map's.

    Args:
        state: Graph state of the agent. Mutated in place, and the only place the fed-back note ever lives (Req. 13.7).
        title: Title of the Card the model asked for.
        cycle: Current cycle counter, ``agent.event_loop_metrics.cycle_count``.
        reuse_ttl_cycles: Cycles the fed-back note survives. At least ``0``.
    """
    if reuse_ttl_cycles == 0:
        return

    state.reuse[title] = (_REUSE_BONUS, cycle + reuse_ttl_cycles)


def expire_reuse(state: _GraphState, cycle: int, *, reuse_ttl_cycles: int) -> None:
    """Age every fed-back note by the cycle counter: decay what survives, drop what reached its expiry.

    Age is measured against the cycle counter only (Requirement 13.3): no wall clock, no message count, so a slow
    provider call or a burst of messages inside one cycle never ages a note. Decay is applied here at write time, the
    contract ``compute_notes`` reads against, since the first pass adds ``state.reuse`` with no further factor and decay
    never reaches the first pass' similarity (Requirement 7.6). A note reaching its expiry cycle is removed outright
    rather than left at a small bonus (Requirement 13.4), since a value that only decays never leaves the state.

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
        # Elapsed cycles since the grant, so the bonus is whole on the cycle granted and halves once per cycle after.
        # Recomputed from the expiry rather than compounded, so running this twice in one cycle cannot decay twice.
        elapsed = reuse_ttl_cycles - (expiry_cycle - cycle)
        state.reuse[title] = (_REUSE_BONUS * _DECAY**elapsed, expiry_cycle)


def compute_notes(
    state: _GraphState,
    question: str,
    matcher: SimilarityMatcher,
) -> Mapping[str, float]:
    """The Note per Card. This step is the first pass; propagation is added on top of it.

    The caller has already short-circuited the warm-up cases, so reaching here means the graph is worth scoring. Mutates
    neither ``state`` nor the sequence of descriptions handed to the matcher: what crosses the boundary is a fresh
    tuple, so its elements, order and size are ours to guarantee (Requirement 7.12).

    Args:
        state: The graph state. Read only.
        question: The turn's question, embedded under purpose ``"query"`` by the matcher.
        matcher: The similarity matcher. Invoked exactly once.

    Returns:
        One note per Card, keyed by title, never below the similarity that Card was scored with. Empty when the matcher
        failed or answered malformed, which the caller reads as "score nothing, send everything".
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
        # Already decayed at write time, so no further factor here. The expiry cycle is spent where reuse is recorded.
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

    ``base`` is frozen throughout: every read comes out of it and every write goes into ``note``, so no write is read
    within the same pass. The hop is therefore single and the result confluent, so the two link families may be walked
    in either order.

    Args:
        state: The graph state. Read only.
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
    """Card→Card edges (``follows``, ``similar``, ``artifact``) from source to target.

    A link pointing at a title the graph no longer holds is skipped rather than raising: notes are computed per turn and
    links are rebuilt by scan, so a dangling target is a stale edge, not a corrupt state.

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
            # `None` covers the two kinds the note does not inherit along: `tool`, whose target is a tool name and never
            # a note destination, and `similar`, which the selection walks instead. See `_STRUCTURAL_WEIGHTS`.
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

    Two walks instead of one nested walk: sum the frozen base per hub, then hand each Card the hub total minus its own
    contribution, keeping a Card from propagating note to itself through its own tool. The subtrahend is one addend of a
    sum of non-negative terms, so the difference is never negative and propagation only adds.

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

    Three sources, each answering a question the other two cannot. The recency window covers the referent of a question
    with no content words: "And that other one?" resembles nothing, so no score reaches it, but it is almost always
    about the last few turns. The note's pick covers the return to an old subject, which recency cannot. One hop from
    the pick covers the question naming an intermediate rather than the answer: "That error in the report I asked for
    yesterday" resembles the Card about the error, which cites an artifact belonging to a Card about the report that
    resembles the question not at all, and the edge is the only route there.

    Only Card→Card edges are followed. A ``tool`` edge targets a tool name, the axis two Cards reach each other through,
    so the hop it enables is already in the note via :func:`_spread_over_tool_hubs`. This hop is the whole job of the
    ``similar`` edge, which the note does not inherit along (see ``_STRUCTURAL_WEIGHTS``), so it only widens what the
    call reaches and leaves the ranking as the matcher produced it. The hop is taken from the note's pick, not from the
    window, whose neighbours are mostly inside it already since the window is the tail of the conversation.

    Args:
        notes: One note per Card. A missing title reads as ``0.0``.
        state: The graph state. Read only.
        recent_cards: How many of the most recent Cards are always addressed. ``0`` disables the window; a conversation
            with fewer Cards than this has all of them selected either way.
        select_top_k: How many Cards the note adds beyond the window.

    Returns:
        The addressed titles. A Card outside it does not reach the call at all, not even as its Title: the model learns
        it exists from the count the final block states, and reaches it with ``find_context``.
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

    Two axes, decided independently (Requirement 6.1), reading different things:

    - Dialogue, three rungs, decided by the note. The active subject is full content: ``_CONTINUITY_BONUS`` puts its
      note above any admissible threshold and therefore first in the queue, ahead of competition for the budget
      (Requirement 6.6). A note at or above ``expand_threshold`` is full content when it fits the remaining budget,
      description when it does not — one rung down, never title (Requirements 8.3, 8.6). Between the two thresholds it
      is description; below ``collapse_floor`` it is title (Requirements 8.4, 8.5).
    - Evidence, two rungs, decided by message order and never by the note. Every pair consumed means the numbers already
      reached the assistant's own text, leaving only the numeric lines to preserve: description. An unconsumed pair is
      work in progress and travels whole (Requirements 6.3, 6.5).

    An artifact Card never reaches full content here, whatever its note: search alone must never bring 100k tokens back
    (Requirement 11.8). It is short-circuited before the debit, so the budget it would have spent is left for a Card
    that can use it.

    Args:
        notes: One note per Card, as returned by ``compute_notes``. A missing title reads as ``0.0``.
        state: The graph state. Read only.
        expand_threshold: Note at or above which the dialogue is full content, budget permitting.
        collapse_floor: Note below which the dialogue is title only.
        body_budget: Token ceiling across the parts in full content, or ``None`` for no ceiling at all.
        costs: Estimated token cost per ``(title, part)``, where ``part`` is ``"dialogue"`` or ``"evidence"``. When
            omitted, the count of addressed messages stands in for the size.
        selected: Titles the call addresses, as :func:`select` returned them, or ``None`` when selection is off. A Card
            outside the selection is put at title on both axes, its messages leave the call and the compaction emits no
            entry for it, so it costs the call nothing.

    Returns:
        The turn choice, with ``full_pass`` false and ``by_title`` frozen. Its domain is the whole set of Cards: every
        Card is decided, whether or not the call addresses it.
    """
    active_subject = _active_subject(state)
    remaining = body_budget
    decided: dict[str, CardChoice] = {}

    for title in _titles_by_descending_note(state, notes):
        card = state.cards[title]
        value = notes.get(title, 0.0)
        is_artifact = card.kind == "artifact"

        if selected is not None and title not in selected:
            # Decided rather than omitted: the removal reads an absent entry as full content, so leaving it out would
            # keep in the call the very Card the selection excluded.
            decided[title] = CardChoice(dialogue="title", evidence="title")
            continue

        # ---- Dialogue axis: three rungs, decided by the note. ----
        # The active subject enters the full-content path by name and not only by note, so continuity survives a caller
        # that scored the graph elsewhere. It still passes the ceiling: the distribution never overruns the budget.
        dialogue: Resolution
        if title == active_subject or value >= expand_threshold:
            cost = _part_cost(card, "dialogue", costs)
            if is_artifact:
                dialogue = "description"
            elif remaining is None or cost <= remaining:
                dialogue = "full"
                remaining = remaining if remaining is None else remaining - cost
            else:
                # Budget exhausted: one rung down, never to title.
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
                # The floor wins over the arithmetic: an unconsumed pair travels whole regardless, so what would have
                # gone negative is clamped instead of denied.
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

    Malformed answers are raised inside the guarded block: one exit, one log, one traceback, whether the matcher raised
    or answered badly.

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

    Notes must be totally ordered for the distribution to be deterministic, and ``nan`` is the one float that is not.

    Args:
        value: The similarity as answered. A non-numeric value raises, which the caller reads as a matcher failure.

    Returns:
        The similarity, within the closed interval.
    """
    number = float(value)  # type: ignore[arg-type]
    if math.isnan(number):
        return 0.0
    return min(1.0, max(0.0, number))

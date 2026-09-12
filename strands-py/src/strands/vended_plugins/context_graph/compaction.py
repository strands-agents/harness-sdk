"""The final block, derived from the list that actually left, never from the choice.

One public function, whose whole point is a single subtraction::

    a part contributes a fragment <=> ALL of its durable identities left the removal

The choice alone is not enough, because the guards may refuse the removal's request: ``is_pinned`` wins over any
resolution, the first user message never leaves, and a tool pair whose other half is protected travels back in whole. A
Card the choice put in description can therefore still have a message in the retained list, and folding its description
anyway would put the same content in the call twice at two resolutions, paying for both. So a part that survived, whole
or in pieces, is effectively full content and contributes nothing (Requirement 11.7); no other Card is demoted to pay
for it, and the choice frozen at ``BeforeInvocationEvent`` is never rewritten.

``InjectionContext.messages`` is built after the removal replaced ``context.messages``, so this render sees the removed
list by construction. Hence removal and compaction are one handler.

What each axis contributes:

- dialogue at ``"description"``: the Card's description.
- dialogue at ``"title"``: nothing beyond the entry's title line.
- evidence at ``"description"``: tools with call counts, references, and the numeric lines.

Evidence in description is two operations: dropping both messages of the tool pair, and folding the numeric lines at the
end. The first alone loses the numbers; the second alone pays twice for the same content.

A line contributes once per Card. The description already carries the tools, the references and as many numeric lines as
``description_tokens`` allowed, so when both parts left the evidence path adds only what the description left out.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .describe import (  # the same counting and the same budgeting the Description uses
    _CHARS_PER_TOKEN,
    _OMISSION,
    _lines_that_fit,
    _tool_counts,
)
from .state import Card, CardChoice, _GraphState

if TYPE_CHECKING:
    from ...injection.types import InjectionContext

_FULL: CardChoice = CardChoice(dialogue="full", evidence="full")
"""How a Card absent from the choice is read. The choice is frozen at ``BeforeInvocationEvent``, so a Card derived after
that instant has no entry. Absent means keep, and a Card kept whole contributes no fragment."""

_HEADER = "<collapsed_turns>"
"""Opening marker of the block. A marker, not a sentence: the block is appended to the user's own words, so the model
must be able to tell where its message ends and the graph's summary begins."""

_FOOTER = "</collapsed_turns>"
"""Closing marker, so the trailing guidance is unambiguously outside the summarized turns."""

_GUIDANCE = (
    "The turns above left this call in collapsed form; their numeric lines are copied literally. "
    "Call expand_card with a title to get that turn's messages back, expand_artifact with a reference "
    "to read an artifact, or find_context with what you need to search the turns by description."
)
"""What the model can do about a collapsed turn. The three retrieval tools are named because the block is the only place
the model learns the gap is closable: a summary with no way back reads as all there is."""

_SEARCHABLE = (
    "{count} earlier turn(s) of this conversation are not shown above. Search them by description "
    "with find_context, or name a turn with expand_card if you know its title."
)
"""What replaces the Titles of the turns the selection did not address. With the addressing bounded, this line carries
what a per-Card Title line otherwise would (Requirement 4.2): the model learns that more exists and how to reach it. A
gap the model cannot see reads as all there was."""

_ENTRY_PREFIX = "- "
"""Marks the start of a Card's entry: its title line."""

_FRAGMENT_INDENT = "  "
"""Indents a fragment under the title it belongs to."""


def render_final_block(
    injection_context: InjectionContext,
    state: _GraphState,
    requested: frozenset[str],
    *,
    description_tokens: int,
) -> str | None:
    """Assemble the final block from the choice and the already removed list.

    This render runs inside the handler the injection primitive built, after the substitution, so
    ``injection_context.messages`` is the list the removal returned: ``retained`` is read off it and ``dropped =
    requested - retained`` is what actually left (Requirement 9.4). A part contributes a fragment only when all of its
    durable identities are in ``dropped``; a part that survived, whole or in pieces, is full content and contributes
    nothing, which keeps content out of two resolutions in one call when a pin preserves a message of a Card the choice
    put in description (Requirement 11.7).

    Cards come out in ascending turn order, so the block changes only where the resolution changed and a provider's
    cached prefix survives the parts that did not (Requirement 9.5). Every Card that lost a part has its title in the
    return: a Card's Title is in the retained messages when its part is whole, in this block when it is not (Requirement
    4.2). Mutates nothing: neither the list, nor the dicts inside it, nor ``state``.

    Args:
        injection_context: The context the fold handler built, over the already removed list. Read only.
        state: The graph state, holding the Cards and the frozen choice. Read only.
        requested: The set ``removal_ids`` produced for this same call.
        description_tokens: Token ceiling of one Card's entry, the ceiling the Description answers to. Without it the
            block is unbounded; see :func:`_evidence_fragments`.

    Returns:
        The text to fold, or ``None`` when no part contributed, in which case the primitive returns the context
        unchanged without touching ``dynamic_trailing_blocks``.
    """
    retained = {tracking_id for message in injection_context.messages if (tracking_id := message.get("tracking_id"))}
    dropped = requested - retained

    selected = state.choice.selected
    lines: list[str] = []
    for card in sorted(state.cards.values(), key=lambda entry: (entry.turn, entry.title)):
        if selected is not None and card.title not in selected:
            # Unaddressed Card: contributes nothing, not even its Title. The model gets the footer count instead, plus a
            # tool to reach it with.
            continue
        lines.extend(
            _entry(
                card,
                state.choice.by_title.get(card.title, _FULL),
                dropped,
                description_tokens=description_tokens,
            )
        )

    unaddressed = len(state.cards) - len(selected) if selected is not None else 0
    if not lines and not unaddressed:
        return None

    trailer = _GUIDANCE if selected is None else _searchable(unaddressed)
    body = (_HEADER, *lines, _FOOTER) if lines else ()
    return "\n".join((*body, "", trailer)).lstrip("\n")


def _searchable(unaddressed: int) -> str:
    """The trailer for a selected call: the guidance, plus the count of turns left out of it.

    Args:
        unaddressed: How many Cards the selection did not address. ``0`` states no gap.

    Returns:
        The guidance alone when nothing was left out, and the guidance plus the count otherwise.
    """
    if not unaddressed:
        return _GUIDANCE
    return _SEARCHABLE.format(count=unaddressed) + " " + _GUIDANCE


def _entry(
    card: Card,
    choice: CardChoice,
    dropped: frozenset[str] | set[str],
    *,
    description_tokens: int,
) -> list[str]:
    """Render ``card``'s entry: its title line, plus one fragment per part that fully left.

    The title line is emitted for any part that left, including a dialogue at ``"title"`` contributing no fragment of
    its own: there the title line is the whole entry, and omitting it would drop the Card's address from the call.

    Args:
        card: The Card to render. Read only.
        choice: The resolution of both of its parts.
        dropped: The identities that actually left the removal.
        description_tokens: Token ceiling of this entry's fragments.

    Returns:
        The entry's lines, or an empty list when the Card lost nothing.
    """
    dialogue_left = _part_left(card.dialogue_ids, dropped)
    evidence_left = _part_left(card.evidence_ids, dropped)
    if not (dialogue_left or evidence_left):
        return []

    fragments: list[str] = []
    # The title line already carries the title, so the description's own first line is a duplicate.
    seen: set[str] = {card.title}

    if dialogue_left and choice.dialogue == "description":
        fragments.extend(_take(card.description.splitlines(), seen))

    if evidence_left:
        # Budget is what the dialogue axis did not spend, so an entry losing both parts costs the same ceiling as one.
        spent = sum(len(fragment) + 1 for fragment in fragments)
        fragments.extend(_take(_evidence_fragments(card, description_tokens * _CHARS_PER_TOKEN - spent), seen))

    return [_ENTRY_PREFIX + card.title, *(_FRAGMENT_INDENT + fragment for fragment in fragments)]


def _part_left(part_ids: tuple[str, ...], dropped: frozenset[str] | set[str]) -> bool:
    """Whether every durable identity of a part left the removal.

    An empty part never left: non-empty *and* a subset, rather than a bare subset, keeps a Card with no tool call from
    claiming its evidence was collapsed.

    Args:
        part_ids: Durable identities of one part of a Card.
        dropped: The identities that actually left the removal.

    Returns:
        ``True`` when the part is non-empty and wholly absent from the call.
    """
    return bool(part_ids) and all(tracking_id in dropped for tracking_id in part_ids)


def _evidence_fragments(card: Card, budget: int) -> list[str]:
    """The evidence of ``card`` in collapsed form: tools with counts, references, then numeric lines.

    The numeric lines are copied literally, as ``numeric_lines`` selected them: a paraphrased number is wrong in
    silence, and this is the last place the numbers pass before the model reads them.

    The budget is correctness, not optimization. ``Card.numeric_lines`` holds every line of the turn that carried a
    number, hundreds when a tool returned a table. Emitted whole they read as complete while being drawn from the
    offloader's preview, so the largest value among them is the largest of a subset, not of the table. The ceiling plus
    the omission count turns that silent subset into a gap the model can close with ``expand_artifact`` (Req. 4.6).

    Args:
        card: The Card whose evidence left the call. Read only.
        budget: Characters available for the numeric lines. A non-positive budget emits the tools and references lines
            and states every numeric line as omitted: the addresses make the gap closable, so they are never dropped.

    Returns:
        The fragments, in the order the Description lists them. Empty lines are left out rather than rendered blank.
    """
    fragments: list[str] = []

    tools = _tool_counts(card)
    if tools:
        fragments.append("tools: " + ", ".join(f"{name} ({count})" for name, count in tools))

    if card.references:
        fragments.append("references: " + ", ".join(dict.fromkeys(card.references)))

    remaining = budget - sum(len(fragment) + 1 for fragment in fragments)
    # Room for the omission line is reserved before the lines are chosen, so the ceiling holds either way.
    omission = _OMISSION.format(count=len(card.numeric_lines))
    kept = _lines_that_fit(card.numeric_lines, remaining - len(omission) - 1)
    fragments.extend(kept)

    omitted = len(card.numeric_lines) - len(kept)
    if omitted:
        fragments.append(_OMISSION.format(count=omitted))

    return fragments


def _take(candidates: list[str] | tuple[str, ...], seen: set[str]) -> list[str]:
    """Keep the candidates not yet used in this entry, recording them as used.

    A line contributes once per Card: the two axes derive from overlapping fields, the description already carrying the
    tools, the references and the numeric lines that fit its budget.

    Args:
        candidates: Lines offered by one axis, in order. Not mutated.
        seen: Lines already in this entry. Updated in place.

    Returns:
        The candidates kept, in the order offered.
    """
    kept: list[str] = []
    for candidate in candidates:
        if not candidate.strip() or candidate in seen:
            continue
        seen.add(candidate)
        kept.append(candidate)
    return kept

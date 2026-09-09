"""Data model of the context graph: a Card holds an address, never content.

The criterion is ownership of content: an outdated pointer is an outdated decision, while an outdated
copy is outdated content, which is far worse. So the graph stores what it can point at and derive,
and nothing it would have to keep in
sync:

| | Owner | Durable identity | In the Card? |
|---|---|---|---|
| Messages | ``agent.messages`` + session manager | ``tracking_id`` | yes, the address |
| Raw tool return | the offloader's ``Storage`` | ``reference`` | yes, the number |
| Retrieved memory | the store, or the runtime | none — folded per call | no |

Three absences are load-bearing, and each is a requirement satisfied by shape rather than by
discipline:

- **No message-text field.** ``Card.numeric_lines`` and ``Card.description`` are derived text, not
  a copy of a message: they do not replace the message, they narrow it by literal line selection.
  The content stays in ``agent.messages``, which is what makes Requirement 3.4 hold by absence of a
  field instead of by care at every write site.
- **No persisted note.** The note dies at the end of the turn. What survives is the choice, which is
  its result, plus the fed-back note in ``_GraphState.reuse`` — the only value that crosses turns.
- **No message metadata.** The graph never writes to ``metadata.custom`` (Requirement 1.10): the
  decision is per Card, and the Card is derivable.
"""

from __future__ import annotations

import weakref
from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import TYPE_CHECKING, Literal, TypeAlias

if TYPE_CHECKING:
    from ...agent.agent import Agent

Resolution = Literal["full", "description", "title"]
"""The three resolutions, most to least expensive."""

CardKind = Literal["subject", "artifact"]
"""What a Card stands for: a turn's subject, or an offloaded artifact."""

LinkKind = Literal["tool", "artifact", "follows", "similar"]
"""The four edge kinds. Only ``similar`` and ``follows`` carry note."""


@dataclass(frozen=True)
class ToolPair:
    """A tool pair of a Card, and whether it has already been consumed.

    ``consumed`` is derived exclusively from the order of the turn's messages: true when there
    exists, after this pair and within the same turn, an ``assistant`` message carrying a text block.
    Requirement 6.4 — no model and no embedding takes part in the decision.

    Attributes:
        tool_use_id: The ``toolUseId`` shared by both halves of the pair.
        tool_name: Name carried by the ``toolUse`` block.
        tracking_ids: Durable identities of the two halves, in order.
        consumed: Whether an assistant text block already followed the pair in the same turn.
    """

    tool_use_id: str
    tool_name: str
    tracking_ids: tuple[str, ...]
    consumed: bool


@dataclass(frozen=True)
class Card:
    """A graph node. Holds addresses and derived text, never message content.

    ``dialogue_ids`` and ``evidence_ids`` partition the turn's messages: a message joins the evidence
    when it carries a ``toolUse`` or ``toolResult`` block, and the dialogue otherwise. The partition
    is exhaustive and disjoint, which is what lets the two parts hold independent resolutions without
    leaving any message orphaned by both decisions.

    Attributes:
        title: Literal prefix of the turn's user message. Identity of the Card in the graph.
        kind: ``"subject"`` for a turn, ``"artifact"`` for an offloaded artifact.
        turn: Turn ordinal, used for stable ordering and quoted by the description.
        dialogue_ids: Durable identities of the dialogue part.
        evidence_ids: Durable identities of the evidence part.
        pairs: The turn's tool pairs, with their consumption state.
        tool_names: Names of ``toolUse`` blocks mentioned by the Card.
        references: Artifact references cited in a preview.
        numeric_lines: Numeric lines, copied literally, never paraphrased.
        tags: At most ``tags_per_card`` tags, recomputed as rarity shifts.
        description: Derived by rule, within ``description_tokens``.
        reference: Artifact reference. Only on an artifact Card.
        content_type: Artifact content type. Only on an artifact Card.
        size_bytes: Artifact size. Only on an artifact Card.
    """

    title: str
    kind: CardKind
    turn: int
    dialogue_ids: tuple[str, ...]
    evidence_ids: tuple[str, ...]
    pairs: tuple[ToolPair, ...]
    tool_names: frozenset[str]
    references: tuple[str, ...]
    numeric_lines: tuple[str, ...]
    tags: tuple[str, ...]
    description: str
    reference: str | None = None
    content_type: str | None = None
    size_bytes: int | None = None


@dataclass(frozen=True)
class Link:
    """A directed, weighted edge. Four kinds, and only two carry note.

    ``target`` is a Card title for ``follows``, ``similar`` and ``artifact``, and a tool name for
    ``tool``. The tool edge is not a note destination: it is the index that produces the supplemental
    referenced source and the structural tags, and the axis along which two Cards that used the same
    tool reach each other in a single hop.

    Attributes:
        kind: Which of the four kinds this edge is.
        target: A Card title, or a tool name when ``kind`` is ``"tool"``.
        weight: Edge weight. The measured similarity for ``similar``, ``1.0`` otherwise.
    """

    kind: LinkKind
    target: str
    weight: float


@dataclass(frozen=True)
class CardChoice:
    """The resolution of both parts of a Card, decided independently.

    Attributes:
        dialogue: Resolution of the dialogue part. Any of the three rungs.
        evidence: Resolution of the evidence part. Two rungs while the call addresses the Card, and
            never ``"title"`` there: a tool result with no content at all leaves the model without the
            referent of the questions that follow.

            ``"title"`` on this axis means one thing only — the selection did not address this Card,
            so *nothing* of it reaches the call, evidence included. It is not a third rung of the
            ladder; it is the absence of the Card. Requirement 10.8 has a consumer because of it: the
            supplemental referenced source withholds the tool names of a Card the call does not
            address, which is the state the criterion was written for and which nothing could reach
            before selection existed.
    """

    dialogue: Resolution
    evidence: Resolution


@dataclass(frozen=True)
class TurnChoice:
    """The turn choice: immutable, computed once, read by every call of the turn.

    ``full_pass`` is the short circuit: true on the first turn, below ``min_cards``, when
    ``expand_threshold`` is ``0.0``, and whenever any step of the choice failed. In that state the
    handler returns the received context by object identity, which makes the assembled context
    identical field by field to the one produced without the feature.

    Attributes:
        by_title: Title to the resolution of its two parts. A ``MappingProxyType``, never a live
            dict: the choice is frozen for the whole turn, so the context cannot shift mid-reasoning.
        full_pass: Whether every Card keeps full content, which is the regression short circuit.
        selected: Titles the call addresses — the ones whose Title reaches the model. ``None`` means
            every Card is addressed, which is the behavior when selection is off. An empty set is not
            the same thing: it means the selection ran and chose nothing.

            Selection is what gives the links a job. With every Card addressed, propagation only
            breaks ties in a ranking nobody is excluded from, so a link can never be the reason a
            Card is reached. With a bounded selection, one hop from a selected Card is the only route
            to a Card the question does not resemble — which is the case the graph exists for.
    """

    by_title: Mapping[str, CardChoice]
    full_pass: bool
    selected: frozenset[str] | None = None


@dataclass
class _GraphState:
    """Per-agent state. Derived: rebuildable by a scan over ``agent.messages``.

    Losing this state on a restart costs one rebuild scan, which is free in I/O and in model calls,
    and the worst case is today's behavior without the feature (Requirement 14.2, 14.5).

    It never reaches message metadata, and it reaches no store of its own. Under ``persist=True``
    *part* of it reaches ``agent.state``, and with it whatever the session manager writes to:
    ``cards``, ``links``, ``turn`` and ``reuse`` travel; ``choice`` does not (it is per turn, so
    restoring it would apply the previous invocation's decision), ``referenced`` does not (per call),
    and ``vectors`` does not (a cache, and ~369KB of JSON per 18 Cards through a sync that fires on
    every message). See :mod:`.persistence`.

    Attributes:
        cards: Title to Card, in turn order.
        links: Title to its outgoing edges.
        choice: The frozen choice of the current turn. A fresh state is a full pass, which is what
            makes an agent with no messages behave exactly as it does without the feature.
        reuse: Title to ``(bonus, expiry cycle)`` of the fed-back note — the only value that crosses
            turns.
        turn: Turn ordinal. ``0`` on a state with no closed turn boundary (Requirement 14.11).
        vectors: Title to ``(description, vector)``. A per-process cache, so a missing entry costs
            one embedding call and never a lost value.
        retrieval_cycles: Retrieval cycles spent in the current turn (Requirement 17.8).
        referenced: Supplemental referenced source published on this call.
    """

    cards: dict[str, Card] = field(default_factory=dict)
    links: dict[str, list[Link]] = field(default_factory=dict)
    choice: TurnChoice = field(default_factory=lambda: TurnChoice(MappingProxyType({}), True))
    reuse: dict[str, tuple[float, int]] = field(default_factory=dict)
    turn: int = 0
    vectors: dict[str, tuple[str, tuple[float, ...]]] = field(default_factory=dict)
    retrieval_cycles: int = 0
    referenced: frozenset[str] = frozenset()


_GraphStates: TypeAlias = "weakref.WeakKeyDictionary[Agent, _GraphState]"
"""Per-agent state map, keyed weakly: the state is dropped along with the agent it belongs to. Exact
mold of ``_DisclosureStates`` in ``progressive_tool_disclosure/plugin.py`` (Requirement 14.1)."""

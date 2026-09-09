"""Mirror of the graph data model, used until ``context_graph/state.py`` exists.

The strategies in :mod:`strategies` prefer the real dataclasses and fall back to these. Keeping the
fallback in its own module means the alias in ``strategies.py`` is a single line, and no name is ever
defined twice.

The mirrors are field-for-field copies of the model in the design document. They are duck-type
compatible with the real ones: every consumer reads attributes, so a generated mirror drives the
implementation exactly as a real Card would.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Literal

Resolution = Literal["full", "description", "title"]
CardKind = Literal["subject", "artifact"]
LinkKind = Literal["tool", "artifact", "follows", "similar"]


@dataclass(frozen=True)
class ToolPair:
    """A tool pair of a Card, and whether it has been consumed."""

    tool_use_id: str
    tool_name: str
    tracking_ids: tuple[str, ...]
    consumed: bool


@dataclass(frozen=True)
class Card:
    """A graph node. Holds addresses and derived text, never message content."""

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
    """A directed, weighted edge. Four kinds, and only two carry note."""

    kind: LinkKind
    target: str
    weight: float


@dataclass(frozen=True)
class CardChoice:
    """The resolution of both parts of a Card, decided independently."""

    dialogue: Resolution
    evidence: Resolution


@dataclass(frozen=True)
class TurnChoice:
    """The turn choice: immutable, computed once, read by every call of the turn."""

    by_title: Mapping[str, CardChoice]
    full_pass: bool


@dataclass
class _GraphState:
    """Per-agent state. Ephemeral: never reaches agent.state, metadata or disk."""

    cards: dict[str, Card] = field(default_factory=dict)
    links: dict[str, list[Link]] = field(default_factory=dict)
    choice: TurnChoice = field(default_factory=lambda: TurnChoice(MappingProxyType({}), True))
    reuse: dict[str, tuple[float, int]] = field(default_factory=dict)
    turn: int = 0
    vectors: dict[str, tuple[str, tuple[float, ...]]] = field(default_factory=dict)
    retrieval_cycles: int = 0
    referenced: frozenset[str] = frozenset()

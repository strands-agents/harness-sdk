"""Shared Hypothesis strategies for the context graph test suite.

The conversation strategies build the synthetic histories a live agent produces: valid role
alternation starting with ``user``, turn boundaries, matched ``toolUse``/``toolResult`` pairs, pins in
arbitrary positions, and durable identities that may be missing. Nothing here imports the graph
implementation except the data model, and the model is imported through a fallback mirror
(:mod:`_models`) so the suite is importable before ``state.py`` lands.

Two conventions are load-bearing:

- **Turn boundary is written literally.** A turn opens on a ``user`` message that carries no
  ``toolResult`` block. The generators encode that rule by construction rather than by calling the
  implementation, so a bug in ``cards.py`` cannot make the generators agree with it.
- **Evidence and dialogue partition the turn.** A message carrying ``toolUse`` or ``toolResult`` is
  evidence; anything else is dialogue. The Card strategies keep the two id tuples disjoint.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from types import MappingProxyType
from typing import Any

from hypothesis import HealthCheck, settings
from hypothesis import strategies as st

from strands.agent.conversation_manager.compression.pin_message import pin_message
from strands.types.content import Message, Messages

try:  # The real model once it exists, the mirror until then. Duck-typed either way.
    from strands.vended_plugins.context_graph import state as _state
except ImportError:  # pragma: no cover - taken only until context_graph/state.py lands
    from . import _models as _state

Card = _state.Card
CardChoice = _state.CardChoice
Link = _state.Link
ToolPair = _state.ToolPair
TurnChoice = _state.TurnChoice
GraphState = _state._GraphState

MIN_EXAMPLES = 100
"""Minimum iterations per property, per the design's testing configuration."""

property_settings = settings(
    max_examples=MIN_EXAMPLES,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)
"""Settings every property test in this package applies.

``deadline=None`` because conversation generation is not the thing under measurement — latency has its
own integration test, and a per-example deadline here only produces flakes.
"""

TOOL_NAMES = ("fetch_positions", "run_query", "read_file", "list_connectors")
"""A small closed set of tool names, so tool links and tool hubs are reachable by generated data."""

RESOLUTIONS = ("full", "description", "title")
"""The three resolutions, most to least expensive."""

EVIDENCE_RESOLUTIONS = ("full", "description")
"""Evidence has two rungs, never three: it is never ``"title"``."""

LINK_KINDS = ("tool", "artifact", "follows", "similar")
"""The four link kinds."""

ENGAGEMENT_POINTS = (
    "MessageAddedEvent",
    "AfterToolCallEvent",
    "BeforeInvocationEvent",
    "InvokeModelStage.Input",
    "render_content",
)
"""The four engagement points, plus the ``render_content`` of the final block."""

NUMERIC_LINES = (
    "R$ 1.200,00",
    "1.200,00",
    "1200",
    "total: 3.451,90 BRL",
    "| ativo | 12,50 | 3.400 |",
    "saldo\u00a0em\u00a02024: 98,7%",
    "-0.5e3",
)
"""Literal numeric, monetary and tabular lines, including a unicode separator."""

TAG_CANDIDATES = ("connector", "billing", "1200", "positions", "refactor", "release", "latency")
"""Textual tag candidates, drawn from a closed set so rarity distributions are reachable."""


def tracking_ids() -> st.SearchStrategy[str]:
    """Durable identities, shaped like the UUID v4 the agent assigns."""
    return st.uuids(version=4).map(str)


def references() -> st.SearchStrategy[str]:
    """Artifact references, shaped like the offloader's placeholder reference."""
    return st.integers(min_value=1, max_value=999).map(lambda number: f"ref-{number}")


def _text_blocks() -> st.SearchStrategy[dict[str, Any]]:
    return st.builds(lambda text: {"text": text}, st.text(min_size=1, max_size=24))


def _tool_use_block(tool_use_id: str, tool_name: str) -> dict[str, Any]:
    return {"toolUse": {"toolUseId": tool_use_id, "name": tool_name, "input": {}}}


def _tool_result_block(tool_use_id: str, text: str = "ok") -> dict[str, Any]:
    return {"toolResult": {"toolUseId": tool_use_id, "status": "success", "content": [{"text": text}]}}


@st.composite
def messages(  # noqa: D417 - drawing callable is supplied by @composite
    draw: st.DrawFn,
    role: str | None = None,
    tracking_id: str | None = None,
) -> Message:
    """Draw one valid message, with or without a durable identity and with or without metadata.

    Args:
        role: Force the role. Drawn from ``user``/``assistant`` when omitted.
        tracking_id: Force the durable identity. Drawn — and sometimes omitted — when not given.
    """
    message: Message = {
        "role": role or draw(st.sampled_from(["user", "assistant"])),
        "content": draw(st.lists(_text_blocks(), min_size=1, max_size=2)),
    }

    identity = tracking_id if tracking_id is not None else draw(st.one_of(st.none(), tracking_ids()))
    if identity is not None:
        message["tracking_id"] = identity

    shape = draw(st.sampled_from(["absent", "empty", "other-key"]))
    if shape == "empty":
        message["metadata"] = {}
    elif shape == "other-key":
        message["metadata"] = {"custom": {"provenance": "generated"}}
    return message


@st.composite
def conversations(  # noqa: D417 - drawing callable is supplied by @composite
    draw: st.DrawFn,
    min_turns: int = 1,
    max_turns: int = 5,
) -> Messages:
    """Draw a conversation with valid role alternation, starting with ``user``.

    Every turn opens on a ``user`` message carrying no ``toolResult``, which is the boundary rule
    written literally. Most messages carry a unique durable identity; some carry none, which is the
    case a Card must treat as a message without an address.

    Args:
        min_turns: Fewest turns to draw.
        max_turns: Most turns to draw.
    """
    turns = draw(st.integers(min_value=min_turns, max_value=max_turns))
    conversation: Messages = []
    for _ in range(turns):
        conversation.append(draw(messages(role="user", tracking_id=draw(tracking_ids()))))
        for _ in range(draw(st.integers(min_value=1, max_value=2))):
            has_identity = draw(st.sampled_from([True, True, True, False]))
            conversation.append(
                draw(messages(role="assistant", tracking_id=draw(tracking_ids()) if has_identity else None))
            )
    return conversation


@st.composite
def conversations_with_tool_pairs(  # noqa: D417 - drawing callable is supplied by @composite
    draw: st.DrawFn,
    min_pairs: int = 1,
    max_pairs: int = 3,
) -> Messages:
    """Draw a conversation containing matched ``toolUse``/``toolResult`` pairs.

    Each pair is an assistant message carrying the ``toolUse`` block followed by a user message
    carrying the ``toolResult`` with the same ``toolUseId``. One assistant message sometimes carries
    two ``toolUse`` blocks, so a message belonging to two pairs is covered. A trailing assistant text
    message is drawn or not, which is what makes a pair consumed or not.

    Args:
        min_pairs: Fewest pairs to draw.
        max_pairs: Most pairs to draw.
    """
    pair_count = draw(st.integers(min_value=min_pairs, max_value=max_pairs))
    tool_use_ids = draw(st.lists(tracking_ids(), min_size=pair_count, max_size=pair_count, unique=True))

    conversation: Messages = [draw(messages(role="user", tracking_id=draw(tracking_ids())))]
    index = 0
    while index < pair_count:
        # Two blocks in one message when there is another pair left to fold in.
        together = index + 1 < pair_count and draw(st.booleans())
        batch = tool_use_ids[index : index + 2] if together else tool_use_ids[index : index + 1]
        conversation.append(
            {
                "role": "assistant",
                "content": [_tool_use_block(tool_use_id, draw(st.sampled_from(TOOL_NAMES))) for tool_use_id in batch],
                "tracking_id": draw(tracking_ids()),
            }
        )
        conversation.append(
            {
                "role": "user",
                "content": [_tool_result_block(tool_use_id) for tool_use_id in batch],
                "tracking_id": draw(tracking_ids()),
            }
        )
        if draw(st.booleans()):
            conversation.append(draw(messages(role="assistant", tracking_id=draw(tracking_ids()))))
        index += len(batch)
    return conversation


@st.composite
def conversations_with_open_turn(  # noqa: D417 - drawing callable is supplied by @composite
    draw: st.DrawFn,
) -> Messages:
    """Draw a conversation that ends in the middle of a turn — the turn in progress.

    Three shapes, all of them real: a ``user`` message with no answer yet, an unmatched ``toolUse``
    still waiting for its result, and a matched pair with no assistant text after it.
    """
    conversation = draw(conversations(min_turns=1, max_turns=3))
    conversation.append(draw(messages(role="user", tracking_id=draw(tracking_ids()))))

    shape = draw(st.sampled_from(["user-only", "unmatched-use", "unconsumed-pair"]))
    if shape == "user-only":
        return conversation

    tool_use_id = draw(tracking_ids())
    conversation.append(
        {
            "role": "assistant",
            "content": [_tool_use_block(tool_use_id, draw(st.sampled_from(TOOL_NAMES)))],
            "tracking_id": draw(tracking_ids()),
        }
    )
    if shape == "unconsumed-pair":
        conversation.append(
            {
                "role": "user",
                "content": [_tool_result_block(tool_use_id)],
                "tracking_id": draw(tracking_ids()),
            }
        )
    return conversation


@st.composite
def conversations_with_pins(  # noqa: D417 - drawing callable is supplied by @composite
    draw: st.DrawFn,
) -> Messages:
    """Draw a conversation with ``pin_message`` applied in arbitrary positions.

    Pins go on top of a conversation that may already hold tool pairs, so the interaction between the
    pin guard and the tool-pair guard is covered: pinning one half of a pair protects both.
    """
    conversation = draw(st.one_of(conversations(), conversations_with_tool_pairs()))
    for index in range(len(conversation)):
        if draw(st.sampled_from([True, False, False])):
            pin_message(conversation, index)
    return conversation


def _numeric_line_lists() -> st.SearchStrategy[list[str]]:
    return st.lists(st.sampled_from(NUMERIC_LINES), max_size=4, unique=True)


@st.composite
def cards(  # noqa: D417 - drawing callable is supplied by @composite
    draw: st.DrawFn,
    title: str | None = None,
    turn: int | None = None,
    kind: str | None = None,
) -> Any:
    """Draw one Card — subject or artifact — with numeric lines, tags and references.

    ``dialogue_ids`` and ``evidence_ids`` are drawn disjoint, and ``tool_names`` agrees with the tool
    names of the drawn pairs, so a generated Card is internally consistent the way a derived one is.

    Args:
        title: Force the title. Drawn when omitted.
        turn: Force the turn ordinal. Drawn when omitted.
        kind: Force ``"subject"`` or ``"artifact"``. Drawn when omitted.
    """
    resolved_kind = kind or draw(st.sampled_from(["subject", "subject", "artifact"]))
    resolved_turn = turn if turn is not None else draw(st.integers(min_value=0, max_value=20))
    resolved_title = title or draw(st.text(min_size=1, max_size=20).map(lambda text: f"t{resolved_turn}:{text}"))

    identities = draw(st.lists(tracking_ids(), min_size=1, max_size=6, unique=True))
    split = draw(st.integers(min_value=0, max_value=len(identities)))
    dialogue_ids = tuple(identities[:split])
    evidence_ids = tuple(identities[split:])

    pairs = tuple(draw(st.lists(_tool_pairs(evidence_ids), max_size=3, unique_by=lambda pair: pair.tool_use_id)))
    tool_names = frozenset(pair.tool_name for pair in pairs)
    numeric_lines = tuple(draw(_numeric_line_lists()))
    tags = tuple(draw(st.lists(st.sampled_from(TAG_CANDIDATES), max_size=5, unique=True)))
    description = draw(st.text(min_size=0, max_size=120))

    if resolved_kind == "artifact":
        reference = draw(references())
        return Card(
            title=resolved_title,
            kind="artifact",
            turn=resolved_turn,
            dialogue_ids=dialogue_ids,
            evidence_ids=evidence_ids,
            pairs=pairs,
            tool_names=tool_names,
            references=(reference,),
            numeric_lines=numeric_lines,
            tags=tags,
            description=description,
            reference=reference,
            content_type=draw(st.sampled_from(["text/plain", "application/json", "application/pdf"])),
            size_bytes=draw(st.integers(min_value=1, max_value=10_000_000)),
        )

    return Card(
        title=resolved_title,
        kind="subject",
        turn=resolved_turn,
        dialogue_ids=dialogue_ids,
        evidence_ids=evidence_ids,
        pairs=pairs,
        tool_names=tool_names,
        references=tuple(draw(st.lists(references(), max_size=2, unique=True))),
        numeric_lines=numeric_lines,
        tags=tags,
        description=description,
    )


@st.composite
def _tool_pairs(  # noqa: D417 - drawing callable is supplied by @composite
    draw: st.DrawFn,
    evidence_ids: Sequence[str] = (),
) -> Any:
    """Draw one tool pair, addressing evidence identities when there are any."""
    pool = list(evidence_ids) or [draw(tracking_ids()), draw(tracking_ids())]
    return ToolPair(
        tool_use_id=draw(tracking_ids()),
        tool_name=draw(st.sampled_from(TOOL_NAMES)),
        tracking_ids=tuple(pool[:2]),
        consumed=draw(st.booleans()),
    )


@st.composite
def cards_with_pairs(  # noqa: D417 - drawing callable is supplied by @composite
    draw: st.DrawFn,
    min_pairs: int = 1,
    max_pairs: int = 4,
) -> Any:
    """Draw a Card whose pairs mix consumed and unconsumed in arbitrary proportion.

    The proportion is what the evidence axis reads: every consumed pair drops to description, and any
    unconsumed pair stays full.

    Args:
        min_pairs: Fewest pairs to draw.
        max_pairs: Most pairs to draw.
    """
    card = draw(cards(kind="subject"))
    count = draw(st.integers(min_value=min_pairs, max_value=max_pairs))
    identities = draw(st.lists(tracking_ids(), min_size=count * 2, max_size=count * 2, unique=True))
    consumed_flags = draw(st.lists(st.booleans(), min_size=count, max_size=count))

    pairs = tuple(
        ToolPair(
            tool_use_id=identities[index * 2],
            tool_name=draw(st.sampled_from(TOOL_NAMES)),
            tracking_ids=(identities[index * 2], identities[index * 2 + 1]),
            consumed=consumed_flags[index],
        )
        for index in range(count)
    )
    evidence_ids = tuple(identity for pair in pairs for identity in pair.tracking_ids)
    return replace(
        card,
        pairs=pairs,
        evidence_ids=evidence_ids,
        tool_names=frozenset(pair.tool_name for pair in pairs),
    )


@st.composite
def graph_states(  # noqa: D417 - drawing callable is supplied by @composite
    draw: st.DrawFn,
    min_cards: int = 1,
    max_cards: int = 6,
) -> Any:
    """Draw a consistent graph state carrying all four link kinds.

    Titles are unique, turns are the insertion order, ``follows`` points at the previous Card,
    ``similar`` edges are bidirectional with the measured similarity as weight, ``tool`` edges target a
    tool name and ``artifact`` edges target an artifact Card.

    Args:
        min_cards: Fewest Cards to draw.
        max_cards: Most Cards to draw.
    """
    count = draw(st.integers(min_value=min_cards, max_value=max_cards))
    drawn = [draw(cards(title=f"card-{index}", turn=index)) for index in range(count)]

    state = GraphState()
    for card in drawn:
        state.cards[card.title] = card
    state.turn = count

    titles = [card.title for card in drawn]
    for index, card in enumerate(drawn):
        edges: list[Any] = []
        for tool_name in sorted(card.tool_names):
            edges.append(Link(kind="tool", target=tool_name, weight=1.0))
        if index > 0 and draw(st.booleans()):
            edges.append(Link(kind="follows", target=titles[index - 1], weight=1.0))
        for reference_target in drawn:
            if reference_target.kind == "artifact" and reference_target.title != card.title and draw(st.booleans()):
                edges.append(Link(kind="artifact", target=reference_target.title, weight=1.0))
        state.links[card.title] = edges

    # Similar edges last, and bidirectional by construction.
    for left in range(count):
        for right in range(left + 1, count):
            if not draw(st.booleans()):
                continue
            weight = draw(st.floats(min_value=0.0, max_value=1.0, allow_nan=False, allow_infinity=False))
            state.links[titles[left]].append(Link(kind="similar", target=titles[right], weight=weight))
            state.links[titles[right]].append(Link(kind="similar", target=titles[left], weight=weight))

    return state


@st.composite
def graph_states_with_costs(  # noqa: D417 - drawing callable is supplied by @composite
    draw: st.DrawFn,
    min_cards: int = 1,
    max_cards: int = 6,
) -> tuple[Any, dict[tuple[str, str], int]]:
    """Draw a graph state plus an estimated cost per part, to exercise the body budget.

    Returns:
        The state, and a mapping from ``(title, part)`` to the estimated token cost of that part in
        full content, where ``part`` is ``"dialogue"`` or ``"evidence"``.

    Args:
        min_cards: Fewest Cards to draw.
        max_cards: Most Cards to draw.
    """
    state = draw(graph_states(min_cards=min_cards, max_cards=max_cards))
    costs: dict[tuple[str, str], int] = {}
    for title in state.cards:
        for part in ("dialogue", "evidence"):
            costs[(title, part)] = draw(st.integers(min_value=0, max_value=5_000))
    return state, costs


@st.composite
def turn_choices(  # noqa: D417 - drawing callable is supplied by @composite
    draw: st.DrawFn,
    state: Any,
) -> Any:
    """Draw an arbitrary turn choice over ``state``, including ``full_pass``.

    The domain is exactly the set of Cards in the state — no Card is ever dropped from the choice —
    and evidence never draws ``"title"``.

    Args:
        state: The graph state whose Cards the choice covers.
    """
    by_title = {
        title: CardChoice(
            dialogue=draw(st.sampled_from(RESOLUTIONS)),
            evidence=draw(st.sampled_from(EVIDENCE_RESOLUTIONS)),
        )
        for title in state.cards
    }
    return TurnChoice(by_title=MappingProxyType(by_title), full_pass=draw(st.booleans()))


@st.composite
def similarity_vectors(  # noqa: D417 - drawing callable is supplied by @composite
    draw: st.DrawFn,
    state: Any,
) -> dict[str, float]:
    """Draw one similarity in ``[0, 1]`` per Card of ``state``, extremes included.

    Args:
        state: The graph state whose Cards get a score.
    """
    scores = st.one_of(
        st.just(0.0),
        st.just(1.0),
        st.floats(min_value=0.0, max_value=1.0, allow_nan=False, allow_infinity=False),
    )
    return {title: draw(scores) for title in state.cards}


def id_subsets(conversation: Messages) -> st.SearchStrategy[frozenset[str]]:
    """Draw an arbitrary subset of the durable identities present in ``conversation``."""
    identities = sorted({message["tracking_id"] for message in conversation if message.get("tracking_id")})
    if not identities:
        return st.just(frozenset())
    return st.lists(st.sampled_from(identities), unique=True).map(frozenset)


@st.composite
def tag_universes(  # noqa: D417 - drawing callable is supplied by @composite
    draw: st.DrawFn,
    min_cards: int = 2,
    max_cards: int = 6,
) -> list[tuple[str, ...]]:
    """Draw a candidate distribution across Cards, which is what rarity is counted over.

    Returns one tuple of candidates per Card. A candidate present in every tuple distinguishes
    nothing; one present in a single tuple is maximally rare. Skewed distributions are drawn
    deliberately, because a uniform one cannot tell the rarity term from the repetition term.

    Args:
        min_cards: Fewest Cards in the universe.
        max_cards: Most Cards in the universe.
    """
    count = draw(st.integers(min_value=min_cards, max_value=max_cards))
    everywhere = draw(st.lists(st.sampled_from(TAG_CANDIDATES), max_size=2, unique=True))
    universe: list[tuple[str, ...]] = []
    for _ in range(count):
        drawn = draw(st.lists(st.sampled_from(TAG_CANDIDATES), max_size=4, unique=True))
        universe.append(tuple(dict.fromkeys([*everywhere, *drawn])))
    return universe


@dataclass(frozen=True)
class FailureMode:
    """One way a collaborator can fail to answer usefully.

    ``kind`` is the label a test reports; :meth:`respond` produces the failure itself, so a test does
    not branch on the label. The five kinds are the five the design enumerates: an exception, a
    timeout, an empty sequence, a length that does not match, and something not iterable at all.
    """

    kind: str

    def respond(self, expected: int) -> Any:
        """Fail the way this mode describes, or return the malformed answer it describes.

        Args:
            expected: How many scores a well-behaved collaborator would have returned.

        Returns:
            The malformed answer, for the kinds that answer instead of raising.

        Raises:
            RuntimeError: For ``"exception"``.
            TimeoutError: For ``"timeout"``.
        """
        if self.kind == "exception":
            raise RuntimeError("collaborator unavailable")
        if self.kind == "timeout":
            raise TimeoutError("collaborator timed out")
        if self.kind == "empty":
            return []
        if self.kind == "wrong_length":
            return [0.5] * (expected + 1)
        return object()  # not_iterable

    def raises(self) -> bool:
        """Whether this mode raises rather than answering."""
        return self.kind in ("exception", "timeout")


FAILURE_MODES = ("exception", "timeout", "empty", "wrong_length", "not_iterable")
"""The five failure modes every engagement point must survive."""


def failure_modes() -> st.SearchStrategy[FailureMode]:
    """Draw one failure mode: exception, timeout, empty sequence, wrong length, not iterable."""
    return st.sampled_from(FAILURE_MODES).map(FailureMode)


def engagement_points() -> st.SearchStrategy[str]:
    """Draw one of the four engagement points, or the ``render_content`` of the final block."""
    return st.sampled_from(ENGAGEMENT_POINTS)


@dataclass(frozen=True)
class InstrumentationPoint:
    """One observability emission: a log record, a counter increment or a span."""

    kind: str
    name: str


INSTRUMENTATION_POINTS = (
    InstrumentationPoint("log", "choice_computed"),
    InstrumentationPoint("log", "card_derivation_failed"),
    InstrumentationPoint("log", "matcher_unavailable"),
    InstrumentationPoint("log", "destructive_manager_detected"),
    InstrumentationPoint("counter", "cards_total"),
    InstrumentationPoint("counter", "messages_removed"),
    InstrumentationPoint("counter", "retrieval_cycles"),
    InstrumentationPoint("span", "turn_choice"),
    InstrumentationPoint("span", "removal"),
    InstrumentationPoint("span", "compaction"),
)
"""Every emission the graph makes. Making any one of them raise must not change the result."""


def instrumentation_points() -> st.SearchStrategy[InstrumentationPoint]:
    """Draw one instrumentation point: a log emission, a counter or a span."""
    return st.sampled_from(INSTRUMENTATION_POINTS)


def out_of_domain_values() -> st.SearchStrategy[Any]:
    """Draw a value that must be rejected by parameter validation.

    Booleans first, because ``isinstance(True, int)`` is the trap every numeric check falls into;
    then ``nan`` and the infinities, which pass a type check and fail a range one; then strings,
    floats where an integer is required, and values outside ``[0.0, 1.0]``.
    """
    return st.one_of(
        st.booleans(),
        st.sampled_from([float("nan"), float("inf"), float("-inf")]),
        st.text(max_size=8),
        st.sampled_from([0.5, 1.5, 2.7]),
        st.floats(min_value=1.0001, max_value=1e6, allow_nan=False, allow_infinity=False),
        st.floats(min_value=-1e6, max_value=-0.0001, allow_nan=False, allow_infinity=False),
        st.integers(min_value=-1000, max_value=-1),
        st.just(object()),
    )


def durable_ids(conversation: Messages) -> list[str]:
    """Every durable identity in ``conversation``, in order, skipping messages without one."""
    return [message["tracking_id"] for message in conversation if message.get("tracking_id")]


def is_turn_start(conversation: Messages, index: int) -> bool:
    """Whether the message at ``index`` opens a turn: role ``user`` with no ``toolResult`` block.

    The rule is written literally here so a bug in the implementation cannot make the generators
    agree with it.
    """
    message = conversation[index]
    if message.get("role") != "user":
        return False
    return not any(isinstance(block, dict) and "toolResult" in block for block in message.get("content", []))


def is_evidence(message: Message) -> bool:
    """Whether a message belongs to the evidence part: it carries ``toolUse`` or ``toolResult``."""
    return any(
        isinstance(block, dict) and ("toolUse" in block or "toolResult" in block)
        for block in message.get("content", [])
    )


def tool_use_ids(conversation: Messages) -> set[str]:
    """Collect every ``toolUseId`` carried by a ``toolUse`` block."""
    return _collect_tool_ids(conversation, "toolUse")


def tool_result_ids(conversation: Messages) -> set[str]:
    """Collect every ``toolUseId`` carried by a ``toolResult`` block."""
    return _collect_tool_ids(conversation, "toolResult")


def _collect_tool_ids(conversation: Messages, block: str) -> set[str]:
    found: set[str] = set()
    for message in conversation:
        for content in message.get("content", []):
            if isinstance(content, dict) and block in content:
                tool_use_id = content[block].get("toolUseId")
                if tool_use_id:
                    found.add(tool_use_id)
    return found


def frozen_choice(by_title: Mapping[str, Any], *, full_pass: bool = False) -> Any:
    """Build a ``TurnChoice`` with a frozen mapping, the way the implementation must."""
    return TurnChoice(by_title=MappingProxyType(dict(by_title)), full_pass=full_pass)

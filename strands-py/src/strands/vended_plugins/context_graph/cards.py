"""The turn boundary, the Dialogue/Evidence partition, and the tool pairs of a turn.

Everything here is a scan over messages: no model call, no embedding, no I/O.

``is_turn_boundary`` delegates to ``_is_user_turn`` from ``injection/_message_injection.py``, the ``"userTurn"`` policy
of Requirement 3.1: a ``user`` message carrying no ``toolResult`` block.

The partition is by content block, exhaustive and disjoint: a message carrying a ``toolUse`` or ``toolResult`` block
joins the evidence, the dialogue otherwise, so the two parts hold independent resolutions with no message orphaned by
both. Only messages carrying a ``tracking_id`` are addressed; one without is a message without a Card and projects whole
(Requirement 3.5).

``ToolPair.consumed`` comes from order alone: an ``assistant`` message carrying a text block appears after the pair,
within the same turn (Requirements 6.4, 6.5). A turn ending in a ``toolResult``, or a pair missing a half, stays
unconsumed and keeps its evidence whole.

Requirement 3.2 keeps the ``MessageAddedEvent`` hook free of model call, disk and network, so the similarity link reads
vectors the reading half already paid for: an uncached pair gets no edge this turn, and one on the next turn the choice
runs.

An artifact Card holds the address, never the content: the reference plus the two facts the placeholder states about it,
read off the preview text, while the raw return stays in the offloader's ``Storage``. Hook order against the offloader
is therefore irrelevant. With no offloader registered nothing is replaced, the scan finds no reference, and there is no
artifact Card.

``rebuild`` composes the same helpers over a whole conversation, so a lost graph costs a scan and never a value. It runs
on the writing half only.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable, Collection, Iterator, Mapping, Sequence
from dataclasses import replace
from typing import Any

from ...injection._message_injection import _is_user_turn
from ...types.content import Message, Messages
from ...types.tools import ToolResult
from .._embedding import cosine_similarity
from .describe import _is_textual, compose_description, numeric_lines, select_tags, tag_candidates, title_for
from .state import Card, Link, ToolPair, _GraphState

logger = logging.getLogger(__name__)

_STRUCTURAL_WEIGHT = 1.0
"""``Link.weight`` of the three structural kinds: tool, artifact and follows. One, because a *kind*'s weight lives in
``scoring._STRUCTURAL_WEIGHTS`` and is applied where the note inherits, so carrying it here too would multiply it in
twice. ``Link.weight`` carries a measurement or nothing, and similarity is the only kind with one to carry."""

_STORED_REFERENCES = "[Stored references:]"
"""Header the offloader writes above its reference listing. Matched as a substring, not a whole line: a listing that
gained a prefix is still a listing."""

_INLINE_REFERENCE = re.compile(r"\bref(?:erence)?s?:[ \t]*([^\s,|\]]+(?:[ \t]*,[ \t]*[^\s,|\]]+)*)")
"""A reference named inline, in either shape the two hosts write.

The offloader's non-text placeholders name one: ``| ref: mem_1_tu-3_0``. The ContextManager's stash names one the same
way and several as ``[refs: tu-3_0, tu-3_1]``, so a comma-separated run is accepted and the capture is split on commas.
Each reference still stops at whitespace, ``|`` and ``]`` — the characters that close the field and that a reference
never contains — so a sentence that merely mentions a reference does not absorb the words after it."""


def _inline_references(text: str) -> tuple[str, ...]:
    """Every reference named inline in ``text``, in order of appearance.

    Args:
        text: A line or field that may carry one or more ``ref:``/``refs:`` fields.

    Returns:
        The references, each stripped of surrounding whitespace, empties dropped.
    """
    found: list[str] = []
    for match in _INLINE_REFERENCE.finditer(text):
        found.extend(part.strip() for part in match.group(1).split(",") if part.strip())
    return tuple(found)


_LISTED_REFERENCE = re.compile(r"^[ \t]+(\S+)[ \t]*\(")
"""A reference on its own line under the listing header: two spaces, the reference, its description. Anchored on the
leading indentation, which tells a listed reference from a line of preview text carrying a parenthesis."""

_LISTED_ENTRY = re.compile(r"^[ \t]+(\S+)[ \t]*\((.*)\)[ \t]*$")
"""The same listing line as ``_LISTED_REFERENCE``, with its parenthesized descriptor captured too.

Stricter: the closing parenthesis is required, since a ``content_type`` is read from this match and a half-line
descriptor would produce a media type that was never written. The reference it yields is trusted only when the reference
scan already found it, so the two patterns cannot disagree.
"""

_PLACEHOLDER = re.compile(r"\[(image|document):([^\]]*)\]")
"""A non-text block's placeholder, whole: ``[image: png, 900 bytes | ref: mem_1_tu-3_0]``. Fields are parsed out of the
captured tail rather than one regex per shape: ``image`` carries two fields before the reference, ``document`` three."""

_SIZE_IN_BYTES = re.compile(r"(\d[\d,._]*)[ \t]*bytes")
"""A size stated in bytes, thousands separators included. ``chars`` is not matched: the offloader states a text block's
length in characters, which are not bytes in any encoding it stores. A size that would have to be guessed is left
absent."""

_PLACEHOLDER_TYPES = {"image": "image", "document": "application"}
"""Media type top level of each placeholder kind, so ``document: pdf`` becomes ``application/pdf``."""

_DESCRIPTOR_TYPES = {"text": "text/plain", "json": "application/json"}
"""Media type of the two descriptors the listing writes as a bare word rather than as a media type."""


def is_turn_boundary(message: Message) -> bool:
    """Report whether ``message`` opens a turn.

    The rule is ``_is_user_turn``'s, reused rather than reimplemented: role ``user``, no ``toolResult`` block. A
    one-message list is the question that function answers, since it reads the latest message.

    Args:
        message: The message to classify. Read only.

    Returns:
        ``True`` when the message is a fresh user ask, which is where a turn starts.
    """
    return _is_user_turn([message])


def turn_ranges(messages: Messages) -> tuple[tuple[int, int], ...]:
    """Split ``messages`` into ``(start, stop)`` index ranges, one per turn, in order.

    A turn spans its boundary up to, and excluding, the next boundary. Messages before the first boundary belong to no
    turn and appear in no range, so a conversation opening with an assistant message has no Card over that opening and
    those messages project whole. The last range is the turn in progress; whether a turn is closed by what comes after
    it is ``closed_turn_ranges``' question, not this one's.

    Args:
        messages: The conversation, as data. Read only.

    Returns:
        The ranges, in message order. Empty when no message opens a turn.
    """
    starts = [index for index, message in enumerate(messages) if is_turn_boundary(message)]
    return tuple(
        (start, starts[position + 1] if position + 1 < len(starts) else len(messages))
        for position, start in enumerate(starts)
    )


def closed_turn_ranges(messages: Messages) -> tuple[tuple[int, int], ...]:
    """Ranges of the turns of ``messages`` that are closed — every turn but the last.

    A turn is closed when a later boundary exists, so the trailing range is the turn in progress and is always excluded.
    That slice keeps the turn in progress out of every derivation: no Card covers it, so no resolution can drop it below
    full content (Requirements 3.6, 6.2).

    Args:
        messages: The conversation, as data. Read only.

    Returns:
        The closed ranges, in message order. Empty when the conversation holds at most one turn.
    """
    return turn_ranges(messages)[:-1]


def is_evidence(message: Message) -> bool:
    """Report whether ``message`` belongs to the evidence part of its turn.

    Args:
        message: The message to classify. Read only.

    Returns:
        ``True`` when the message carries a ``toolUse`` or a ``toolResult`` block.
    """
    return any("toolUse" in block or "toolResult" in block for block in _blocks(message))


def partition_turn(turn_messages: Sequence[Message]) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Split the durable identities of ``turn_messages`` into the dialogue part and the evidence part.

    Exhaustive and disjoint over the addressed messages: every message with a ``tracking_id`` lands in one of the two
    tuples, decided by ``is_evidence`` alone. A message without one is a message without a Card and appears in neither
    (Requirement 3.5).

    Args:
        turn_messages: The messages of one turn, in order. Not mutated.

    Returns:
        ``(dialogue_ids, evidence_ids)``, each in message order and without duplicates.
    """
    dialogue: list[str] = []
    evidence: list[str] = []
    seen: set[str] = set()

    for message in turn_messages:
        identity = message.get("tracking_id")
        if not identity or identity in seen:
            continue
        seen.add(identity)
        (evidence if is_evidence(message) else dialogue).append(identity)

    return tuple(dialogue), tuple(evidence)


def tool_pairs_of(turn_messages: Sequence[Message]) -> tuple[ToolPair, ...]:
    """Collect the tool pairs of ``turn_messages``, each with its consumption state.

    Pairs are keyed by ``toolUseId``, so one assistant message carrying two ``toolUse`` blocks yields two pairs and a
    message belonging to two pairs contributes its identity to both.

    ``consumed`` comes from order alone: true when an ``assistant`` message carrying a text block appears after the
    pair's last half, within this turn. A message carrying text *and* the pair's ``toolUse`` does not count, since that
    text preceded the result. An incomplete pair — a ``toolUse`` awaiting its result, or a ``toolResult`` whose
    ``toolUse`` sits in an earlier turn — yields a pair holding the half it has, is never consumed, and keeps its
    evidence at full content.

    Args:
        turn_messages: The messages of one turn, in order. Not mutated.

    Returns:
        The pairs, in order of first appearance of their ``toolUseId``.
    """
    names: dict[str, str] = {}
    identities: dict[str, list[str]] = {}
    last_index: dict[str, int] = {}
    last_text_index = -1

    for index, message in enumerate(turn_messages):
        identity = message.get("tracking_id")

        for block in _blocks(message):
            tool_use = block.get("toolUse")
            tool_result = block.get("toolResult")
            if isinstance(tool_use, dict):
                tool_use_id = tool_use.get("toolUseId")
                name = tool_use.get("name") or ""
            elif isinstance(tool_result, dict):
                tool_use_id = tool_result.get("toolUseId")
                name = ""
            else:
                continue
            if not tool_use_id:
                continue

            # Only the ``toolUse`` half names the tool, so the empty name a ``toolResult`` carries neither overwrites
            # one already recorded nor blocks one recorded later.
            names.setdefault(tool_use_id, "")
            if name:
                names[tool_use_id] = name
            identities.setdefault(tool_use_id, [])
            if identity and identity not in identities[tool_use_id]:
                identities[tool_use_id].append(identity)
            last_index[tool_use_id] = index

        if message.get("role") == "assistant" and _carries_text(message):
            last_text_index = index

    return tuple(
        ToolPair(
            tool_use_id=tool_use_id,
            tool_name=names[tool_use_id],
            tracking_ids=tuple(identities[tool_use_id]),
            consumed=last_text_index > last_index[tool_use_id],
        )
        for tool_use_id in names
    )


def _blocks(message: Message) -> Iterator[Mapping[str, Any]]:
    """Yield the dict content blocks of ``message``, skipping anything else.

    Args:
        message: The message to read. Read only.

    Yields:
        Each content block that is a dict.
    """
    for block in message.get("content", []) or []:
        if isinstance(block, dict):
            yield block


def _carries_text(message: Message) -> bool:
    """Report whether ``message`` carries a text block.

    Args:
        message: The message to read. Read only.

    Returns:
        ``True`` when any content block is a text block.
    """
    return any("text" in block for block in _blocks(message))


def derive_card(
    messages: Messages,
    turn_ids: Collection[str],
    turn: int,
    *,
    description_tokens: int,
    tags_per_card: int,
    rarity_weight: float,
) -> Card:
    """Derive the subject Card of one closed turn by scanning that turn's messages.

    Title, Description, Tags and the link fields all come out of one scan: no model call, no embedding call, no disk, no
    network (Requirements 3.2, 3.3). Cost is proportional to the turn's messages plus one linear pass over ``messages``
    to select them; every derivation step runs over the selected messages alone (Requirement 3.9). Messages are
    addressed by durable identity only (Requirement 3.4): one without a ``tracking_id`` is not in ``turn_ids``, takes
    part in no field of the result, and projects whole (Requirement 3.5). Tags here rank rarity as if this Card were the
    graph's only one; :func:`retag` recounts over the whole graph right after registration (Requirement 5.5).

    Args:
        messages: The conversation, as data. Read only.
        turn_ids: Durable identities of one **closed** turn, meaning a later turn boundary exists.
        turn: Turn ordinal of this Card.
        description_tokens: Token ceiling of the Description.
        tags_per_card: Ceiling on the number of Tags.
        rarity_weight: Weight of the rarity term when ranking textual Tag candidates.

    Returns:
        The subject Card. Two runs over the same messages produce equal Cards field by field, with the Description
        identical character for character.
    """
    wanted = frozenset(turn_ids)
    turn_messages = [message for message in messages if message.get("tracking_id") in wanted]

    texts = [text for message in turn_messages for text in _texts_of(message)]
    dialogue_ids, evidence_ids = partition_turn(turn_messages)
    pairs = tool_pairs_of(turn_messages)

    card = Card(
        title=_title_of(turn_messages),
        kind="subject",
        turn=turn,
        dialogue_ids=dialogue_ids,
        evidence_ids=evidence_ids,
        pairs=pairs,
        tool_names=frozenset(pair.tool_name for pair in pairs if pair.tool_name),
        references=_references_of(texts),
        numeric_lines=numeric_lines(texts),
        tags=(),
        description="",
    )

    # Two rewrites and not one: the Description reads the fields above, and the Tags read the Description.
    card = replace(card, description=compose_description(card, description_tokens))
    structural, textual = tag_candidates(card, texts)

    return replace(
        card,
        tags=select_tags(
            textual,
            structural,
            document_frequency={},
            total_cards=1,
            tags_per_card=tags_per_card,
            rarity_weight=rarity_weight,
        ),
    )


def register_card(
    state: _GraphState,
    card: Card,
    messages: Messages,
    *,
    link_threshold: float,
    tags_per_card: int,
    rarity_weight: float,
    similarity: Callable[[Card, Card], float | None] | None = None,
) -> None:
    """Write ``card`` on ``state``, derive its four links, and re-tag the graph.

    The four kinds, none of which costs a model call (Requirement 3.8):

    - **tool**, one per ``toolUse`` tool name, targeting the tool name. Indexes the supplemental referenced source and
      joins two Cards that called the same tool in one hop.
    - **artifact**, one per reference cited in a preview, targeting the reference. The reference is also an artifact
      Card's Title, so the edge resolves whether or not that Card exists yet, making hook order against the offloader
      irrelevant.
    - **follows**, one, to the Card of the immediately preceding turn.
    - **similar**, bidirectional, whenever two Descriptions reach ``link_threshold``. Its weight is the measured
      similarity, the only one of the four carrying a measurement.

    Similarity is read from the vector cache, never measured remotely (Requirement 3.2 keeps this hook free of network);
    an unmeasurable pair gets no edge and is reconsidered next turn. Tool names are iterated sorted, not in
    ``frozenset`` order, so the edge list is identical across runs and the rebuild scan matches the incremental
    construction.

    Args:
        state: The graph state. Mutated: this is the writing half.
        card: The Card to register, as :func:`derive_card` returned it.
        messages: The conversation, for the re-tagging pass. Read only.
        link_threshold: Similarity at or above which two Cards link.
        tags_per_card: Ceiling on the number of Tags.
        rarity_weight: Weight of the rarity term when ranking textual Tag candidates.
        similarity: Measures the similarity of two Descriptions, or returns ``None`` when it cannot without a remote
            call. Defaults to the cache-only measurement.
    """
    measure = similarity or _cached_similarity(state)

    previous = _previous_title(state, card.turn)
    state.cards[card.title] = card
    state.links.setdefault(card.title, [])

    # Sorted, not in frozenset order: string hashing is seeded per process, and link order has to be
    # the same whether the graph was built incrementally or rebuilt by scan.
    for tool_name in sorted(card.tool_names):
        _link(state, card.title, "tool", tool_name, _STRUCTURAL_WEIGHT)

    for reference in card.references:
        _link(state, card.title, "artifact", reference, _STRUCTURAL_WEIGHT)

    if previous is not None:
        _link(state, card.title, "follows", previous, _STRUCTURAL_WEIGHT)

    for other in state.cards.values():
        if other.title == card.title:
            continue
        measured = measure(card, other)
        if measured is not None and measured >= link_threshold:
            _link(state, card.title, "similar", other.title, measured)
            _link(state, other.title, "similar", card.title, measured)

    # Rarity is counted over the Cards of the graph, so a new Card changes what defines the old ones.
    retag(state, messages, tags_per_card=tags_per_card, rarity_weight=rarity_weight)


def derive_and_register(
    state: _GraphState,
    messages: Messages,
    turn_ids: Collection[str],
    turn: int,
    *,
    description_tokens: int,
    tags_per_card: int,
    rarity_weight: float,
    link_threshold: float,
    similarity: Callable[[Card, Card], float | None] | None = None,
) -> Card | None:
    """Derive one Card and register it, degrading to no Card on any failure.

    An exception anywhere in the derivation — Description, Tags, links — completes the hook without registering the
    Card, emits one warning log carrying ``exc_info``, and does not propagate (Requirements 16.4, 16.8). The turn's
    messages then have no Card and project whole (Requirement 16.5). Registration is inside the guarded block and a
    failure restores the state it started from, since a Card written with half-derived links would read as complete to
    every later decision. The snapshot is shallow: one copy of the two indexes per turn.

    Args:
        state: The graph state. Mutated only on success.
        messages: The conversation, as data. Read only.
        turn_ids: Durable identities of one closed turn.
        turn: Turn ordinal of this Card.
        description_tokens: Token ceiling of the Description.
        tags_per_card: Ceiling on the number of Tags.
        rarity_weight: Weight of the rarity term when ranking textual Tag candidates.
        link_threshold: Similarity at or above which two Cards link.
        similarity: Measures the similarity of two Descriptions. Defaults to the cache-only measurement.

    Returns:
        The registered Card, or ``None`` when the derivation failed.
    """
    cards_before = dict(state.cards)
    links_before = {title: list(edges) for title, edges in state.links.items()}

    try:
        card = derive_card(
            messages,
            turn_ids,
            turn,
            description_tokens=description_tokens,
            tags_per_card=tags_per_card,
            rarity_weight=rarity_weight,
        )
        register_card(
            state,
            card,
            messages,
            link_threshold=link_threshold,
            tags_per_card=tags_per_card,
            rarity_weight=rarity_weight,
            similarity=similarity,
        )
    except Exception:
        state.cards.clear()
        state.cards.update(cards_before)
        state.links.clear()
        state.links.update(links_before)
        logger.warning("turn=<%d> | card derivation failed, the turn's messages go whole", turn, exc_info=True)
        return None

    return card


def rebuild(
    messages: Messages,
    *,
    description_tokens: int,
    tags_per_card: int,
    rarity_weight: float,
    link_threshold: float,
    similarity: Callable[[Card, Card], float | None] | None = None,
) -> _GraphState:
    """Derive the whole graph from ``messages`` in one scan — the rebuild scan (Requirement 14.5).

    Every Card, link and turn ordinal is derivable from ``agent.messages``, so a state lost to a restart is rebuilt from
    the conversation: no I/O, no model call, no embedding call. It may run on the ``MessageAddedEvent`` hook only, never
    ``BeforeInvocationEvent`` (Requirement 14.6), which is on the critical path of the model call: reaching nothing
    remote is not the same as being free.

    Out comes one subject Card per closed turn, in turn order, each ordinal being the position of its boundary among the
    closed turns. Artifact Cards are not rebuilt: they own no durable identity, the subject-side ``artifact`` edge
    resolves whether or not its target exists, and ``expand_artifact`` reads the offloader's ``Storage`` by reference
    either way. Their absence costs a listing in ``find_context`` until the next offloaded result registers them, never
    a value.

    A turn whose messages all lack a ``tracking_id`` yields no Card (Requirement 3.5) but still consumes its ordinal, so
    a gap never shifts later ordinals. An empty conversation, one with no closed turn, and one with such a gap all
    complete without raising (Requirement 14.9); a raising derivation is absorbed by :func:`derive_and_register`.
    Similarity uses the same cache-only default as the incremental path, so a fresh state produces no ``similar`` edge,
    and a missing entry costs one embedding on the next turn the reading half runs (Requirement 14.10).

    Args:
        messages: The conversation, as data. Read only. May be empty, may hold no closed turn, and may have gaps in its
            durable identities.
        description_tokens: Token ceiling of each Description.
        tags_per_card: Ceiling on the number of Tags.
        rarity_weight: Weight of the rarity term when ranking textual Tag candidates.
        link_threshold: Similarity at or above which two Cards link.
        similarity: Measures the similarity of two Descriptions. Defaults to the cache-only measurement, which on a
            fresh state can measure nothing.

    Returns:
        A fresh state whose Cards and links equal field by field the ones the incremental construction produces over the
        same conversation, and whose ``turn`` is the number of closed turns (Requirement 14.11 for the conversation that
        has closed none).
    """
    state = _GraphState()
    rebuild_into(
        state,
        messages,
        description_tokens=description_tokens,
        tags_per_card=tags_per_card,
        rarity_weight=rarity_weight,
        link_threshold=link_threshold,
        similarity=similarity,
    )

    return state


def rebuild_into(
    state: _GraphState,
    messages: Messages,
    *,
    description_tokens: int,
    tags_per_card: int,
    rarity_weight: float,
    link_threshold: float,
    similarity: Callable[[Card, Card], float | None] | None = None,
) -> None:
    """Run the rebuild scan of ``messages`` onto ``state``, which the hook already holds.

    Same scan as :func:`rebuild`, writing onto a state that exists rather than returning a new one: the hook reads its
    state out of the per-agent map, so a different object would detach it from its agent.

    ``cards`` and ``links`` are cleared before the scan, making the write idempotent, so running it twice over the same
    conversation leaves the same graph. ``reuse`` and ``vectors`` are left alone: the fed-back note is the one value
    that crosses turns without being derivable from the messages, and cache entries stay valid, being keyed by Title and
    checked against the Description they came from.

    Args:
        state: The graph state to write. Its ``cards``, ``links`` and ``turn`` are replaced.
        messages: The conversation, as data. Read only.
        description_tokens: Token ceiling of each Description.
        tags_per_card: Ceiling on the number of Tags.
        rarity_weight: Weight of the rarity term when ranking textual Tag candidates.
        link_threshold: Similarity at or above which two Cards link.
        similarity: Measures the similarity of two Descriptions. Defaults to the cache-only measurement.
    """
    ranges = closed_turn_ranges(messages)

    state.cards.clear()
    state.links.clear()

    # The ordinal is the position of the boundary, not the count of Cards derived so far, so a turn that yields no Card
    # leaves the ordinals of the following turns where the incremental construction put them.
    for turn, (start, stop) in enumerate(ranges):
        turn_ids = _identities_of(messages[start:stop])
        if not turn_ids:
            continue

        derive_and_register(
            state,
            messages,
            turn_ids,
            turn,
            description_tokens=description_tokens,
            tags_per_card=tags_per_card,
            rarity_weight=rarity_weight,
            link_threshold=link_threshold,
            similarity=similarity,
        )

    state.turn = len(ranges)


def _identities_of(turn_messages: Sequence[Message]) -> tuple[str, ...]:
    """Collect the durable identities of ``turn_messages``, in order and without duplicates.

    Args:
        turn_messages: The messages of one turn, in order. Read only.

    Returns:
        The identities. A message carrying none contributes nothing: it is a message without a Card.
    """
    found: dict[str, None] = {}
    for message in turn_messages:
        identity = message.get("tracking_id")
        if identity:
            found.setdefault(identity, None)

    return tuple(found)


def retag(state: _GraphState, messages: Messages, *, tags_per_card: int, rarity_weight: float) -> None:
    """Recount rarity over the Cards of ``state`` and re-tag every one of them (Requirement 5.5).

    A Tag present in every Card distinguishes nothing, so gaining a Card changes the Tags of the ones already there.
    ``document_frequency`` and ``total_cards`` are counted over the graph's Cards only. Candidates are re-extracted from
    the same three sources as the first derivation: tool names, references, and a regex over the text of the Card's
    messages (Requirement 5.2). Texts are bucketed by durable identity in one pass over ``messages``, so re-tagging
    costs one pass plus one lookup per identity.

    No model call and no embedding call (Requirement 5.8), and the result is a function of the state and the messages,
    so two runs agree Card by Card (Requirement 5.9). Descriptions are untouched, keeping the vector cache valid across
    a re-tag.

    Args:
        state: The graph state. Its Cards are replaced with re-tagged copies.
        messages: The conversation, for the candidate scan. Read only.
        tags_per_card: Ceiling on the number of Tags.
        rarity_weight: Weight of the rarity term when ranking textual Tag candidates.
    """
    texts_by_id = _texts_by_id(messages)

    candidates = {title: tag_candidates(card, _card_texts(card, texts_by_id)) for title, card in state.cards.items()}

    document_frequency: dict[str, int] = {}
    for structural, textual in candidates.values():
        for token in {*structural, *textual}:
            document_frequency[token] = document_frequency.get(token, 0) + 1

    total_cards = len(state.cards)
    for title, (structural, textual) in candidates.items():
        state.cards[title] = replace(
            state.cards[title],
            tags=select_tags(
                textual,
                structural,
                document_frequency=document_frequency,
                total_cards=total_cards,
                tags_per_card=tags_per_card,
                rarity_weight=rarity_weight,
            ),
        )


def derive_artifact_cards(
    result: ToolResult,
    tool_name: str,
    turn: int,
    *,
    description_tokens: int,
    tags_per_card: int,
    rarity_weight: float,
) -> tuple[Card, ...]:
    """Derive one artifact Card per reference the offloaded ``result`` names (Requirement 3.7).

    The Card holds the reference and nothing else the tool returned; the raw return belongs to the offloader's
    ``Storage`` and is read back through ``expand_artifact``. Stored here is the address, the two facts the placeholder
    states about it (``content_type`` and ``size_bytes``), and for textual content the numeric lines of the preview, by
    literal line selection and never as a copy of the return. Non-textual content gets no lines rather than a sibling
    block's preview lines (Requirement 4.8).

    A result carrying no reference yields no Card, which is the whole no-offloader path (Requirement 15.5): with no
    ``ContextOffloader`` registered nothing replaces the tool return, the scan finds no reference, an empty tuple comes
    back, and the subject Cards are untouched. No branch asks whether the offloader is present.

    The reference is read out of the preview text, so hook order against the offloader costs at most a turn of latency:
    the same scan reaches the same references later from ``agent.messages``.

    Args:
        result: The tool result as the hook sees it, after any replacement. Only read.
        tool_name: Name of the tool that produced the content. May be empty.
        turn: Turn ordinal the artifact was produced in.
        description_tokens: Token ceiling of the Description.
        tags_per_card: Ceiling on the number of Tags.
        rarity_weight: Weight of the rarity term when ranking textual Tag candidates.

    Returns:
        One Card per reference, in order of first appearance. Empty when the result names none.
    """
    texts = _texts_of({"role": "user", "content": [{"toolResult": result}]})
    references = _references_of(texts)
    if not references:
        return ()

    metadata = _artifact_metadata(texts, references)
    lines = numeric_lines(texts)

    return tuple(
        _artifact_card(
            reference,
            tool_name,
            turn,
            metadata.get(reference, (None, None)),
            lines,
            description_tokens=description_tokens,
            tags_per_card=tags_per_card,
            rarity_weight=rarity_weight,
        )
        for reference in references
    )


def register_artifact_cards(
    state: _GraphState,
    cards: Sequence[Card],
    messages: Messages,
    *,
    tags_per_card: int,
    rarity_weight: float,
) -> None:
    """Write ``cards`` on ``state`` with their tool links, and re-tag the graph once.

    An artifact Card gets one link kind, not four. The **tool** edge reaches it from the Card of the turn that called
    the tool; the ``artifact`` edge pointing *at* it is already derived on the subject side from the reference, which is
    why that edge resolves whether or not this Card exists yet. The other three are absent: ``follows`` orders turns and
    an artifact is not a turn, and ``similar`` would propagate note into a Card that Requirement 11.8 keeps out of full
    content by automatic choice.

    Re-tagging runs once for the whole batch, not once per Card: rarity is counted over the graph's Cards and the count
    is only correct once every Card of the batch is in.

    Args:
        state: The graph state. Mutated: this is the writing half.
        cards: The artifact Cards, as :func:`derive_artifact_cards` returned them.
        messages: The conversation, for the re-tagging pass. Read only.
        tags_per_card: Ceiling on the number of Tags.
        rarity_weight: Weight of the rarity term when ranking textual Tag candidates.
    """
    if not cards:
        return

    for card in cards:
        state.cards[card.title] = card
        state.links.setdefault(card.title, [])
        # Sorted for the same reason as in ``register_card``: seeded string hashing would otherwise
        # make the rebuilt link order differ from the incremental one.
        for name in sorted(card.tool_names):
            _link(state, card.title, "tool", name, _STRUCTURAL_WEIGHT)

    retag(state, messages, tags_per_card=tags_per_card, rarity_weight=rarity_weight)


def derive_and_register_artifacts(
    state: _GraphState,
    messages: Messages,
    result: ToolResult,
    tool_name: str,
    turn: int,
    *,
    description_tokens: int,
    tags_per_card: int,
    rarity_weight: float,
) -> tuple[Card, ...]:
    """Derive the artifact Cards of one tool result and register them, degrading to none on failure.

    Same failure contract as :func:`derive_and_register`: an exception anywhere completes the hook without registering
    anything, emits one warning log carrying ``exc_info``, and does not propagate (Requirements 16.4, 16.8). A batch is
    restored whole, since half a batch would leave a reference with a Card and its sibling without one. A tool result
    naming no reference is not a failure and logs nothing: it is the ordinary shape of a result no offloader replaced
    (Req. 15.5).

    Args:
        state: The graph state. Mutated only on success.
        messages: The conversation, for the re-tagging pass. Read only.
        result: The tool result as the hook sees it, after any replacement. Read only.
        tool_name: Name of the tool that produced the content. May be empty.
        turn: Turn ordinal the artifact was produced in.
        description_tokens: Token ceiling of the Description.
        tags_per_card: Ceiling on the number of Tags.
        rarity_weight: Weight of the rarity term when ranking textual Tag candidates.

    Returns:
        The registered Cards, or an empty tuple when there was none to register or the derivation failed.
    """
    cards_before = dict(state.cards)
    links_before = {title: list(edges) for title, edges in state.links.items()}

    try:
        cards = derive_artifact_cards(
            result,
            tool_name,
            turn,
            description_tokens=description_tokens,
            tags_per_card=tags_per_card,
            rarity_weight=rarity_weight,
        )
        register_artifact_cards(
            state,
            cards,
            messages,
            tags_per_card=tags_per_card,
            rarity_weight=rarity_weight,
        )
    except Exception:
        state.cards.clear()
        state.cards.update(cards_before)
        state.links.clear()
        state.links.update(links_before)
        logger.warning("turn=<%d> | artifact card derivation failed, the graph keeps none", turn, exc_info=True)
        return ()

    return cards


def _artifact_card(
    reference: str,
    tool_name: str,
    turn: int,
    metadata: tuple[str | None, int | None],
    lines: Sequence[str],
    *,
    description_tokens: int,
    tags_per_card: int,
    rarity_weight: float,
) -> Card:
    """Assemble one artifact Card around ``reference``.

    The reference is the Title, which lets the subject-side ``artifact`` edge resolve onto this Card without either side
    knowing which ran first. ``dialogue_ids`` and ``evidence_ids`` are empty by contract: an artifact addresses the
    offloader's ``Storage`` and not messages, so it owns no durable identity and no resolution of its parts can drop a
    message. ``references`` is empty because the address lives in ``reference`` alone.

    Args:
        reference: The artifact reference, as the preview stated it.
        tool_name: Name of the tool that produced the content. May be empty.
        turn: Turn ordinal the artifact was produced in.
        metadata: ``(content_type, size_bytes)``, either of which may be ``None``.
        lines: Numeric lines of the preview, used only when the content is textual.
        description_tokens: Token ceiling of the Description.
        tags_per_card: Ceiling on the number of Tags.
        rarity_weight: Weight of the rarity term when ranking textual Tag candidates.

    Returns:
        The artifact Card, with its Description and Tags derived.
    """
    content_type, size_bytes = metadata

    card = Card(
        title=reference,
        kind="artifact",
        turn=turn,
        dialogue_ids=(),
        evidence_ids=(),
        pairs=(),
        tool_names=frozenset({tool_name}) if tool_name else frozenset(),
        references=(),
        numeric_lines=tuple(lines) if _is_textual(content_type) else (),
        tags=(),
        description="",
        reference=reference,
        content_type=content_type,
        size_bytes=size_bytes,
    )

    card = replace(card, description=compose_description(card, description_tokens))
    structural, textual = tag_candidates(card, ())

    return replace(
        card,
        tags=select_tags(
            textual,
            structural,
            document_frequency={},
            total_cards=1,
            tags_per_card=tags_per_card,
            rarity_weight=rarity_weight,
        ),
    )


def _artifact_metadata(texts: Sequence[str], references: Collection[str]) -> dict[str, tuple[str | None, int | None]]:
    """Read the ``content_type`` and the size of each reference of ``references`` out of ``texts``.

    Two sources, because the offloader writes two. The listing under ``[Stored references:]`` states a descriptor per
    reference — ``(text, 4,096 chars)``, ``(json, 900 bytes)``, ``(image/png, 900 bytes)`` — and a non-text block also
    becomes a placeholder naming its format inline. The placeholder wins on ``content_type``, being the only source
    naming a document's format: the listing describes a document by file name, which is not a media type. Only
    references the reference scan already found are recorded, so a parenthesized line of preview prose cannot invent an
    entry, and a fact neither source states stays ``None`` rather than being guessed.

    Args:
        texts: Texts of the tool result, in block order. Not mutated.
        references: The references found by the reference scan.

    Returns:
        Reference to ``(content_type, size_bytes)``. A reference neither source describes is absent.
    """
    known = frozenset(references)
    metadata: dict[str, tuple[str | None, int | None]] = {}

    for text in texts:
        for line in text.splitlines():
            listed = _LISTED_ENTRY.match(line)
            if listed and listed.group(1) in known:
                metadata[listed.group(1)] = _descriptor_facts(listed.group(2))

        for placeholder in _PLACEHOLDER.finditer(text):
            fields = placeholder.group(2)
            named = _inline_references(fields)
            if not named or named[0] not in known:
                continue

            fmt = fields.split(",")[0].strip()
            size = _SIZE_IN_BYTES.search(fields)
            metadata[named[0]] = (
                f"{_PLACEHOLDER_TYPES[placeholder.group(1)]}/{fmt}" if fmt else None,
                _byte_count(size.group(1)) if size else None,
            )

    return metadata


def _descriptor_facts(descriptor: str) -> tuple[str | None, int | None]:
    """Read a ``content_type`` and a size out of one listed descriptor.

    The head is the field before the first comma. ``text`` and ``json`` are the two bare words the offloader writes;
    anything carrying a ``/`` is a media type as written; anything else is a document's file name, which names no type,
    so none is claimed.

    Args:
        descriptor: The parenthesized descriptor of a listed reference, without its parentheses.

    Returns:
        ``(content_type, size_bytes)``, either of which may be ``None``.
    """
    head, _, tail = descriptor.partition(",")
    head = head.strip()

    content_type = _DESCRIPTOR_TYPES.get(head) or (head if "/" in head else None)
    size = _SIZE_IN_BYTES.search(tail)

    return content_type, _byte_count(size.group(1)) if size else None


def _byte_count(digits: str) -> int | None:
    """Read a byte count written with thousands separators, or ``None`` when it does not parse.

    Args:
        digits: The digits as the offloader wrote them, separators included.

    Returns:
        The count, or ``None`` when what was matched is not a number after all.
    """
    stripped = re.sub(r"[,._]", "", digits)

    return int(stripped) if stripped.isdigit() else None


def _title_of(turn_messages: Sequence[Message]) -> str:
    """Derive the Title of a turn: a literal prefix of the message that opened it.

    Falls back to the turn's first message when none is a boundary, which happens when the boundary message carries no
    ``tracking_id`` and is therefore a message without a Card.

    Args:
        turn_messages: The messages of one turn, in order. Read only.

    Returns:
        A literal prefix of the turn's user text, or ``""`` when the turn carries no text at all.
    """
    for message in turn_messages:
        if is_turn_boundary(message):
            return title_for(" ".join(_texts_of(message)))

    for message in turn_messages:
        texts = _texts_of(message)
        if texts:
            return title_for(" ".join(texts))

    return ""


def _previous_title(state: _GraphState, turn: int) -> str | None:
    """Find the Title of the subject Card of the turn immediately preceding ``turn``.

    Chosen by the largest turn ordinal below ``turn``, not by insertion order, so the edge is the same whether the graph
    was built turn by turn or rebuilt in one scan.

    Args:
        state: The graph state. Read only.
        turn: Turn ordinal of the Card being registered.

    Returns:
        The preceding subject Card's Title, or ``None`` when there is no earlier turn.
    """
    earlier = [card for card in state.cards.values() if card.kind == "subject" and card.turn < turn]
    if not earlier:
        return None

    return max(earlier, key=lambda card: card.turn).title


def _link(state: _GraphState, source: str, kind: str, target: str, weight: float) -> None:
    """Add, or update, one directed edge from ``source`` to ``target``.

    An edge already present with the same kind and target has its weight replaced, not duplicated. That makes
    registering the same Card twice, or re-measuring a similarity, idempotent in the edge list, which lets the rebuild
    scan produce the same links as the incremental construction.

    Args:
        state: The graph state. Mutated.
        source: Title of the Card the edge leaves.
        kind: One of the four link kinds.
        target: A Card Title, or a tool name when ``kind`` is ``"tool"``.
        weight: Edge weight.
    """
    edges = state.links.setdefault(source, [])
    edge = Link(kind=kind, target=target, weight=weight)  # type: ignore[arg-type]

    for index, existing in enumerate(edges):
        if existing.kind == kind and existing.target == target:
            edges[index] = edge
            return

    edges.append(edge)


def _cached_similarity(state: _GraphState) -> Callable[[Card, Card], float | None]:
    """Build the default similarity measurement: the vector cache, and never a remote call.

    Returns ``None`` — unmeasurable, not unrelated — whenever either Description has no cached vector or has one
    computed from a different text. ``0.0`` would assert the two Cards unrelated on no evidence; ``None`` leaves the
    edge for the next turn, after the reading half embeds the Description.

    Args:
        state: The graph state whose ``vectors`` cache is read. Not mutated.

    Returns:
        A callable measuring two Cards, or returning ``None`` when it cannot without a remote call.
    """

    def measure(left: Card, right: Card) -> float | None:
        left_entry = state.vectors.get(left.title)
        right_entry = state.vectors.get(right.title)
        if left_entry is None or right_entry is None:
            return None
        if left_entry[0] != left.description or right_entry[0] != right.description:
            return None

        return cosine_similarity(left_entry[1], right_entry[1])

    return measure


def _texts_by_id(messages: Messages) -> dict[str, tuple[str, ...]]:
    """Bucket the texts of ``messages`` by durable identity, in one pass.

    Args:
        messages: The conversation, as data. Read only.

    Returns:
        Durable identity to the texts of that message, in block order. Messages without a ``tracking_id`` contribute
        nothing: they are messages without a Card.
    """
    buckets: dict[str, tuple[str, ...]] = {}
    for message in messages:
        identity = message.get("tracking_id")
        if identity:
            buckets[identity] = (*buckets.get(identity, ()), *_texts_of(message))
    return buckets


def _card_texts(card: Card, texts_by_id: Mapping[str, tuple[str, ...]]) -> tuple[str, ...]:
    """Collect the texts of ``card``'s messages, in dialogue-then-evidence order.

    Args:
        card: The Card whose texts to collect. Read only.
        texts_by_id: Texts bucketed by durable identity, as :func:`_texts_by_id` returns them.

    Returns:
        The texts, in a fixed order. An identity no longer present in the conversation contributes nothing, which is how
        a Card survives its messages being dropped without raising.
    """
    return tuple(
        text for identity in (*card.dialogue_ids, *card.evidence_ids) for text in texts_by_id.get(identity, ())
    )


def _texts_of(message: Message) -> tuple[str, ...]:
    """Collect the texts ``message`` carries, its ``toolResult`` content included.

    A preview lives in the ``toolResult`` text and cites the artifact references, so a scan skipping it would derive no
    artifact link and hook order against the offloader would start to matter.

    Args:
        message: The message to read. Read only.

    Returns:
        The texts, in block order.
    """
    texts: list[str] = []
    for block in _blocks(message):
        text = block.get("text")
        if isinstance(text, str):
            texts.append(text)

        result = block.get("toolResult")
        if isinstance(result, dict):
            for inner in result.get("content", []) or []:
                if isinstance(inner, dict) and isinstance(inner.get("text"), str):
                    texts.append(inner["text"])

    return tuple(texts)


def _references_of(texts: Sequence[str]) -> tuple[str, ...]:
    """Extract the artifact references cited in ``texts``, in order of first appearance.

    Two shapes, because the offloader writes two. A non-text block becomes a placeholder naming its reference inline —
    ``[image: png, 900 bytes | ref: mem_1_tu-3_0]`` — and every stored block is listed under a ``[Stored references:]``
    header, one indented line each. Reading the reference off the preview text makes the graph independent of hook order
    against the offloader: by the time a ``toolResult`` is a message, its preview names every reference it produced.

    Args:
        texts: Texts of the Card's messages, in message order. Not mutated.

    Returns:
        The references, without duplicates, in order of first appearance.
    """
    found: dict[str, None] = {}

    for text in texts:
        listing = False
        for line in text.splitlines():
            for reference in _inline_references(line):
                found.setdefault(reference, None)

            if _STORED_REFERENCES in line:
                listing = True
                continue

            if not listing:
                continue

            listed = _LISTED_REFERENCE.match(line)
            if listed:
                found.setdefault(listed.group(1), None)
            elif line.strip():
                # The listing is the preview's tail, so the first line neither blank nor a listed reference ends it.
                listing = False

    return tuple(found)

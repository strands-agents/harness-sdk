"""``ContextStrategy``: the single Context Strategy of an agent, and the validation it enforces.

This module owns the construction surface. Validation happens here and only here, so a
misconfiguration fails at construction instead of surfacing later as a strategy that is quietly
inert or incoherent. Construction is pure bookkeeping: no network call, no model client, no AWS
client, no async task — and a construction that raises has registered nothing on any agent, which is
trivially true because at construction time there is no agent yet (Requirement 2.17).

**Validation is of shape, never of merit.** A value is rejected for being the wrong kind of thing —
a bool where a ratio was expected, a float where a count was expected, a range violation — never for
being a poor choice. The one relational check, ``collapse_floor <= expand_threshold``, is shape too:
a floor above the ceiling makes the middle resolution unreachable, so the ladder would have two
steps while the configuration claims three.

There is no ``model`` parameter: the Card is the turn, derived by scan, and the only remote call the
graph ever makes is the similarity matcher (Requirement 2.19).
"""

from __future__ import annotations

import contextvars
import json
import logging
import math
import time
import weakref
from collections.abc import Mapping
from dataclasses import dataclass, replace
from numbers import Real
from typing import TYPE_CHECKING, Any, Literal, cast

from ..._middleware.stages import InvokeModelStage
from ...agent.conversation_manager.null_conversation_manager import NullConversationManager
from ...hooks.events import AfterToolCallEvent, BeforeInvocationEvent, MessageAddedEvent
from ...injection._message_injection import _create_injection_middleware  # verbatim reuse
from ...models.model import _estimate_tokens_with_heuristic  # verbatim reuse
from ...plugins import Plugin
from ...tools.decorator import tool
from ...types.tools import ToolContext
from ..progressive_tool_disclosure.plugin import _instrument  # verbatim reuse
from . import persistence, tools
from .cards import (
    closed_turn_ranges,
    derive_and_register,
    derive_and_register_artifacts,
    is_turn_boundary,
    rebuild_into,
    turn_ranges,
)
from .compaction import render_final_block
from .describe import _estimate_tokens  # verbatim reuse: the same heuristic the Description is cut by
from .ranking import rerank
from .scoring import (
    _titles_by_descending_note,
    compute_notes,
    distribute,
    expire_reuse,
    full_pass_choice,
    select,
    titles_in_turn_order,
    warm_up_choice,
)
from .state import CardChoice, TurnChoice, _GraphState, _GraphStates

if TYPE_CHECKING:
    from ..._middleware.stages import InvokeModelContext
    from ...agent.agent import Agent
    from ...injection.types import InjectionContext
    from ...types.content import Messages
    from ...types.tools import ToolResult

logger = logging.getLogger(__name__)

_DEFAULT_NAME = "strands:context-strategy"
"""Default plugin name; override to tell multiple instances apart in logs."""

_DEFAULT_EXPAND_THRESHOLD = 0.55
"""Note at or above which a Card is Full Content, budget permitting."""

_DEFAULT_COLLAPSE_FLOOR = 0.45
"""Note below which a Card keeps only its Title.

A threshold is only calibratable against the distribution of the pair it compares: this one against
question-against-Description, ``link_threshold`` against Description-against-Description, with
propagation strength part of both. Cosine similarity between two texts of the same language does not
approach zero, so a floor chosen on the intuition that "irrelevant scores near nothing" sits outside
the range the matcher actually answers in. Both values answer to the default matcher's distribution
and do not carry over to another implementation.
"""

_DEFAULT_DESCRIPTION_TOKENS = 100
"""Token ceiling of a Description."""

_DEFAULT_TAGS_PER_CARD = 5
"""How many identifiers define a Card."""

_DEFAULT_RARITY_WEIGHT = 0.70
"""Weight of rarity against repetition when ranking textual Tag candidates."""

_DEFAULT_BODY_BUDGET: int | None = None
"""Token ceiling across Cards in Full Content. ``None`` means no ceiling, as explicit configuration."""

_DEFAULT_MIN_CARDS = 3
"""Below this many Cards the whole choice is skipped: the only possible decision is "send it all"."""

_DEFAULT_LINK_THRESHOLD = 0.50
"""Similarity at or above which two Cards link to each other."""

_DEFAULT_REUSE_TTL_CYCLES = 5
"""Model cycles a Fed-Back Note survives."""

_DEFAULT_RECENT_CARDS: int | None = None
"""How many of the most recent Cards a call always addresses. ``None`` addresses every Card.

``None`` by default because selection changes the failure mode rather than tuning it. Addressing every
Card, Resolution only ever steps down, so a Card the note scored wrong still travels with its Title and
the model can name it. Under selection a missed Card is invisible and cannot be asked for, which turns
a recoverable poorer answer into a wrong one with no symptom. The trade is that addressing every Card
grows the call linearly with the conversation and leaves the links with no work, since propagation
cannot be why a Card is reached when none is ever excluded.
"""

_DEFAULT_SELECT_TOP_K = 5
"""How many Cards the note adds beyond the recency window. Read only when selection is on."""


@dataclass
class _Delivery:
    """What the fold's ``render_content`` needs from the delivery handler that called it.

    The fold handler is built once, at construction, so the render callback it closes over cannot
    receive the call's request as an argument. This record carries it across, through a
    ``ContextVar`` — async-safe and per task, so two agents delivering concurrently never read each
    other's request.

    ``error`` is the other half of atomic degradation. The injection primitive fails open: a
    ``render_content`` that raises makes it log and return the context it was handed, which by then
    already carries the removal. That is exactly the intermediate state Requirement 16.2 forbids. So
    the render catches its own failure here, returns ``None``, and the delivery handler re-raises it
    into the single ``try`` that returns the *received* context by identity, with one warning.

    Attributes:
        requested: The identities the removal asked to drop on this call.
        error: The exception the compaction raised, or ``None``.
    """

    requested: frozenset[str]
    error: BaseException | None = None


_DELIVERY: contextvars.ContextVar[_Delivery | None] = contextvars.ContextVar("context_graph_delivery", default=None)
"""The in-flight delivery, read by ``_render`` and set by the handler that calls the fold.

Set and reset around one ``await``, so no failure state survives the call (Requirement 16.3).
"""


def _current_turn_ids(messages: Messages) -> frozenset[str]:
    """Durable identities of the turn in progress: the trailing range of ``messages``.

    ``turn_ranges``' last range is the open turn by definition — a turn is closed by what comes after
    it — so this is the same slice ``closed_turn_ranges`` excludes, read from the other side. The
    removal subtracts it, which is how Requirements 3.6 and 6.2 hold by one set difference rather
    than by a check at every resolution site.

    Args:
        messages: The call's message list. Only read.

    Returns:
        The identities of the open turn. Empty when no message opens a turn.
    """
    ranges = turn_ranges(messages)
    if not ranges:
        return frozenset()
    start, stop = ranges[-1]
    return frozenset(identity for message in messages[start:stop] if (identity := message.get("tracking_id")))


def _identities_in(messages: Messages) -> tuple[str, ...]:
    """Durable identities of ``messages``, in order and without duplicates.

    Same shape the rebuild scan feeds :func:`~.cards.derive_and_register`, which is what makes the
    incremental construction and the scan produce the same Card for the same turn (Requirement 14.5).

    Args:
        messages: The messages of one turn, in order. Only read.

    Returns:
        The identities. A message carrying none contributes nothing: it is a message without a Card.
    """
    return tuple(dict.fromkeys(identity for message in messages if (identity := message.get("tracking_id"))))


def _question_of(messages: Messages) -> str:
    """Text the turn's Cards are scored against: the texts of the last user message.

    Read off the invocation's input messages rather than off ``agent.messages``, because
    ``BeforeInvocationEvent`` fires *before* the turn's message is appended to the history — the
    question the choice is about is not in the history yet.

    Args:
        messages: The messages to read the question from, in order. Only read.

    Returns:
        The texts of the last user message, joined. Empty when no user message carries text, which
        scores every Card against nothing and therefore keeps the whole graph at its floor.
    """
    for message in reversed(messages):
        if message.get("role") != "user":
            continue
        texts = [
            block["text"]
            for block in message.get("content") or ()
            if isinstance(block, dict) and isinstance(block.get("text"), str)
        ]
        if texts:
            return " ".join(texts)

    return ""


def _cycle_of(agent: Agent) -> int:
    """Model cycle counter of ``agent``, which is the clock the Fed-Back Note is aged by.

    ``agent.event_loop_metrics.cycle_count`` and nothing else: the same form of counting the tool
    exposure TTL uses (Requirement 13.3), so a slow provider call or a burst of messages inside one
    cycle never ages a note. Read defensively because the retrieval tools reach here from a
    ``ToolContext``, whose ``agent`` is typed ``Any`` for backwards compatibility.

    Args:
        agent: The agent of the call. Only read.

    Returns:
        The counter, or ``0`` when the agent exposes none — which grants a note the full TTL rather
        than none at all, in the direction of every other fail-safe here.
    """
    count = getattr(getattr(agent, "event_loop_metrics", None), "cycle_count", 0)
    return count if isinstance(count, int) and not isinstance(count, bool) else 0


RETRIEVAL_TOOL_NAMES = frozenset(
    {tools.expand_card.__name__, tools.expand_artifact.__name__, tools.find_context.__name__}
)
"""The three tools the final block tells the model to reach a collapsed turn with.

Read off the implementations rather than written out, because the ``@tool`` methods take their names
from these and a literal here would rot the moment one is renamed.

Published as part of the supplemental referenced source whenever a block is rendered, because a
pre-specification carries no ``inputSchema`` and a tool the model cannot call is not an escape hatch.
"""


def _derive_referenced(state: _GraphState, choice: TurnChoice) -> frozenset[str]:
    """Tool names the call still mentions: those of every Card whose evidence is not at title.

    The supplemental referenced source, derived and nothing more. The deciding axis is the evidence,
    because the evidence is where a tool name lives: at full content the ``toolUse`` blocks stay in the
    retained history, so ``ProgressiveToolDisclosure`` derives the name itself; at description the
    final block renders ``tools: run_query (2)``, which is a mention by the very criterion B already
    applies to the history (Requirement 10.7). Either way the name is genuinely referenced.

    **Requirement 10.8's omission is vacuous by construction, and that is correct.** The evidence axis
    has two rungs and two only — :func:`~.scoring.distribute` never yields ``"title"`` for it, on
    purpose: a tool result with no content at all leaves the model without the referent of the
    questions that follow. So no Card can reach the state this criterion omits, and every tool name is
    always published. Nothing is being withheld because there is nothing to withhold: a Card whose
    dialogue collapsed to its title line still carries its tool result at one of the two evidence
    rungs, and therefore still mentions the tool. The criterion is kept as written so the direction is
    pinned should the axis ever gain the third rung.

    A title absent from the choice is read as full content, the same way :func:`~.removal.removal_ids`
    and the compaction read it: absent means keep, in the direction of every other fail-safe here. That
    is also what makes a full pass publish every name — under a full pass the whole history travels
    whole, so every name is referenced anyway.

    Args:
        state: The graph state. Read only.
        choice: The turn choice, frozen at ``BeforeInvocationEvent``.

    Returns:
        The names to publish. Empty when the graph holds no Card; otherwise, in practice, every name
        the graph's Cards mention.
    """
    names: set[str] = set()
    for title, card in state.cards.items():
        card_choice = choice.by_title.get(title)
        if card_choice is not None and card_choice.evidence == "title":
            continue
        names.update(card.tool_names)

    if not choice.full_pass and state.cards:
        # The retrieval tools the final block names, by the same criterion every other name here
        # answers to: the call mentions them, so they are referenced. Without this they arrive as a
        # pre-specification — a name with an empty ``inputSchema`` — and the block invites the model
        # to call a tool it has no way to call. Measured across every run of the strategy, the
        # retrieval cycle count was zero in all of them, and this is why: the escape hatch the design
        # relies on has never once been reachable when disclosure was installed.
        #
        # The decision stays with ``ProgressiveToolDisclosure``: this publishes names, and which names
        # carry a full specification is still its call (Requirements 10.6, 12.15).
        names.update(RETRIEVAL_TOOL_NAMES)

    return frozenset(names)


# ---- observability -----------------------------------------------------------------------------
#
# Every emission below is reached exclusively through ``_instrument``, reused verbatim from
# ``progressive_tool_disclosure``: it runs one emission and swallows whatever it raises, without
# logging the failure — a logger that raises is precisely the case it exists to cover, so reaching for
# the logger in the handler would reintroduce what was just guarded. That is what makes Requirement
# 17.11 hold by shape: no operation here can learn that its own observability failed.


def _card_resolution(choice: CardChoice) -> str:
    """The single Resolution a Card's *delivery* is counted at, folding its two independent axes.

    Full content only when *nothing* collapsed, title only when nothing but the title line is left,
    and description for everything in between. The fold is the right question for exactly one reader,
    :func:`_log_compaction_ratios`, and that is the only caller left: a Card whose Description was
    folded into the call is precisely what the ratio of Requirement 17.10 measures, and a Card whose
    dialogue collapsed while its evidence still travels whole *did* have its Description folded in.

    It is deliberately **not** what the choice record counts. A Card holds one Resolution per axis, so
    folding them there made the record report the fold instead of the ladder — see :func:`_log_choice`.

    Args:
        choice: The resolution of both parts of one Card.

    Returns:
        ``"full"``, ``"description"`` or ``"title"``.
    """
    if choice.dialogue == "full" and choice.evidence == "full":
        return "full"
    if choice.dialogue == "title" and choice.evidence == "title":
        return "title"
    return "description"


def _log_choice(state: _GraphState, elapsed_ns: int) -> None:
    """Log one info record per turn choice: the counts per axis, and what the choice itself cost.

    A Card does not hold one Resolution — it holds one per axis, and the two are decided
    independently: the dialogue by the note, over three rungs, and the evidence by the order of the
    messages, over two. So the counts are reported per axis (Requirement 17.6). Folding them into one
    bucket makes the record report the fold rather than the ladder: every Card whose dialogue
    collapsed lands in ``description`` whenever its evidence did not collapse with it, and no Card
    ever lands in ``title`` at all, because :func:`~.scoring.distribute` never yields ``"title"`` for
    evidence. Read that way an 18-turn session shows one rung where the dialogue ladder in fact used
    all three.

    The evidence axis has two rungs and therefore two counts. There is no ``evidence_title`` to
    report, and a zero there would read as an empty rung rather than as an absent one.

    ``choice_micros`` spans the choice and nothing else — the model call is not inside the measured
    region and no total is ever accumulated across the two — so the overhead of the choice is readable
    on its own, which is what Requirement 17.12 asks for.

    A Card absent from the choice is counted at full content on both axes, the same way the removal,
    the compaction and the supplemental referenced source all read an absent entry: absent means keep.
    A full pass is every Card at full content on both axes by definition, so it needs no per-Card
    lookup.

    Args:
        state: The graph state, for its Cards and its frozen choice. Only read.
        elapsed_ns: Nanoseconds the choice took, measured with ``time.perf_counter_ns``.
    """
    dialogue = {"full": 0, "description": 0, "title": 0}
    evidence = {"full": 0, "description": 0, "title": 0}
    choice = state.choice
    for title in state.cards:
        card_choice = None if choice.full_pass else choice.by_title.get(title)
        dialogue["full" if card_choice is None else card_choice.dialogue] += 1
        evidence["full" if card_choice is None else card_choice.evidence] += 1

    # Not a rung of the evidence ladder: a Card the selection did not address contributes nothing to
    # the call, so it is counted apart from the two rungs a Card actually travels at.
    unaddressed = len(state.cards) - len(choice.selected) if choice.selected is not None else 0

    logger.info(
        "turn choice computed | turn=<%d>"
        " | dialogue_full=<%d> | dialogue_description=<%d> | dialogue_title=<%d>"
        " | evidence_full=<%d> | evidence_description=<%d>"
        " | unaddressed=<%d> | choice_micros=<%d>",
        state.turn,
        dialogue["full"],
        dialogue["description"],
        dialogue["title"],
        evidence["full"],
        evidence["description"],
        unaddressed,
        elapsed_ns // 1_000,
    )


def _log_notes(notes: Mapping[str, float], expand_threshold: float, collapse_floor: float) -> None:
    """Log the spread of the turn's notes against the two thresholds that read them.

    The choice record counts which rungs were used; this one says *why*, and the difference matters
    because a rung nobody reaches has two causes that the counts alone cannot tell apart. Either no
    Card was that irrelevant, or the threshold sits outside the range the matcher actually answers in
    — and the second is the case measured against ``cohere.embed-multilingual-v3``, whose similarity
    between two same-language texts has a floor well above ``collapse_floor``'s default. Without the
    spread, calibrating a threshold means guessing at the scale of the very numbers it compares.

    The thresholds travel in the record next to the spread so a reader does not have to hold the
    configuration in their head to see which side of them the distribution fell on.

    Args:
        notes: The turn's note per Card. Only read.
        expand_threshold: Note at or above which the dialogue is full content.
        collapse_floor: Note below which the dialogue is title only.
    """
    values = sorted(notes.values())
    middle = len(values) // 2
    logger.debug(
        "note spread computed | cards=<%d> | min=<%.4f> | median=<%.4f> | max=<%.4f>"
        " | below_floor=<%d> | above_threshold=<%d> | floor=<%.4f> | threshold=<%.4f>",
        len(values),
        values[0],
        values[middle],
        values[-1],
        sum(1 for value in values if value < collapse_floor),
        sum(1 for value in values if value >= expand_threshold),
        collapse_floor,
        expand_threshold,
    )


def _log_retrieval_cycles(turn: int, cycles: int) -> None:
    """Log the retrieval cycles the turn that just ended spent (Requirement 17.8).

    The counter is incremented inside the three retrieval tools, because that is where the invocation
    is, and read here exactly once per turn — immediately before it is reset for the turn now opening.
    Its curve across turns is the measurement that says whether the note learned from the model's
    requests or merely traded tokens for latency.

    Args:
        turn: Ordinal of the turn that just ended.
        cycles: Retrieval tool invocations counted during it.
    """
    logger.info("retrieval cycles counted | turn=<%d> | retrieval_cycles=<%d>", turn, cycles)


def _log_referenced(names: frozenset[str]) -> None:
    """Log how many tool names the supplemental referenced source published (Requirement 17.9).

    Args:
        names: The published names.
    """
    logger.debug("supplemental referenced source published | names=<%d>", len(names))


def _log_delivery(context: InvokeModelContext, delivered: InvokeModelContext, state: _GraphState) -> None:
    """Log one debug record per delivery, plus one compaction ratio per Card at description.

    A full pass is a delivery too — the delivery that changed nothing — so it is recorded like any
    other, with ``projected`` equal to ``received`` and no final block. That is what keeps two calls'
    records comparable to each other, and to the same call without the feature.

    Guarded by the level check before anything is measured, so the estimate is never paid for by a
    caller who would not see it. The
    estimate reuses the SDK's own character heuristic rather than ``context.projected_input_tokens``,
    which the event loop computed over the full live history, before this delivery existed
    (Requirement 17.7).

    Args:
        context: The context as received. Only read.
        delivered: The context being handed down the chain, which is ``context`` itself on a full pass.
        state: The graph state, for the per-Card ratios. Only read.
    """
    if not logger.isEnabledFor(logging.DEBUG):
        return

    system_prompt = delivered.system_prompt
    logger.debug(
        "delivery produced | received=<%d> | projected=<%d> | final_blocks=<%d> | input_tokens=<%d>",
        len(context.messages),
        len(delivered.messages),
        delivered.dynamic_trailing_blocks - context.dynamic_trailing_blocks,
        _estimate_tokens_with_heuristic(
            delivered.messages,
            delivered.tool_specs,
            system_prompt if isinstance(system_prompt, str) else None,
            system_prompt if isinstance(system_prompt, list) else None,
        ),
    )
    _log_compaction_ratios(context.messages, state)


def _log_compaction_ratios(messages: Messages, state: _GraphState) -> None:
    """Log, per Card projected at description, what the Description saved over Full Content.

    Estimated Full Content tokens over estimated Description tokens, both by the same character
    heuristic — neither is what the provider will bill, but the two are comparable to each other,
    which is the whole reading (Requirement 17.10). Full Content is measured over the Card's own
    messages as the call received them, serialized, because a tool pair is structure and not prose.

    A Card whose Description came out empty is skipped rather than reported as an infinite ratio, and
    a full pass reports nothing at all: no Card is at description under it.

    Args:
        messages: The messages as received, before the removal. Only read.
        state: The graph state, for its Cards and its frozen choice. Only read.
    """
    if state.choice.full_pass:
        return

    by_identity = {identity: message for message in messages if (identity := message.get("tracking_id"))}
    for title, card in state.cards.items():
        card_choice = state.choice.by_title.get(title)
        if card_choice is None or _card_resolution(card_choice) != "description":
            continue

        description_tokens = _estimate_tokens(card.description)
        if description_tokens <= 0:
            continue

        full_tokens = sum(
            _estimate_tokens(json.dumps(message, default=str))
            for identity in (*card.dialogue_ids, *card.evidence_ids)
            if (message := by_identity.get(identity)) is not None
        )
        logger.debug(
            "card compaction ratio | title=<%s> | full_tokens=<%d> | description_tokens=<%d> | ratio=<%.2f>",
            title,
            full_tokens,
            description_tokens,
            full_tokens / description_tokens,
        )


def _validate_strategy(strategy: object) -> None:
    """Reject anything that is not exactly ``"graph"``.

    Case-sensitive on purpose: ``"Graph"`` is a typo, and silently accepting it would make the
    accepted set unknowable from the error message it never produced.

    Args:
        strategy: Value received by the constructor.

    Raises:
        ValueError: When ``strategy`` is not ``"graph"``.
    """
    if strategy != "graph":
        raise ValueError(f"strategy=<{strategy!r}> | must be 'graph'")


def _validate_ratio(value: object, parameter: str) -> None:
    """Reject anything that is not a finite real number in the closed range ``[0.0, 1.0]``.

    ``bool`` is rejected explicitly: it passes as a number in Python, and ``True`` silently meaning
    "1.0" is the kind of configuration that looks like it works. ``nan`` falls out of the range
    comparison on its own, which is why no separate check for it exists.

    The parameter is typed ``object`` so the checks run on what the caller actually passed rather
    than on what the annotation promised — a wrong type is exactly the case this exists to catch.

    Args:
        value: Value received by the constructor.
        parameter: Name of the parameter, for the message.

    Raises:
        ValueError: When ``value`` is a bool, not a real number, not finite, or out of range.
    """
    if (
        isinstance(value, bool)
        or not isinstance(value, Real)
        or not math.isfinite(float(value))
        or not 0.0 <= float(value) <= 1.0
    ):
        raise ValueError(f"{parameter}=<{value!r}> | must be a finite real number in the closed range 0.0 to 1.0")


def _validate_count(value: object, parameter: str) -> None:
    """Reject anything that is not an integer greater than or equal to ``1``.

    ``bool`` and ``float`` are both rejected: ``True`` would configure a ceiling of one, and ``2.5``
    Tags per Card is not a quantity that exists.

    Args:
        value: Value received by the constructor.
        parameter: Name of the parameter, for the message.

    Raises:
        ValueError: When ``value`` is a bool, not an ``int``, or less than ``1``.
    """
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{parameter}=<{value!r}> | must be an integer greater than or equal to 1")


def _validate_body_budget(body_budget: object) -> None:
    """Reject anything that is neither ``None`` nor an integer greater than or equal to ``1``.

    ``None`` is the absence of a Full Content ceiling, which is a supported configuration; ``0`` is
    not, as a budget of zero tokens would deny Full Content to every Card while the thresholds
    claim otherwise.

    Args:
        body_budget: Value received by the constructor.

    Raises:
        ValueError: When ``body_budget`` is neither ``None`` nor an ``int`` of at least ``1``.
    """
    if body_budget is None:
        return
    if isinstance(body_budget, bool) or not isinstance(body_budget, int) or body_budget < 1:
        raise ValueError(f"body_budget=<{body_budget!r}> | must be None or an integer greater than or equal to 1")


def _validate_reuse_ttl_cycles(value: object, *, parameter: str = "reuse_ttl_cycles") -> None:
    """Reject anything that is not an integer greater than or equal to ``0``.

    ``0`` is accepted and meaningful on both parameters that use this check: a Fed-Back Note discarded
    at the end of the turn that created it, and a selection that adds nothing beyond its recency
    window. That is why neither shares ``_validate_count``'s floor of one.

    Args:
        value: Value received by the constructor.
        parameter: Name of the parameter, for the message.

    Raises:
        ValueError: When ``value`` is a bool, not an ``int``, or negative.
    """
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{parameter}=<{value!r}> | must be an integer greater than or equal to 0")


def _validate_recent_cards(value: object) -> None:
    """Reject anything that is neither ``None`` nor an integer greater than or equal to ``0``.

    ``0`` is meaningful and is not the same as ``None``: it selects by note alone, with no recency
    window, while ``None`` turns selection off and addresses every Card.

    Args:
        value: Value received by the constructor.

    Raises:
        ValueError: When ``value`` is a bool, or is not ``None`` and not a non-negative integer.
    """
    if value is None:
        return
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"recent_cards=<{value!r}> | must be None or an integer greater than or equal to 0")


def _validate_reranker(reranker: object) -> None:
    """Reject anything that is not ``None`` and does not expose ``score`` as a callable.

    Checked by member and not by ``isinstance``, the same way ``matcher`` is, so a test double does
    not have to inherit from anything.

    Args:
        reranker: Value received by the constructor.

    Raises:
        ValueError: When ``reranker`` is not ``None`` and has no callable ``score``.
    """
    if reranker is None:
        return
    if not callable(getattr(reranker, "score", None)):
        raise ValueError(f"reranker=<{reranker!r}> | must be None or expose 'score' as a callable")


def _validate_flag(value: object, parameter: str) -> None:
    """Reject anything that is not exactly a bool.

    Args:
        value: Value received by the constructor.
        parameter: Name of the parameter, for the message.

    Raises:
        ValueError: When ``value`` is not a bool.
    """
    if not isinstance(value, bool):
        raise ValueError(f"{parameter}=<{value!r}> | must be a bool")


def _validate_matcher(matcher: object) -> None:
    """Reject anything that is neither ``None`` nor an object exposing a callable ``score``.

    Checked by member rather than by ``isinstance``: the matcher contract is structural, so any
    object carrying the operation is a valid implementation, and a double used in tests never has to
    inherit from anything.

    Args:
        matcher: Value received by the constructor.

    Raises:
        ValueError: When ``matcher`` is not ``None`` and lacks a callable ``score``.
    """
    if matcher is None:
        return
    if not callable(getattr(matcher, "score", None)):
        raise ValueError(f"matcher=<{matcher!r}> | must expose a callable 'score' member")


def _validate_name(name: object) -> None:
    """Reject anything that is neither ``None`` nor a string of length greater than zero.

    Args:
        name: Value received by the constructor.

    Raises:
        ValueError: When ``name`` is neither ``None`` nor a non-empty string.
    """
    if name is not None and (not isinstance(name, str) or not name):
        raise ValueError(f"name=<{name!r}> | must be None or a non-empty string")


class _GraphStrategy:
    """The graph strategy: one Card per turn, three Resolutions, no language model call.

    Wired at all four engagement points — the three hooks of :meth:`init_agent` and the delivery
    handler, which is the one place the set of messages sent to the provider changes. The three
    retrieval tools delegate to :mod:`.tools`.

    Not a ``Plugin``: ``ContextStrategy`` is the only plugin the agent ever sees, and this object is
    reached exclusively through it.

    Args:
        expand_threshold: Note at or above which a Card is Full Content, budget permitting.
        collapse_floor: Note below which a Card keeps only its Title.
        description_tokens: Token ceiling of a Description.
        tags_per_card: How many identifiers define a Card.
        rarity_weight: Weight of rarity against repetition when ranking textual Tags.
        body_budget: Token ceiling across Cards in Full Content, or ``None`` for no ceiling.
        min_cards: Below this many Cards the choice is skipped entirely.
        link_threshold: Similarity at or above which two Cards link.
        reuse_ttl_cycles: Model cycles a Fed-Back Note survives.
        matcher: Similarity matcher, or ``None`` for the default asymmetric multilingual embedding.
        recent_cards: How many of the most recent Cards a call always addresses, or ``None`` to
            address every Card and leave selection off.
        select_top_k: How many Cards the note adds beyond the recency window.
        reranker: Optional second stage of the selection, or ``None`` to skip it.
        persist: Whether to keep the derived graph in ``agent.state``.
    """

    def __init__(
        self,
        *,
        expand_threshold: float,
        collapse_floor: float,
        description_tokens: int,
        tags_per_card: int,
        rarity_weight: float,
        body_budget: int | None,
        min_cards: int,
        link_threshold: float,
        reuse_ttl_cycles: int,
        matcher: Any,
        recent_cards: int | None,
        select_top_k: int,
        reranker: Any,
        persist: bool,
    ) -> None:
        """Store the already-validated configuration. Nothing else is built here."""
        self._recent_cards = recent_cards
        self._select_top_k = select_top_k
        self._reranker = reranker
        self._persist = persist
        self._expand_threshold = expand_threshold
        self._collapse_floor = collapse_floor
        self._description_tokens = description_tokens
        self._tags_per_card = tags_per_card
        self._rarity_weight = rarity_weight
        self._body_budget = body_budget
        self._min_cards = min_cards
        self._link_threshold = link_threshold
        self._reuse_ttl_cycles = reuse_ttl_cycles
        self._matcher = matcher
        # The default matcher, once something has needed it. Kept apart from ``_matcher`` so that
        # ``matcher=None`` stays observable as the configuration it was, and resolved on first need
        # rather than here: construction opens no client and reaches no network (Requirement 2.16).
        self._resolved_matcher: Any = None
        # Per agent, weakly keyed: the graph is dropped along with the agent it belongs to.
        self._states: _GraphStates = weakref.WeakKeyDictionary()
        # Built once, and called from inside ``_delivery_handler`` rather than registered on the
        # stage. ``trigger="everyTurn"`` is a requirement and not a preference: the default
        # ``"userTurn"`` would only fire on the turn's first call, so the autonomous tool loop's calls
        # would go out with the removal applied and no final block (Requirement 9.6).
        self._fold = _create_injection_middleware(self._render, trigger="everyTurn")

    async def _delivery_handler(self, context: InvokeModelContext) -> InvokeModelContext:
        """Apply the removal and the compaction, as one step that either happens or does not.

        The only place the set of messages sent to the provider changes. ``agent.messages`` is never
        touched — here or anywhere else — and neither is the received context: the messages and
        ``dynamic_trailing_blocks`` travel down the chain through ``dataclasses.replace``, every other
        field carried over untouched (Requirements 1.4, 9.2, 9.3).

        One handler, not two, and one ``try`` around both steps. Requirement 16.2 does not admit the
        intermediate state where the removal was applied and the compaction failed, so any failure
        returns the **received** context by object identity, with exactly one warning carrying
        ``exc_info``. Nothing about the failure is remembered, so the next model call attempts
        delivery again (Requirement 16.3).

        A full pass, or a request that comes out empty, returns the received object itself: no new
        list, no final block, and messages identical field by field to those produced without the
        feature. One check covers both halves of Requirement 9.9, and with it Requirements 1.11 and
        2.20 — ``expand_threshold=0.0`` reaches here as a full pass.

        Args:
            context: The per-call invocation context. Read only.

        Returns:
            A new context carrying the removal and the final block, or the received context itself.
        """
        # Imported at function scope to avoid a module-level import cycle with ``removal.py``,
        # at the cost of one dictionary lookup per call.
        from .removal import apply_removal

        try:
            state = self._states.get(context.agent)
            # A state that does not exist yet is a fresh state, and a fresh state is a full pass.
            if state is None:
                return context

            # Published *before* returning, either way: ``ProgressiveToolDisclosure`` runs later in
            # this same chain — the index-zero trick is what guarantees it — and reads the source while
            # composing ``tool_specs`` for this very call (Requirement 10.9). Publishing before the
            # full-pass short circuit is what keeps the last turn's set from being read as this turn's.
            state.referenced = _derive_referenced(state, state.choice)
            _instrument(lambda: _log_referenced(state.referenced))

            if state.choice.full_pass:
                _instrument(lambda: _log_delivery(context, context, state))
                return context

            removed, requested = apply_removal(
                context.messages, state, state.choice, _current_turn_ids(context.messages)
            )
            if not requested:
                _instrument(lambda: _log_delivery(context, context, state))
                return context

            delivery = _Delivery(requested)
            token = _DELIVERY.set(delivery)
            try:
                # The primitive assembles its ``InjectionContext`` over the messages of the context it
                # receives, so handing it the removed list is what lets the compaction subtract what
                # actually left from what was asked for. No new plumbing.
                folded = await self._fold(replace(context, messages=removed))
            finally:
                _DELIVERY.reset(token)

            if delivery.error is not None:
                # Raised inside the compaction, swallowed by the primitive's fail-open, re-raised here
                # so the degradation covers the removal too.
                raise delivery.error

            _instrument(lambda: _log_delivery(context, folded, state))
            return folded
        except Exception:
            _instrument(
                lambda: logger.warning(
                    "delivery failed | passing the received context through unchanged",
                    exc_info=True,
                )
            )
            return context

    def _render(self, injection_context: InjectionContext) -> str | None:
        """Render the final block for the delivery in flight, or ``None`` when there is nothing to fold.

        ``injection_context.messages`` is the removed list, because the primitive builds its context
        after the substitution. Failures are recorded rather than raised: the primitive would fail
        open on a raise and hand the removed context down the chain, which is the split state
        Requirement 16.2 forbids.

        Args:
            injection_context: The context the fold built, over the already removed list. Read only.

        Returns:
            The text to fold, or ``None``.
        """
        delivery = _DELIVERY.get()
        if delivery is None:
            return None

        state = self._states.get(injection_context.agent)
        if state is None:
            return None

        try:
            return render_final_block(
                injection_context,
                state,
                delivery.requested,
                description_tokens=self._description_tokens,
            )
        except Exception as error:  # noqa: BLE001 - handed back to the handler, which degrades atomically.
            delivery.error = error
            return None

    def init_agent(self, agent: Agent) -> None:
        """Register the four engagement points on ``agent``: three hooks and one stage handler.

        Exactly one handler on ``InvokeModelStage.Input``, exactly one ``MessageAddedEvent`` hook,
        exactly one ``AfterToolCallEvent`` hook and exactly one ``BeforeInvocationEvent`` hook, per
        agent (Requirement 1.2). Registering the same instance on a second agent adds one of each to
        that agent and leaves the first agent's graph untouched, because every piece of state is keyed
        by the agent (Requirement 1.5).

        Nothing about the agent is reconfigured: ``system_prompt``, ``messages`` and the tool registry
        come out as they went in, the retrieval tools aside (Requirement 1.3). Nothing is written to
        message metadata, here or anywhere else in this strategy (Requirement 1.10).

        The state is created eagerly rather than on first use, so an agent that has been wired and has
        added no message presents a graph with no Card, no Link and a turn ordinal of ``0``
        (Requirement 14.11) instead of no graph at all.

        A destructive conversation manager is warned about and then wired around: the warning is a
        degradation, never a block, so the four engagement points and the three tools are registered
        exactly as they are next to a ``NullConversationManager`` (Requirements 15.1, 15.2).

        Args:
            agent: The agent to wire up.
        """
        self._warn_on_destructive_manager(agent)
        self._state_for(agent)
        agent.add_hook(self._on_message_added, MessageAddedEvent)
        agent.add_hook(self._on_after_tool_call, AfterToolCallEvent)
        agent.add_hook(self._on_before_invocation, BeforeInvocationEvent)
        self._register_delivery_middleware(agent)

    @staticmethod
    def _warn_on_destructive_manager(agent: Agent) -> None:
        """Warn once when the agent's conversation manager can physically remove messages.

        A sliding window drops the oldest prefix and a summarizer replaces spans with a summary, both
        on the live list, before the call is assembled. Either can remove a message the graph only put
        in a lower Resolution — and then raising that Card's Resolution back up recovers nothing,
        because the message the identity addressed is no longer in ``agent.messages``.

        Exactly one warning, naming the manager, and the manager itself is left entirely alone: not
        removed, not replaced, not reconfigured (Requirement 15.3).

        Args:
            agent: The agent being wired.
        """
        manager = agent.conversation_manager
        if isinstance(manager, NullConversationManager):
            return

        _instrument(
            lambda: logger.warning(
                "conversation_manager=<%s> | this manager removes or replaces messages in agent.messages, "
                "so raising a Card's Resolution may not recover the message | prefer NullConversationManager",
                type(manager).__name__,
            )
        )

    def referenced_tool_names(self, agent: Agent) -> frozenset[str]:
        """The supplemental referenced source of ``agent``, as published by the last delivery.

        The reading half of the channel, and the callable a caller hands to
        ``ProgressiveToolDisclosure(referenced_source=...)``. It reads per-agent state and nothing else:
        nothing is written to ``agent.state``, no field is added to ``InvokeModelContext``, and no
        entry of ``tool_specs`` is assembled anywhere (Requirements 10.10, 10.11).

        Args:
            agent: The agent of the call, passed in by ``ProgressiveToolDisclosure``.

        Returns:
            The published names. Empty for an agent this strategy never wired, and empty before the
            first delivery — in both cases ``referenced`` comes out as the retained history alone.
        """
        state = self._states.get(agent)
        return frozenset() if state is None else state.referenced

    def _register_delivery_middleware(self, agent: Agent) -> None:
        """Add the delivery handler as the *first* input handler of ``InvokeModelStage``.

        Input handlers run in registration order, and registration order is the order of the
        ``plugins=[...]`` list — so depending on that list would be depending on the developer
        listing this plugin first. Moving the handler to index zero resolves both required orderings
        at once, whatever the list says: the graph before ``ProgressiveToolDisclosure``, which reads
        the supplemental referenced source this handler publishes, and the graph before any transient
        memory injection of the same stage, which must not have its text folded into a message the
        removal then drops (Requirement 9.7).

        The insert-at-zero is unambiguous rather than merely first-come: the graph is the only
        strategy this class installs, so no second handler competes for index zero.

        Args:
            agent: The agent whose middleware registry to register on.
        """
        registry = agent._middleware_registry
        registry.add_middleware(InvokeModelStage.Input, self._delivery_handler)
        handlers = registry._handlers[InvokeModelStage]
        handlers.insert(0, handlers.pop())

    def _state_for(self, agent: Agent) -> _GraphState:
        """Return this agent's graph state, creating it on first use.

        Args:
            agent: The agent whose state to return.

        Returns:
            The state, weakly keyed by the agent so it is dropped along with it (Requirement 14.1).
        """
        state = self._states.get(agent)
        if state is None:
            state = _GraphState()
            self._states[agent] = state
        return state

    # ---- the reading half: one hook, on the critical path -------------------------------------

    def _on_before_invocation(self, event: BeforeInvocationEvent) -> None:
        """Compute the turn choice, freeze it, and advance the turn ordinal.

        No language model call, no disk access, and ``agent.messages`` is not touched
        (Requirement 8.10). The one remote call the graph ever makes is the similarity matcher's
        embedding round, and even that is skipped whenever the warm-up already determines the answer.

        The choice is stored once and read by every model call of the turn, the autonomous tool loop's
        included, so the context cannot shift mid-reasoning (Requirements 8.1, 8.2). It is frozen by
        type rather than by convention: ``TurnChoice.by_title`` is a ``MappingProxyType``.

        The first turn of a process comes out as a full pass whenever recovery finds nothing to load
        and nothing to scan. Recovery is the one case in which the rebuild scan runs from here rather
        than from the writing half, and it runs once per process, never per invocation
        (Requirements 8.11, 14.6, 14.7).
        """
        state = self._state_for(event.agent)
        # A state with no Card in front of a conversation that has some is a fresh process holding a
        # restored history. Restore populates ``agent.messages`` directly and fires no
        # ``MessageAddedEvent``, so the writing half has not run — and without this the choice of every
        # invocation of an ephemeral runtime would be a full pass, which is the strategy never
        # engaging at all. Done before the ordinal is advanced, so the two paths land on the same turn.
        if not state.cards:
            self._recover(event.agent, state)
        # The counter of the turn that just ended, read once and immediately before the reset below —
        # the only instant at which it is complete and not yet overwritten (Requirement 17.8).
        _instrument(lambda: _log_retrieval_cycles(state.turn, state.retrieval_cycles))
        # Aged immediately before it is read, and nowhere else. The choice is the only place the
        # fed-back note is ever summed (Requirement 13.2), and ``expire_reuse`` recomputes the decay
        # from the stored expiry rather than compounding it, so ageing at the read is the per-cycle
        # decrement of Requirement 13.3 without a fourth hook competing for the count of Requirement 1.2.
        expire_reuse(state, _cycle_of(event.agent), reuse_ttl_cycles=self._reuse_ttl_cycles)
        # Measured around the choice and around nothing else: the model call happens after this hook
        # returns and is timed by the event loop's own metrics, so the two durations are never summed
        # and the overhead of the choice stays measurable in isolation (Requirement 17.12).
        started = time.perf_counter_ns()
        state.choice = self._compute_choice(state, event)
        elapsed_ns = time.perf_counter_ns() - started
        # After the increment the ordinal names the turn now opening, which is the turn whose boundary
        # the writing half is about to see. The Card of the turn just before it does not exist yet —
        # a turn is closed by what comes after it — so that turn has no Card, and a message without a
        # Card travels at full content. Continuity is structural here, not a bonus.
        state.turn += 1
        # Per turn by definition (Requirement 17.8), so it starts each turn at zero.
        state.retrieval_cycles = 0
        # Logged after the increment, so the record names the turn the choice governs.
        _instrument(lambda: _log_choice(state, elapsed_ns))

    def _recover(self, agent: Agent, state: _GraphState) -> None:
        """Bring the graph back for a process that inherited a conversation: load it, or scan for it.

        The store first, because the scan is what it exists to avoid: measured, the scan costs ~30ms
        over an 18-turn conversation and ~2.9s over a 200-turn one, and this runs on the critical path.
        Without ``persist=True`` there is nothing to load and the scan is the only route, which is the
        behavior this method had before persistence existed.

        Failures do not propagate. A graph that could not be recovered is a graph with no Card, and a
        message without a Card travels at full content — the same degradation every other failure of
        this strategy takes (Requirements 16.4, 16.8).

        Args:
            agent: The agent whose conversation the graph is derived from.
            state: The graph state to fill. Left empty when neither route worked.
        """
        try:
            if not closed_turn_ranges(agent.messages):
                # Nothing has closed yet, so there is no graph to recover and no ordinal to set. The
                # guard is not an optimization: ``rebuild_into`` assigns ``state.turn`` from the count
                # of closed turns, so running it over an empty conversation would reset the ordinal on
                # every turn — and the ordinal is what ``_active_subject`` reads.
                return
            if self._persist and persistence.load(agent, state, **self._card_config()):
                return
            rebuild_into(state, agent.messages, **self._card_config())
        except Exception:
            _instrument(
                lambda: logger.warning(
                    "graph recovery failed | the whole conversation goes at full content", exc_info=True
                )
            )

    def _card_config(self) -> dict[str, Any]:
        """The values the graph is derived under, shared by the scan and by the fingerprint.

        One source for both, because a fingerprint computed over a different set of values than the
        derivation uses is a fingerprint that accepts a payload it should have discarded.
        ``link_threshold`` belongs here for exactly that reason: it decides which edges the scan
        creates, so a payload stored under one value and loaded under another carries a link set the
        scan would never have produced — and the guards that drop a stale Card cannot see it.
        """
        return {
            "description_tokens": self._description_tokens,
            "tags_per_card": self._tags_per_card,
            "rarity_weight": self._rarity_weight,
            "link_threshold": self._link_threshold,
        }

    def _compute_choice(self, state: _GraphState, event: BeforeInvocationEvent) -> TurnChoice:
        """Score the graph against the turn's question and hand out the body budget.

        Any failure at any step degrades to the full pass, which is the behavior without the feature,
        with exactly one warning carrying ``exc_info`` and no failure state kept — so the next turn
        computes a choice again (Requirements 16.1, 16.2, 16.3).

        Args:
            state: The graph state. Read only.
            event: The invocation event, for the question and the agent.

        Returns:
            The frozen choice of this turn.
        """
        try:
            skipped = warm_up_choice(state, expand_threshold=self._expand_threshold, min_cards=self._min_cards)
            if skipped is not None:
                # Below ``min_cards`` the only possible decision is "send it all", so no embedding is
                # paid for a decision the size of the graph already made (Requirement 7.7).
                return skipped

            question = _question_of(event.messages if event.messages is not None else event.agent.messages)
            notes = compute_notes(state, question, self._matcher_for())
            if not notes:
                # The matcher failed or answered malformed, which reads as "score nothing, send
                # everything" rather than as "nothing is relevant".
                return full_pass_choice()

            _instrument(lambda: _log_notes(notes, self._expand_threshold, self._collapse_floor))
            self._cache_vectors(state)

            selected = self._select(state, notes, question)

            return distribute(
                notes,
                state,
                expand_threshold=self._expand_threshold,
                collapse_floor=self._collapse_floor,
                body_budget=self._body_budget,
                selected=selected,
            )
        except Exception:
            _instrument(
                lambda: logger.warning(
                    "turn choice failed | the whole conversation goes at full content", exc_info=True
                )
            )
            return full_pass_choice()

    def _cache_vectors(self, state: _GraphState) -> None:
        """Fill the description vector cache the similarity link is measured from.

        The writing half cannot embed — it runs on ``MessageAddedEvent`` and must not reach the
        network — so it measures a ``similar`` edge from this cache and answers "unmeasurable" when the
        cache is empty. Nothing was filling it: ``compute_notes`` asks the matcher for *numbers*, and
        the vectors behind them stayed inside the embedder. So no ``similar`` edge was ever created,
        and ``link_threshold`` compared against a value that never arrived.

        Free where it now sits: the vectors were computed moments ago for the note, and the embedder
        caches by ``(purpose, text)``, so reading them back costs no call.

        Optional by member and not by type, the same way the matcher itself is validated: a matcher
        without ``vectors`` leaves the cache empty and the edge unmeasurable, which is exactly the
        behavior before this method existed.

        Args:
            state: The graph state. Its ``vectors`` cache is written; nothing else is touched.
        """
        source = getattr(self._matcher_for(), "vectors", None)
        if not callable(source):
            return

        titles = titles_in_turn_order(state)
        descriptions = [state.cards[title].description for title in titles]
        vectors = source(descriptions)
        if len(vectors) != len(titles):
            # Includes the empty answer embedding failure returns: leave the cache as it was.
            return

        for title, description, vector in zip(titles, descriptions, vectors, strict=True):
            # Keyed with the Description it was computed from, so a Card whose Description changed
            # measures as unmeasurable instead of measuring against a stale vector.
            state.vectors[title] = (description, tuple(vector))

    def _select(self, state: _GraphState, notes: Mapping[str, float], question: str) -> frozenset[str] | None:
        """Choose which Cards the call addresses, refining the order with the reranker when there is one.

        Two stages, and the second is optional. The recency window plus the note's pick plus one hop
        is the selection; the reranker only changes *which* Cards the note's pick contains, by
        reordering the candidates it is drawn from. Reranking the window would be spending a round
        trip on Cards that are selected either way.

        Args:
            state: The graph state. Read only.
            notes: One note per Card.
            question: The turn's question.

        Returns:
            The addressed titles, or ``None`` when selection is off — in which case every Card is
            addressed and the resolution ladder alone decides, which is the behavior before selection.
        """
        if self._recent_cards is None:
            return None

        if self._reranker is not None and self._select_top_k > 0:
            notes = self._reranked_notes(state, notes, question)

        return select(
            notes,
            state,
            recent_cards=self._recent_cards,
            select_top_k=self._select_top_k,
        )

    def _reranked_notes(self, state: _GraphState, notes: Mapping[str, float], question: str) -> Mapping[str, float]:
        """Return ``notes`` with the top candidates renumbered in the reranker's order.

        The reranker is handed the candidates the note already ranked highest, and its answer is
        written back as notes above every other Card's, in its order. Renumbering rather than
        replacing keeps one ordering in the system: ``select`` and ``distribute`` keep reading notes,
        and neither has to learn that a second scorer exists.

        A failure inside :func:`~.ranking.rerank` is a skipped step — it returns the order it was
        given — so this method has no failure path of its own to write.

        Args:
            state: The graph state. Read only.
            notes: One note per Card.
            question: The turn's question.

        Returns:
            A new mapping, or ``notes`` itself when there was nothing worth reranking.
        """
        # Only reached with selection on, where the caller has already ruled out None.
        recent_cards = self._recent_cards or 0
        window = titles_in_turn_order(state)[len(titles_in_turn_order(state)) - recent_cards :]
        candidates = [title for title in _titles_by_descending_note(state, notes) if title not in set(window)]
        # Twice the pick, so the reranker has something to reorder rather than only something to
        # confirm, and the cost stays one call over a bounded list.
        candidates = candidates[: self._select_top_k * 2]
        if len(candidates) < 2:
            return notes

        ordered = rerank(question, candidates, [state.cards[title].description for title in candidates], self._reranker)
        if tuple(ordered) == tuple(candidates):
            return notes

        highest = max(notes.values(), default=0.0)
        renumbered = dict(notes)
        for position, title in enumerate(ordered):
            # Above every other Card, and descending in the reranker's order. The step is what keeps
            # the reranked candidates from interleaving with the ones it never saw.
            renumbered[title] = highest + len(ordered) - position
        return renumbered

    def _matcher_for(self) -> Any:
        """Return the similarity matcher, building the default one on first need.

        Resolved here and never at construction: constructing a ``ContextStrategy`` opens no client
        and reaches no network (Requirement 2.16), so the default matcher cannot be built there. The
        resolved object is kept apart from the supplied one, so ``matcher=None`` stays observable as
        the configuration it was.

        Returns:
            The supplied matcher, or the default asymmetric multilingual embedding matcher.
        """
        if self._matcher is not None:
            return self._matcher

        if self._resolved_matcher is None:
            from .matcher import EmbeddingSimilarityMatcher

            # Its boto client is built lazily too, so this construction is still free of I/O.
            self._resolved_matcher = EmbeddingSimilarityMatcher()

        return self._resolved_matcher

    # ---- the writing half: two hooks, off the critical path -----------------------------------

    def _on_message_added(self, event: MessageAddedEvent) -> None:
        """Close the Card of the turn that just ended, or rebuild the whole graph by scan.

        The writing half, and the only place the rebuild scan may run: it is linear over the whole
        conversation and re-tags every Card, which is free in I/O and in model calls but not
        instantaneous, and ``BeforeInvocationEvent`` is on the critical path of the model call
        (Requirement 14.6).

        A state with no Card and a conversation with at least one closed turn is the restore case, and
        one scan derives the whole graph from the messages (Requirement 14.5). It is also the first
        closed boundary of a fresh agent, where the scan and the incremental step derive the same
        single Card — which is what keeps the turn ordinals of the two paths aligned from there on.

        The turn ordinal comes from the count of closed boundaries rather than from ``state.turn``, so
        the Card of a turn is the same Card whether it was derived turn by turn or by one scan
        (Requirement 14.3, and Property 15).

        Failures do not propagate: the turn keeps no Card, and a message without a Card travels at
        full content (Requirements 16.4, 16.5, 16.8).
        """
        agent = event.agent
        state = self._state_for(agent)
        messages = agent.messages

        try:
            closed = closed_turn_ranges(messages)
            if not closed:
                # Nothing has closed yet: no Card to derive, and nothing to rebuild from.
                return

            if not state.cards:
                self._recover(agent, state)
                self._persist_state(agent, state)
                return

            if not is_turn_boundary(event.message):
                # Mid-turn: nothing closed, so nothing to derive.
                return

            start, stop = closed[-1]
            turn_ids = _identities_in(messages[start:stop])
            if not turn_ids:
                # A turn whose messages all lack a durable identity: messages without a Card.
                return

            derive_and_register(
                state,
                messages,
                turn_ids,
                len(closed) - 1,
                description_tokens=self._description_tokens,
                tags_per_card=self._tags_per_card,
                rarity_weight=self._rarity_weight,
                link_threshold=self._link_threshold,
            )
            self._persist_state(agent, state)
        except Exception:
            _instrument(
                lambda: logger.warning("closing the turn's card failed | the turn's messages go whole", exc_info=True)
            )

    def _persist_state(self, agent: Agent, state: _GraphState) -> None:
        """Hand the graph to the agent's session, when the instance was asked to persist it.

        On the writing half only. The session sync this feeds already runs on ``MessageAddedEvent``,
        so this changes what a write that was going to happen carries, rather than adding one.

        Args:
            agent: The agent whose session carries the payload.
            state: The graph state to store. Read only.
        """
        if self._persist:
            persistence.save(agent, state, **self._card_config())

    def _on_after_tool_call(self, event: AfterToolCallEvent) -> None:
        """Register the artifact Cards of a tool result whose content the offloader stored.

        The fast path, not the only one: the rebuild scan reads the same references off the preview
        text, which is what makes the order of this hook against the offloader's irrelevant. A result
        that names no reference registers nothing and logs nothing — it is the ordinary shape of a
        result no offloader replaced (Requirement 15.5).

        Failures do not propagate, and the graph simply keeps no artifact Card
        (Requirements 16.4, 16.8).
        """
        agent = event.agent
        state = self._state_for(agent)

        try:
            # Widened to ``object`` on purpose: the event annotates the field as a ``ToolResult``, so
            # the guard below reads as unreachable against the annotation while being exactly what a
            # failed tool call needs at runtime.
            raw: object = event.result
            if not isinstance(raw, dict):
                # A failed tool call carries an exception where a result would be: nothing to address.
                return

            derive_and_register_artifacts(
                state,
                agent.messages,
                cast("ToolResult", raw),
                str(event.tool_use.get("name") or ""),
                state.turn,
                description_tokens=self._description_tokens,
                tags_per_card=self._tags_per_card,
                rarity_weight=self._rarity_weight,
            )
        except Exception:
            _instrument(lambda: logger.warning("artifact card derivation failed | the graph keeps none", exc_info=True))

    # ---- the three retrieval tools: bodies in ``tools.py``, configuration and state here ------

    async def expand_card(self, title: str, tool_context: ToolContext) -> str:
        """Raise Resolution of the Subject Card titled ``title`` to Full Content for this turn.

        Args:
            title: Title of the Card the model asked for.
            tool_context: The framework's tool context, for the agent of the call.

        Returns:
            Confirmation, or an error naming the Title asked for.
        """
        agent = tool_context.agent
        return tools.expand_card(
            self._state_for(agent),
            title,
            cycle=_cycle_of(agent),
            reuse_ttl_cycles=self._reuse_ttl_cycles,
        )

    async def expand_artifact(
        self,
        reference: str,
        tool_context: ToolContext,
        line_range: dict[str, int] | None = None,
        pattern: str | None = None,
    ) -> str:
        """Read the artifact behind ``reference`` from the offloader's storage.

        Args:
            reference: The artifact reference.
            tool_context: The framework's tool context, for the agent of the call.
            line_range: ``{"start": int, "end": int}``, or ``None`` for the whole artifact.
            pattern: Keep only matching lines, or ``None``.

        Returns:
            The requested part, or an error naming what was missing.
        """
        agent = tool_context.agent
        return await tools.expand_artifact(
            self._state_for(agent),
            agent,
            reference,
            line_range,
            pattern,
            cycle=_cycle_of(agent),
            reuse_ttl_cycles=self._reuse_ttl_cycles,
        )

    async def find_context(self, need: str, tool_context: ToolContext, tag: str | None = None) -> str:
        """Score the Cards' Descriptions against ``need`` over the existing vector index.

        Args:
            need: What the model is looking for, in its own words.
            tool_context: The framework's tool context, for the agent of the call.
            tag: Restrict candidates to Cards carrying this Tag, normalized.

        Returns:
            Up to five candidates, or an empty result naming the ``need`` received.
        """
        agent = tool_context.agent
        return tools.find_context(
            self._state_for(agent),
            need,
            tag,
            matcher=self._matcher_for(),
            collapse_floor=self._collapse_floor,
            cycle=_cycle_of(agent),
            reuse_ttl_cycles=self._reuse_ttl_cycles,
        )


class ContextStrategy(Plugin):
    """The single Context Strategy of an agent. Exactly one, by construction.

    The graph derives a Card per turn by scan and decides a Resolution per Card. It is chosen at
    construction via ``strategy="graph"`` and never revisited, so there is one slot and a second
    strategy on the same agent is *inexpressible* rather than merely detectable.

    Args:
        strategy: ``"graph"``, case-sensitive.
        expand_threshold: Note at or above which a Card is Full Content, budget permitting. Defaults
            to ``0.55``.
        collapse_floor: Note below which a Card keeps only its Title. Defaults to ``0.45``.
        description_tokens: Token ceiling of a Description. Defaults to ``100``.
        tags_per_card: How many identifiers define a Card. Defaults to ``5``.
        rarity_weight: Weight of rarity against repetition when ranking textual Tags. Defaults to
            ``0.70``.
        body_budget: Token ceiling across Cards in Full Content, or ``None`` for no ceiling.
            Defaults to ``None``.
        min_cards: Below this many Cards the choice is skipped entirely. Defaults to ``3``.
        link_threshold: Similarity at or above which two Cards link. Defaults to ``0.50``.
        reuse_ttl_cycles: Model cycles a Fed-Back Note survives. Defaults to ``5``.
        matcher: Similarity matcher, or ``None`` for the default asymmetric multilingual embedding.
            Checked by member, so an implementation need not inherit from anything.
            Resolved on first need rather than at construction, so ``matcher=None`` stays observable
            as the configuration it was and construction opens no client.
        recent_cards: How many of the most recent Cards a call always addresses, or ``None`` to
            address every Card and leave selection off. Defaults to ``None``. ``0`` is
            not the same as ``None``: it selects by note alone, with no recency window.
        select_top_k: How many Cards the note adds beyond the recency window. Read only when
            selection is on. Defaults to ``5``.
        reranker: Optional second stage of the selection, reordering the candidates the embedding
            already ranked, or ``None`` to skip it. Defaults to ``None``. Checked by
            member, like ``matcher``. About ten times the latency of the embedding path, so it is
            worth the round trip only once selection decides *which* Cards a call addresses. A
            failure is a skipped step, never a failed call.
        persist: Whether to keep the derived graph in ``agent.state``, which every session manager
            already persists. Defaults to ``False``. Avoids the rebuild scan — ~30ms
            over 18 turns, ~2.9s over 200 — at the cost of a second copy of the Descriptions, which
            carry literal numeric lines, in the store.
        name: Plugin name, for logging and duplicate detection. Defaults to
            ``"strands:context-strategy"``.

    Raises:
        ValueError: On any invalid argument, naming the parameter and what it accepts.

    Example:
        ```python
        from strands import Agent
        from strands.agent.conversation_manager import NullConversationManager
        from strands.vended_plugins.context_graph import ContextStrategy

        agent = Agent(
            conversation_manager=NullConversationManager(),
            plugins=[ContextStrategy(strategy="graph")],
        )
        ```
    """

    name = _DEFAULT_NAME

    def __init__(
        self,
        *,
        strategy: Literal["graph"] = "graph",
        expand_threshold: float = _DEFAULT_EXPAND_THRESHOLD,
        collapse_floor: float = _DEFAULT_COLLAPSE_FLOOR,
        description_tokens: int = _DEFAULT_DESCRIPTION_TOKENS,
        tags_per_card: int = _DEFAULT_TAGS_PER_CARD,
        rarity_weight: float = _DEFAULT_RARITY_WEIGHT,
        body_budget: int | None = _DEFAULT_BODY_BUDGET,
        min_cards: int = _DEFAULT_MIN_CARDS,
        link_threshold: float = _DEFAULT_LINK_THRESHOLD,
        reuse_ttl_cycles: int = _DEFAULT_REUSE_TTL_CYCLES,
        matcher: Any = None,
        recent_cards: int | None = _DEFAULT_RECENT_CARDS,
        select_top_k: int = _DEFAULT_SELECT_TOP_K,
        reranker: Any = None,
        persist: bool = False,
        name: str | None = None,
    ) -> None:
        """Validate the configuration and fix it for the lifetime of the instance.

        ``strategy`` is validated first, because it decides that the graph surface is in play.

        Nothing is built here beyond plain attributes: no network call, no model client, no AWS
        client, no async task (Requirement 2.16).
        """
        _validate_strategy(strategy)
        _validate_name(name)

        _validate_ratio(expand_threshold, "expand_threshold")
        _validate_ratio(collapse_floor, "collapse_floor")
        _validate_ratio(link_threshold, "link_threshold")
        _validate_ratio(rarity_weight, "rarity_weight")
        # Checked after both are known to be ratios: a floor above the ceiling leaves the middle
        # resolution unreachable, so the ladder would have two steps while the configuration says three.
        if float(collapse_floor) > float(expand_threshold):
            raise ValueError(
                f"collapse_floor=<{collapse_floor!r}> | must be less than or equal to "
                f"expand_threshold=<{expand_threshold!r}>"
            )
        _validate_count(description_tokens, "description_tokens")
        _validate_count(tags_per_card, "tags_per_card")
        _validate_count(min_cards, "min_cards")
        _validate_body_budget(body_budget)
        _validate_reuse_ttl_cycles(reuse_ttl_cycles)
        _validate_matcher(matcher)
        _validate_recent_cards(recent_cards)
        _validate_reuse_ttl_cycles(select_top_k, parameter="select_top_k")
        _validate_reranker(reranker)
        _validate_flag(persist, "persist")

        self.name = name or _DEFAULT_NAME
        # Fixed here and never revisited: every turn of this instance uses these values unchanged
        # (Requirement 2.18).
        # ``float`` on the ratios is normalization, not ceremony: ``_validate_ratio`` admits any
        # ``Real``, so an ``int`` or a ``Fraction`` reaches here and the rest of the package expects a
        # float. The counts and the flag arrive already pinned to their type by their validators.
        self._expand_threshold = float(expand_threshold)
        self._collapse_floor = float(collapse_floor)
        self._description_tokens = description_tokens
        self._tags_per_card = tags_per_card
        self._rarity_weight = float(rarity_weight)
        self._body_budget = body_budget
        self._min_cards = min_cards
        self._link_threshold = float(link_threshold)
        self._reuse_ttl_cycles = reuse_ttl_cycles
        self._matcher = matcher
        self._recent_cards = recent_cards
        self._select_top_k = select_top_k
        self._reranker = reranker
        self._persist = persist

        # Always empty: the strategy registers what it needs in ``init_agent`` via ``agent.add_hook``,
        # which is what makes the per-agent handler count verifiable by inspection rather than by
        # trust in discovery.
        self._hooks: list[Any] = []

        # One strategy object, chosen here and never revisited. This is where Requirement 1.1 stops
        # being a rule to enforce and becomes a shape: there is one slot, so a second strategy on the
        # same agent is inexpressible rather than detectable.
        self._impl: _GraphStrategy = self._build_strategy()
        super().__init__()

    def _build_strategy(self) -> _GraphStrategy:
        """Construct the graph strategy object this instance delegates to.

        Returns:
            The ``_GraphStrategy`` configured from this instance's validated parameters.
        """
        return _GraphStrategy(
            recent_cards=self._recent_cards,
            select_top_k=self._select_top_k,
            reranker=self._reranker,
            persist=self._persist,
            expand_threshold=self._expand_threshold,
            collapse_floor=self._collapse_floor,
            description_tokens=self._description_tokens,
            tags_per_card=self._tags_per_card,
            rarity_weight=self._rarity_weight,
            body_budget=self._body_budget,
            min_cards=self._min_cards,
            link_threshold=self._link_threshold,
            reuse_ttl_cycles=self._reuse_ttl_cycles,
            matcher=self._matcher,
        )

    def init_agent(self, agent: Agent) -> None:
        """Delegate wiring to the graph strategy chosen at construction.

        Args:
            agent: The agent to wire up.
        """
        self._impl.init_agent(agent)

    def referenced_tool_names(self, agent: Agent) -> frozenset[str]:
        """Tool names this call still mentions, for ``ProgressiveToolDisclosure(referenced_source=...)``.

        Hand this bound method over as the supplemental referenced source. It receives the agent of the
        call, so one instance serves as many agents as it is wired to, and it only ever reads: the
        decision of which names carry a full specification and which carry a pre-specification stays
        with ``ProgressiveToolDisclosure`` (Requirements 10.6, 12.15).

        Args:
            agent: The agent of the call.

        Returns:
            The names of the tools mentioned by Cards above title. Empty when there is nothing to add.
        """
        return self._graph.referenced_tool_names(agent)

    @property
    def _graph(self) -> _GraphStrategy:
        """The graph strategy this instance delegates to."""
        return self._impl

    @tool(context=True)
    async def expand_card(self, title: str, tool_context: ToolContext) -> str:
        """Bring back the full content of an earlier turn, by its title.

        Earlier turns may reach you as a title and a short description instead of their messages. When
        a description is not enough to answer, call this with the title exactly as it was shown and
        that turn arrives in full for the rest of this turn.

        Args:
            title: The title of the turn you want back, copied as it was shown to you.
            tool_context: Injected by the framework. Not user-facing.

        Returns:
            Confirmation that the turn will arrive in full, or an error naming the title asked for.
        """
        return await self._graph.expand_card(title, tool_context)

    @tool(context=True)
    async def expand_artifact(
        self,
        reference: str,
        tool_context: ToolContext,
        line_range: dict[str, int] | None = None,
        pattern: str | None = None,
    ) -> str:
        """Read a stored artifact by its reference, whole or in part.

        Prefer a line range or a pattern: without either, the whole artifact comes back and costs its
        full token count again.

        Args:
            reference: The artifact reference, copied as it was shown to you.
            tool_context: Injected by the framework. Not user-facing.
            line_range: ``{"start": int, "end": int}`` to read only those lines.
            pattern: Return only the lines matching this pattern.

        Returns:
            The requested part of the artifact, or an error naming what was missing.
        """
        return await self._graph.expand_artifact(reference, tool_context, line_range, pattern)

    @tool(context=True)
    async def find_context(self, need: str, tool_context: ToolContext, tag: str | None = None) -> str:
        """Find earlier turns of this conversation that match what you need, described in your words.

        Use this when you suspect the conversation already covered something but you cannot see it in
        what reached you. Describe the need, not a title.

        Args:
            need: What you are looking for, in your own words.
            tool_context: Injected by the framework. Not user-facing.
            tag: Restrict the search to turns carrying this tag.

        Returns:
            Up to five candidate turns with their title, tags and description, or an empty result
            naming the need received.
        """
        return await self._graph.find_context(need, tool_context, tag)

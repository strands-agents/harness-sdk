"""The three retrieval tools: what makes a wrong automatic choice cost a cycle instead of an answer.

The graph decides a Resolution per Card from a note, and the note is a guess. A wrong guess leaves the model not with a
worse answer but with a Title, an explicit invitation to ask. These three are what the invitation leads to:

- ``expand_card`` asks by Title, reads the graph, and raises both axes for the rest of the turn.
- ``expand_artifact`` asks by reference, reads the offloader's ``Storage``, and raises nothing: the content comes back
  inline.
- ``find_context`` asks by Description in the model's own words, reads the same vector index the turn choice scores
  against, and raises nothing.

Five properties are shared by all three. Nothing here calls a language model or touches ``agent.messages``: none has a
handle on the model, none holds a mutable reference to the history (Requirement 12.13). Every failure is a return value,
never an exception — an unknown Title, an unknown reference, non-textual content and a missing ``ContextOffloader`` all
come back as prose naming what was missing (Requirements 12.3, 12.6, 12.7, 15.6, 16.8), because a raise would report the
*tool* broken rather than the *request*. Success records the fed-back note and an error records nothing, by not calling
:func:`~.scoring.record_reuse` on the error paths rather than by a branch inside it (Requirement 13.8); the elevation
``expand_card`` performs lasts the rest of the turn, while the fed-back note carries the request into the turn *after*
it (Requirement 12.14). The retrieval cycle counter is incremented on invocation, not on success (Requirement 17.8): a
cycle spent on a request that came back empty was still spent. And no index is built here — ``find_context`` scores
through the matcher the turn choice uses (Requirement 12.10), whose vectors come from the per-process cache keyed by
``(purpose, text)``, so an unchanged Description costs nothing on this path.
"""

from __future__ import annotations

import logging
from types import MappingProxyType
from typing import TYPE_CHECKING, Any

from .describe import normalize
from .scoring import record_reuse, titles_in_turn_order
from .state import CardChoice, TurnChoice, _GraphState

if TYPE_CHECKING:
    from ...agent.agent import Agent
    from .matcher import SimilarityMatcher

__all__ = ["expand_artifact", "expand_card", "find_context"]

logger = logging.getLogger(__name__)

_MAX_CANDIDATES = 5
"""Candidates ``find_context`` returns at most (Requirement 12.11). Capped rather than "as many as clear the floor": a
search that answers with the whole graph has re-injected the very thing the graph collapsed."""

_CONTEXT_LINES = 5
"""Lines around each pattern match, the default ``retrieve_offloaded_content`` already applies."""

_CHARS_PER_TOKEN = 4
"""Characters per token, the same coarse estimate ``describe.py`` and the offloader use. Only ever used to *report* a
cost back to the model, never to decide what is returned."""


# ---- expand_card ------------------------------------------------------------------------------


def expand_card(
    state: _GraphState,
    title: str,
    *,
    cycle: int,
    reuse_ttl_cycles: int,
) -> str:
    """Raise the Subject Card titled ``title`` to Full Content for the remainder of the turn.

    Both axes, dialogue *and* evidence (Requirement 12.2). The elevation rewrites the frozen choice rather than adding a
    field to the state, so it ends with the turn: the next ``BeforeInvocationEvent`` recomputes the choice from the
    graph, and the fed-back note carries the request across that boundary (Requirement 12.14). A full pass is left as
    is, since every Card is already at Full Content and a ``by_title`` entry would flip ``full_pass`` to false and cost
    the delivery its identity short circuit.

    Args:
        state: Graph state of the agent. ``choice``, ``reuse`` and ``retrieval_cycles`` are mutated; ``cards`` and
            ``links`` read only.
        title: Title of the Card the model asked for, as it was shown to it.
        cycle: Current cycle counter, ``agent.event_loop_metrics.cycle_count``.
        reuse_ttl_cycles: Cycles the fed-back note survives.

    Returns:
        Confirmation that the turn will arrive whole, or an error naming the Title asked for, in which case no
        Resolution changed and no fed-back note was recorded (Requirement 12.3).
    """
    state.retrieval_cycles += 1

    card = state.cards.get(title)
    if card is None or card.kind != "subject":
        return (
            f"expand_card | no earlier turn of this conversation is titled '{title}' | "
            "copy a title exactly as it was shown to you, or use find_context to describe what you need"
        )

    if not state.choice.full_pass:
        state.choice = TurnChoice(
            by_title=MappingProxyType({**state.choice.by_title, title: CardChoice(dialogue="full", evidence="full")}),
            full_pass=False,
        )

    record_reuse(state, title, cycle, reuse_ttl_cycles=reuse_ttl_cycles)

    return (
        f"expand_card | '{title}' arrives in full for the rest of this turn, its messages and its tool results together"
    )


# ---- expand_artifact --------------------------------------------------------------------------


async def expand_artifact(
    state: _GraphState,
    agent: Agent,
    reference: str,
    line_range: dict[str, int] | None = None,
    pattern: str | None = None,
    *,
    cycle: int,
    reuse_ttl_cycles: int,
) -> str:
    """Read the artifact behind ``reference``, whole or in part, from the offloader's storage.

    The read is delegated and never reimplemented: ``ContextOffloader``'s ``Storage`` carries the path-traversal and
    bucket-prefix guards, so the graph passes the reference along and opens no file, resolves no path and builds no URI.

    No Resolution changes on any path, success included (Requirement 11.8). The content asked for is in this answer, and
    what crosses into the next turn is the fed-back note on the artifact's Card.

    Args:
        state: Graph state of the agent. Its ``reuse`` and ``retrieval_cycles`` are mutated.
        agent: The agent of the call, for its offloader and its storage.
        reference: The artifact reference, as it was shown to the model.
        line_range: ``{"start": int, "end": int}``, 1-indexed and inclusive, or ``None``.
        pattern: Regex or keyword to keep only matching lines, or ``None``.
        cycle: Current cycle counter, ``agent.event_loop_metrics.cycle_count``.
        reuse_ttl_cycles: Cycles the fed-back note survives.

    Returns:
        The requested part of the artifact, or an error naming what was missing — a missing ``ContextOffloader``, an
        unknown reference, non-textual content, or a line range outside the content — with nothing recorded and no
        Resolution changed (Requirements 12.6, 12.7, 15.6).
    """
    state.retrieval_cycles += 1

    # Imported at call time, so a graph running without an offloader does not pay for importing one.
    from ..context_offloader.search import _is_searchable_content, _search_content

    offloader = _offloader_of(agent)
    if offloader is None:
        return (
            f"expand_artifact | no artifact storage is registered on this agent, so reference "
            f"'{reference}' cannot be read | ContextOffloader is absent, which means no tool result was "
            "ever offloaded and the full results are already in the conversation"
        )

    read = await _retrieve(offloader, agent, reference)
    if read is None:
        return (
            f"expand_artifact | unknown reference '{reference}' | copy a reference exactly as it was "
            "shown to you in a turn's title or preview"
        )
    content_bytes, content_type = read

    if not _is_searchable_content(content_type):
        return (
            f"expand_artifact | reference '{reference}' holds non-textual content of content_type "
            f"'{content_type}' | line_range and pattern do not apply to it, and it cannot be returned as "
            "text | use retrieve_offloaded_content to receive it in its native format"
        )

    text = content_bytes.decode("utf-8", errors="replace")
    max_chars = _max_chars_of(offloader)

    if line_range is None and pattern is None:
        answer = _whole_artifact(reference, text)
    else:
        span = _span_of(line_range)
        if line_range is not None and span is None:
            return (
                f"expand_artifact | line_range=<{line_range!r}> is not a pair of integers | pass "
                '{"start": <int>, "end": <int>}, 1-indexed and inclusive'
            )
        try:
            answer = _search_content(
                text,
                pattern=pattern,
                line_range=span,
                context_lines=_CONTEXT_LINES,
                max_chars=max_chars,
            )
        except ValueError as error:
            return f"expand_artifact | reference '{reference}' | {error}"

    title = _artifact_title(state, reference)
    if title is not None:
        record_reuse(state, title, cycle, reuse_ttl_cycles=reuse_ttl_cycles)

    return answer


def _whole_artifact(reference: str, text: str) -> str:
    """The whole artifact, with the cost of having asked for it whole stated in the answer.

    The notice is part of the contract (Requirement 12.5): without it the cheapest request to write is also the most
    expensive to serve, and the model has no way to know.

    Args:
        reference: The reference read.
        text: The artifact's whole text.

    Returns:
        The notice followed by the content.
    """
    tokens = max(1, len(text) // _CHARS_PER_TOKEN)
    notice = (
        f"expand_artifact | whole artifact '{reference}' | this call re-injects the artifact's entire "
        f"token count, about {tokens} tokens, and it stays in the conversation for the rest of the turn | "
        "next time pass line_range or pattern to read only the part you need"
    )
    return f"{notice}\n\n{text}"


def _offloader_of(agent: Agent) -> Any | None:
    """The ``ContextOffloader`` registered on ``agent``, or ``None`` when there is none.

    Found by type over the agent's plugin registry rather than held as a constructor argument, so the graph works next
    to an offloader it was not told about, including the one ``Agent`` appends under ``context_manager="auto"`` (Req.
    15.5).

    Args:
        agent: The agent of the call. Read only.

    Returns:
        The offloader, or ``None`` when it is absent or the registry cannot be read at all.
    """
    from ..context_offloader import ContextOffloader

    registry = getattr(agent, "_plugin_registry", None)
    plugins = getattr(registry, "_plugins", None)
    if not isinstance(plugins, dict):
        return None

    for plugin in plugins.values():
        if isinstance(plugin, ContextOffloader):
            return plugin
    return None


async def _retrieve(offloader: Any, agent: Agent, reference: str) -> tuple[bytes, str] | None:
    """Read ``reference`` through the offloader's storage, or answer ``None``.

    Every failure collapses onto ``None`` — an unknown reference, uninitialized storage, an unreachable backend —
    because from the model's side they are one situation: the reference did not resolve. The distinction stays in the
    debug log.

    Args:
        offloader: The agent's ``ContextOffloader``.
        agent: The agent of the call, for storage bound to its sandbox.
        reference: The reference to read.

    Returns:
        The content and its content type, or ``None``.
    """
    from ..context_offloader.plugin import _retrieve_content

    try:
        storage = offloader._storage_for_agent(agent)
        return await _retrieve_content(storage, reference)
    except Exception:
        logger.debug(
            "artifact reference=<%s> did not resolve | answering with an error message", reference, exc_info=True
        )
        return None


def _max_chars_of(offloader: Any) -> int:
    """Output ceiling of a targeted read, in characters, taken from the offloader's own budget.

    Reusing ``max_result_tokens`` keeps a retrieval from re-offloading itself: the offloader replaces a result larger
    than that budget, so an answer built to the same ceiling is left alone.

    Args:
        offloader: The agent's ``ContextOffloader``.

    Returns:
        The ceiling, at least one character.
    """
    tokens = getattr(offloader, "_max_result_tokens", None)
    if not isinstance(tokens, int) or isinstance(tokens, bool) or tokens < 1:
        return 10_000
    return tokens * _CHARS_PER_TOKEN


def _span_of(line_range: dict[str, int] | None) -> tuple[int, int] | None:
    """The line range as the pair ``_search_content`` reads, or ``None`` when it is unusable.

    Args:
        line_range: The mapping the model supplied, or ``None``.

    Returns:
        ``(start, end)``, or ``None`` for an absent or malformed range. The caller tells the two apart, since it already
        knows whether a range was supplied.
    """
    if line_range is None:
        return None
    try:
        return (int(line_range["start"]), int(line_range["end"]))
    except (KeyError, TypeError, ValueError, IndexError):
        return None


def _artifact_title(state: _GraphState, reference: str) -> str | None:
    """Title of the artifact Card addressing ``reference``, or ``None`` when the graph holds none.

    A reference the graph never carded is still a reference storage can read — the ``AfterToolCallEvent`` fast path may
    have missed it, or the rebuild scan may not have run — so the read succeeds with no Card for the note to land on.

    Args:
        state: The graph state. Read only.
        reference: The reference that was read.

    Returns:
        The title, or ``None``.
    """
    for title in titles_in_turn_order(state):
        card = state.cards[title]
        if card.kind == "artifact" and card.reference == reference:
            return title
    return None


# ---- find_context -----------------------------------------------------------------------------


def find_context(
    state: _GraphState,
    need: str,
    tag: str | None = None,
    *,
    matcher: SimilarityMatcher,
    collapse_floor: float,
    cycle: int,
    reuse_ttl_cycles: int,
) -> str:
    """Score every candidate Card's Description against ``need`` and answer with the best five.

    Scored over the index the turn choice already uses and no other: one ``score`` call against the matcher the strategy
    resolved, whose vectors come from the per-process cache keyed by ``(purpose, text)``. No index is built here (Req.
    12.10). ``collapse_floor`` is the bar rather than ``expand_threshold``, being the note below which the graph decided
    a Card was not worth a Description, so a candidate clearing it is one the graph did not dismiss.

    Args:
        state: Graph state of the agent. ``reuse`` and ``retrieval_cycles`` are mutated; ``cards`` read only.
        need: What the model is looking for, in its own words.
        tag: Restrict candidates to Cards carrying this Tag, compared in normalized form (Requirement 12.9). ``None``
            leaves every Card a candidate.
        matcher: The similarity matcher the turn choice uses.
        collapse_floor: Similarity below which a candidate is not returned at all.
        cycle: Current cycle counter, ``agent.event_loop_metrics.cycle_count``.
        reuse_ttl_cycles: Cycles the fed-back note survives.

    Returns:
        At most five candidates with their Title, Tags and Description, or an empty result naming the ``need`` received,
        in which case no fed-back note was recorded and no Resolution changed (Requirement 12.12).
    """
    state.retrieval_cycles += 1

    titles = titles_in_turn_order(state)
    if tag is not None:
        wanted = normalize(tag)
        titles = tuple(title for title in titles if wanted and wanted in state.cards[title].tags)

    similarities = _similarities(state, titles, need, matcher)
    if similarities is None:
        return _nothing_found(need, tag)

    passing = [title for title in titles if similarities[title] >= collapse_floor]
    passing.sort(key=lambda title: (-similarities[title], state.cards[title].turn, title))
    chosen = passing[:_MAX_CANDIDATES]

    if not chosen:
        return _nothing_found(need, tag)

    for title in chosen:
        record_reuse(state, title, cycle, reuse_ttl_cycles=reuse_ttl_cycles)

    return _render_candidates(state, need, chosen)


def _similarities(
    state: _GraphState,
    titles: tuple[str, ...],
    need: str,
    matcher: SimilarityMatcher,
) -> dict[str, float] | None:
    """One similarity per candidate, or ``None`` when the matcher was unusable.

    Same failure rule as :func:`~.scoring._score`: the matcher is contractually non-raising, so anything it does raise
    reads here as "no candidate", never as an exception the model must interpret.

    Args:
        state: The graph state. Read only.
        titles: Candidate titles, already in fixed turn order.
        need: The text to score against.
        matcher: The similarity matcher. Invoked at most once.

    Returns:
        Title to similarity, or ``None``.
    """
    if not titles:
        return None

    descriptions = tuple(state.cards[title].description for title in titles)
    try:
        scores = matcher.score(need, descriptions)
        if len(scores) != len(descriptions):
            # Covers the empty answer too: with at least one candidate, empty is a length mismatch.
            raise ValueError(f"similarity count=<{len(scores)}> | expected=<{len(descriptions)}>")
        return {title: float(scores[index]) for index, title in enumerate(titles)}
    except Exception:
        logger.debug("find_context similarity unavailable for %d candidate(s)", len(descriptions), exc_info=True)
        return None


def _nothing_found(need: str, tag: str | None) -> str:
    """The empty result, naming the ``need`` received and the Tag it was narrowed by.

    Naming both lets the model tell "nothing in this conversation is about that" from "nothing carrying that tag is
    about that", and only the second has an obvious next move.

    Args:
        need: The need as received.
        tag: The tag as received, or ``None``.

    Returns:
        The message.
    """
    narrowed = f", among the turns tagged '{tag}'" if tag is not None else ""
    return (
        f"find_context | nothing in this conversation matches '{need}'{narrowed} | "
        "the titles already in front of you are the whole conversation, so what you need was "
        "either never discussed or is in a turn you can name directly with expand_card"
    )


def _render_candidates(state: _GraphState, need: str, chosen: list[str]) -> str:
    """Render the chosen candidates: Title, Tags and Description each (Requirement 12.11).

    The Description is rendered in full rather than trimmed, being already bounded by ``description_tokens`` at
    derivation.

    Args:
        state: The graph state. Read only.
        need: The need as received, quoted back so the answer stands on its own.
        chosen: Titles to render, already ordered and already capped.

    Returns:
        The rendered answer.
    """
    lines = [f"find_context | {len(chosen)} earlier turn(s) match '{need}', best first:"]
    for title in chosen:
        card = state.cards[title]
        lines.append(f"- title: {title}")
        if card.tags:
            lines.append(f"  tags: {', '.join(card.tags)}")
        for fragment in card.description.splitlines():
            if fragment.strip():
                lines.append(f"  {fragment}")
    lines.append("call expand_card with one of these titles to bring that turn back in full")
    return "\n".join(lines)

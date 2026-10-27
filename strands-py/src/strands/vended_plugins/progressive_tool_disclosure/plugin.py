"""Progressive tool disclosure: the projection sent on each model call.

This module holds the description budget used by catalog entries. A catalog entry names a tool the
model has not asked for yet, so its description has to be short enough that listing every unexposed
tool stays cheap, and faithful enough that the model can tell whether the capability is the one it
needs. Faithful here means literal: the short description is a prefix of the registered one, cut at a
boundary, never a rewrite.

Token counts are estimated from character counts rather than measured. ``Model.count_tokens`` is
async and operates over ``Messages``, not over a bare string, which makes it the wrong tool for
budgeting dozens of descriptions inside a single projection. The four-characters-per-token heuristic
is the same one ``ContextOffloader`` uses for preview slicing, and the correctness properties assert
against this same estimator, so the budget contract is verifiable end to end.
"""

from __future__ import annotations

import inspect
import json
import logging
import math
import weakref
from collections.abc import Callable, Container, Iterable, KeysView, Sequence
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, TypeAlias

from ..._middleware.stages import InvokeModelStage
from ...hooks.events import BeforeToolCallEvent
from ...plugins import Plugin, hook
from ...tools.decorator import tool
from ...types.content import Messages
from ...types.tools import ToolContext, ToolSpec
from .index import LexicalToolIndex, ToolIndex, ToolMatch

if TYPE_CHECKING:
    from ..._middleware.stages import InvokeModelContext
    from ...agent.agent import Agent

logger = logging.getLogger(__name__)

FIND_TOOLS_NAME = "find_tools"
"""Name of the search tool. Also the name the projection looks for to decide it can project at all."""

_DEFAULT_CATALOG_TOKENS = 20
"""Description budget per catalog entry. Cuts the resident cost by ~96% at a low risk."""

_DEFAULT_TTL_CYCLES = 5
"""Cycles an exposure survives after its last use."""

_DEFAULT_TOP_K = 3
"""How many tools one search exposes."""

_MATCHES_HEADER = "Full parameters for these tools are available on your next call:"
"""Opens the search result. What the model has to know is that the schema is one turn away."""

_EMPTY_NEED_GUIDANCE = "Describe what you are trying to do, in your own words, then call this tool again."
"""Answer to an empty need. Guidance rather than an error: the model can recover on its own turn."""

_NO_MATCH_GUIDANCE = "No tool matches that description. Try different wording, or answer directly."
"""Answer when nothing usable was found. Names the two ways out so the model does not retry blindly."""

_SEARCH_FAILED_GUIDANCE = "Tool search is unavailable right now. Try a different description, or answer directly."
"""Answer when the search itself raised. Worded as guidance rather than as an error, and offering the
same two ways out as a no-match: from where the model stands the two cases are the same one, and the
failure is the plugin's to log, not the model's to reason about."""

_PREMATURE_CALL_MESSAGE = "Parameters for '{name}' were not loaded. They are available now - call it again."
"""Cancellation message of a premature call. Names the tool, says why it did not run, and asks for the
same call again: the schema is exposed by the time the model reads this, so a retry is what fixes it."""

_CHARS_PER_TOKEN = 4
"""Approximate characters per token — same heuristic ContextOffloader uses for preview slicing."""

_ELLIPSIS = "..."
"""Marks a description as cut. Counts against the budget like any other character."""

_SENTENCE_ENDINGS = ".!?"
"""Characters that end a sentence when followed by whitespace or by the end of the text."""

ReferencedSource: TypeAlias = "Callable[[Agent], Iterable[str]]"
"""Supplemental Referenced Source: receives the agent of the call and returns tool names.

It receives the agent because one plugin instance serves many agents, and the supplemental set is
per agent. Without that argument the source would have to keep global state, which is exactly what
this channel exists to avoid."""


def _estimate_tokens(text: str) -> int:
    """Estimate the token count of ``text`` from its character count.

    Rounds up, matching ``_heuristic_estimate_text`` in ``models/model.py``: a non-empty text never
    estimates as zero tokens.

    Args:
        text: Text to estimate.

    Returns:
        Estimated token count.
    """
    return math.ceil(len(text) / _CHARS_PER_TOKEN)


def _catalog_entry(spec: ToolSpec, catalog_tokens: int) -> ToolSpec:
    """Build the catalog entry of ``spec``: verbatim name, short description, empty input schema.

    The name is copied character by character because it is the key the model calls the tool by:
    truncating or normalizing it would produce a spec that cannot be called. The description is the
    only field that pays for the budget, and ``inputSchema`` is emptied rather than dropped because
    providers reject a spec without it. ``outputSchema`` and ``annotations`` are omitted: annotations
    never reach the provider, and the output shape only matters once the tool is about to be called,
    at which point the full specification is what gets projected.

    Args:
        spec: Full specification as registered in the ``ToolRegistry``. Left unmodified.
        catalog_tokens: Catalog budget in tokens. Must be at least ``1``.

    Returns:
        A new ``ToolSpec`` carrying only ``name``, ``description`` and an empty, closed
        ``inputSchema``.
    """
    return {
        "name": spec["name"],
        "description": _truncate_description(spec["description"], catalog_tokens),
        # A fresh schema per entry: a shared dict would let one consumer's mutation reach every entry.
        "inputSchema": {"json": {"type": "object", "properties": {}, "additionalProperties": False}},
    }


def _requires_parameters(spec: ToolSpec) -> bool:
    """Report whether ``spec`` declares at least one required parameter.

    Only the ``required`` list decides. A tool whose parameters are all optional is callable with no
    arguments, so an empty call to it is a legitimate call and not the symptom of a missing schema.

    Args:
        spec: Full specification as registered in the ``ToolRegistry``. Left unmodified — only read.

    Returns:
        ``True`` when the schema lists at least one required parameter; ``False`` when it lists none,
        and for any schema shape this cannot read.
    """
    # Typed as object so the runtime guard against malformed data is not read as unreachable:
    # ToolSpec declares inputSchema as a dict, but this reads specs that may arrive malformed.
    input_schema: object = spec.get("inputSchema")
    if not isinstance(input_schema, dict):
        return False

    # inputSchema arrives wrapped as {"json": {...}}; tolerate an unwrapped schema as well.
    root = input_schema.get("json", input_schema)
    if not isinstance(root, dict):
        return False

    required = root.get("required")
    return isinstance(required, list) and len(required) > 0


def _truncate_description(text: str, catalog_tokens: int) -> str:
    """Cut ``text`` to at most ``catalog_tokens`` tokens, preferring a sentence/word boundary.

    The cut is attempted at the last sentence boundary that fits the budget, then at the last word
    boundary, and only by character count when no word boundary fits — the case of a single token
    longer than the whole budget, where any boundary-based cut would return nothing.

    A cut at a sentence boundary reads as a whole and carries no ellipse; a cut mid-sentence gets
    one, and the ellipse counts against the budget like any other character.

    Args:
        text: Description as registered in the ``ToolRegistry``.
        catalog_tokens: Catalog budget in tokens. Must be at least ``1``.

    Returns:
        A prefix of ``text``, possibly followed by an ellipse, whose estimated token count is at most
        ``catalog_tokens``. Returns ``text`` unchanged when it already fits, which covers the empty
        description.
    """
    max_chars = catalog_tokens * _CHARS_PER_TOKEN
    if len(text) <= max_chars:
        return text

    # A sentence boundary needs no ellipse to read as a whole, so it gets the full budget.
    cut = _last_sentence_end(text, max_chars)
    if cut > 0:
        return text[:cut]

    budget = max_chars - len(_ELLIPSIS)
    if budget > 0:
        cut = _last_word_end(text, budget)
        if cut > 0:
            return text[:cut].rstrip() + _ELLIPSIS

    # No sentence and no word boundary fits the budget; cut by character count at the limit.
    return text[:max_chars]


def _last_sentence_end(text: str, budget: int) -> int:
    """Find the end of the last sentence of ``text`` that fits ``budget`` characters.

    A sentence ends at a terminator followed by whitespace or by the end of ``text``, so that a
    period inside ``v1.2`` or ``e.g.`` is not mistaken for one.

    Args:
        text: Text to scan.
        budget: Maximum number of characters the result may span.

    Returns:
        Number of characters to keep, terminator included, or ``-1`` when no sentence ends within
        the budget.
    """
    for i in range(min(budget, len(text)) - 1, -1, -1):
        if text[i] in _SENTENCE_ENDINGS and (i + 1 >= len(text) or text[i + 1].isspace()):
            return i + 1
    return -1


def _last_word_end(text: str, budget: int) -> int:
    """Find the end of the last whole word of ``text`` that fits ``budget`` characters.

    Args:
        text: Text to scan.
        budget: Maximum number of characters the result may span.

    Returns:
        Number of characters to keep, trailing whitespace excluded from the word itself, or ``-1``
        when no word ends within the budget.
    """
    # A word may end exactly at the budget: the character just past it decides, not the budget.
    for i in range(min(budget, len(text) - 1), -1, -1):
        if text[i].isspace():
            return i
    return -1


def _validate_positive_int(value: object, parameter: str) -> None:
    """Reject anything that is not an integer greater than or equal to ``1``.

    ``bool`` is rejected explicitly: it passes as an integer in Python, and ``ttl_cycles=True``
    silently meaning "one cycle" is the kind of configuration that looks like it works. A float is
    rejected as well, including ``5.0``: the value is counted in cycles and compared to a cycle
    counter, so a non-integer has no meaning here.

    The parameter is typed ``object`` so the checks run on what the caller actually passed rather
    than on what the annotation promised — a wrong type is exactly the case this exists to catch.

    Args:
        value: Value received by the constructor.
        parameter: Name of the parameter, for the message.

    Raises:
        ValueError: When ``value`` is not an ``int`` of at least ``1``.
    """
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{parameter}=<{value!r}> | must be an integer greater than or equal to 1")


def _validate_catalog_tokens(catalog_tokens: object) -> None:
    """Reject anything that is neither ``None`` nor an integer greater than or equal to ``1``.

    ``None`` suppresses the catalog altogether, which is a supported configuration; ``0`` is not, as
    a budget of zero tokens would emit catalog entries nothing fits in.

    Args:
        catalog_tokens: Value received by the constructor.

    Raises:
        ValueError: When ``catalog_tokens`` is neither ``None`` nor an ``int`` of at least ``1``.
    """
    if catalog_tokens is None:
        return
    if isinstance(catalog_tokens, bool) or not isinstance(catalog_tokens, int) or catalog_tokens < 1:
        raise ValueError(f"catalog_tokens=<{catalog_tokens!r}> | must be None or an integer greater than or equal to 1")


def _validate_always_available(always_available: object) -> None:
    """Reject anything that is not a sequence of non-empty strings.

    A bare string is rejected even though it is a sequence of strings: ``always_available="current_time"``
    would silently configure one name per character, so the mistake is caught rather than honored.

    Args:
        always_available: Value received by the constructor.

    Raises:
        ValueError: When ``always_available`` is not a sequence, is a string, or holds anything other
            than strings of length greater than zero.
    """
    if isinstance(always_available, (str, bytes)) or not isinstance(always_available, Sequence):
        raise ValueError(f"always_available=<{always_available!r}> | must be a list or tuple of non-empty strings")
    for name in always_available:
        if not isinstance(name, str) or not name:
            raise ValueError(
                f"always_available=<{always_available!r}> | must be a list or tuple of non-empty "
                f"strings, got the element <{name!r}>"
            )


def _validate_index(index: object) -> None:
    """Reject anything that is neither ``None`` nor an object exposing ``build`` and ``search``.

    The protocol is checked by member rather than by ``isinstance``: :class:`ToolIndex` is a
    structural protocol, so any object carrying both operations is a valid implementation, and a
    duplicate used in tests never has to inherit from anything.

    Args:
        index: Value received by the constructor.

    Raises:
        ValueError: When ``index`` is not ``None`` and lacks a callable ``build`` or ``search``.
    """
    if index is None:
        return
    for member in ("build", "search"):
        if not callable(getattr(index, member, None)):
            raise ValueError(f"index=<{index!r}> | must expose a callable '{member}' member")


def _validate_referenced_source(referenced_source: object) -> None:
    """Reject anything that is neither ``None`` nor callable.

    ``None`` means there is no supplemental source, which is the default and the configuration that
    reproduces the behaviour of every call before this channel existed.

    Args:
        referenced_source: Value received by the constructor.

    Raises:
        ValueError: When ``referenced_source`` is not ``None`` and is not callable.
    """
    if referenced_source is None or callable(referenced_source):
        return
    raise ValueError(f"referenced_source=<{referenced_source!r}> | must be None or a callable taking the agent")


@dataclass
class _DisclosureState:
    """Per-agent disclosure state: which tools are exposed, and against which registry.

    Exposure is a per-call decision, not a durable fact, so this state never reaches ``agent.state``
    or any session storage. Losing it on a process restart costs one search, and the worst case is
    today's behavior without the plugin.

    The two counters live here for the same reason the exposures do: what they measure is a session,
    and a session is an agent. They are what tells whether the disclosure pays off on a given load —
    a high search count for the same need argues for preloading, and a high cancellation count argues
    the catalog descriptions are not informative enough.

    Attributes:
        exposed: Tool name to the cycle count of its last use. A fresh state has zero exposures.
        fingerprint: Registry tool names as of the last index build, or ``None`` when the index has
            not been built yet — the value that makes the first projection build it.
        searches: Cycles this session spent searching: one per search tool invocation.
        premature_cancellations: Calls this session cancelled for a schema that was not loaded.
    """

    exposed: dict[str, int] = field(default_factory=dict)
    fingerprint: frozenset[str] | None = None
    searches: int = 0
    premature_cancellations: int = 0


_DisclosureStates: TypeAlias = "weakref.WeakKeyDictionary[Agent, _DisclosureState]"
"""Per-agent state map. Weak keys so one plugin instance can serve many agents without keeping any
of them alive: the state is dropped along with the agent it belongs to."""


def _new_disclosure_states() -> _DisclosureStates:
    """Build an empty per-agent state map, to be held by the plugin instance.

    Returns:
        An empty ``WeakKeyDictionary`` keyed by agent.
    """
    return weakref.WeakKeyDictionary()


def _state_for(states: _DisclosureStates, agent: Agent) -> _DisclosureState:
    """Return ``agent``'s disclosure state, creating it on first access.

    Each agent gets its own state object, so creating or updating one agent's state leaves every
    other agent served by the same plugin instance untouched.

    Args:
        states: Per-agent state map held by the plugin instance.
        agent: Agent whose state is wanted.

    Returns:
        The state associated with ``agent``: an existing one, or a fresh state with zero exposures
        and no fingerprint.
    """
    state = states.get(agent)
    if state is None:
        state = _DisclosureState()
        states[agent] = state
    return state


def _expire(state: _DisclosureState, cycle: int, ttl_cycles: int) -> None:
    """Drop from ``state`` every exposure idle for more than ``ttl_cycles`` cycles.

    Age is measured exclusively against the cycle counter: no wall-clock time, no message count, no
    tool-call count. That keeps the TTL tied to the agent's own progress, so a slow provider call or
    a burst of messages inside one cycle never ages an exposure.

    An exposure at exactly ``cycle - last_used == ttl_cycles`` is kept — the boundary belongs to the
    live side, so a tool used ``ttl_cycles`` cycles ago still projects its full specification.

    Only the exposure map is touched. The ``ToolRegistry`` and ``agent.tool_names`` are left alone:
    expiring an exposure withdraws a schema from the next projection, it does not unregister a tool.

    Args:
        state: Disclosure state of the agent. Mutated in place.
        cycle: Current cycle counter, ``agent.event_loop_metrics.cycle_count``.
        ttl_cycles: Cycles an exposure survives after its last use. At least ``1``.
    """
    # Materialize the names first: the map is mutated while the decision is applied.
    for name in [n for n, last_used in state.exposed.items() if cycle - last_used > ttl_cycles]:
        del state.exposed[name]


def _renew(state: _DisclosureState, name: str, cycle: int) -> None:
    """Record ``cycle`` as ``name``'s last use, exposing it if it was not exposed yet.

    Renewal and first exposure are the same write: a tool used again this cycle and a tool just
    matched by search both end up with the current cycle as their last use. That is what keeps a
    repeatedly used tool's schema resident without a second search.

    Args:
        state: Disclosure state of the agent. Mutated in place.
        name: Tool name to expose or renew.
        cycle: Current cycle counter, ``agent.event_loop_metrics.cycle_count``.
    """
    state.exposed[name] = cycle


def _instrument(emit: Callable[[], None]) -> None:
    """Run one instrumentation step, swallowing whatever it raises.

    Observability is not part of the contract of any operation here: a projection, a search or a
    pre-call decision has to come out the same whether its log went out or not. So every counter
    update and every log call goes through this, and the operation around it never learns that one
    failed.

    The failure is swallowed rather than logged. A logger that raises is precisely the case this
    exists to cover, so reaching for it in the handler would reintroduce what was just guarded.

    Args:
        emit: The instrumentation step: a counter update, a log call, or both.
    """
    try:
        emit()
    except Exception:
        # Deliberately silent: see above.
        pass


def _log_projection(specs: Sequence[ToolSpec]) -> None:
    """Log the size of a projection, in specifications and in estimated tokens.

    The token count is estimated over the serialized projection, which is the closest stand-in for
    what the provider is actually charged for, using the same four-characters-per-token heuristic the
    catalog budget uses. Two calls' counts are therefore comparable to each other, and to the count
    of the same call without the plugin.

    Args:
        specs: The projected specifications.
    """
    logger.debug(
        "projection produced | specs=<%d> | estimated_tokens=<%d>",
        len(specs),
        _estimate_tokens(json.dumps(specs, default=str)),
    )


def _record_search(state: _DisclosureState) -> None:
    """Count one cycle spent searching, and log the session total.

    Args:
        state: Disclosure state of the agent. Its search counter is the only field written.
    """
    state.searches += 1
    logger.info("tool search invoked | searches_this_session=<%d>", state.searches)


def _log_search_outcome(need: str, exposed: Sequence[str]) -> None:
    """Log the need a search received and the names it exposed.

    Need and outcome go out together on purpose: repeated invocations for the same need are what
    tells a search that answered from one that sent the model back to reword, and that reading is
    only available when both sides of the invocation sit in one record.

    Args:
        need: The need as received, including the blank need of an unattempted search.
        exposed: Names exposed by this invocation, empty when nothing was.
    """
    logger.info("tool search outcome | need=<%s> | exposed=<%s>", need, ", ".join(exposed))


def _record_premature_cancellation(state: _DisclosureState, name: str) -> None:
    """Count one call cancelled for a schema that was not loaded, and log the tool.

    Args:
        state: Disclosure state of the agent. Its cancellation counter is the only field written.
        name: Name of the cancelled tool.
    """
    state.premature_cancellations += 1
    logger.info(
        "premature tool call cancelled | tool=<%s> | cancellations_this_session=<%d>",
        name,
        state.premature_cancellations,
    )


def _tool_names_referenced_in(messages: Messages) -> KeysView[str]:
    """Collect the tool names of every ``toolUse`` block in ``messages``.

    A ``toolUse`` left in the retained history without its definition in the projection is a protocol
    error: the provider sees a call to a tool it was never told about. So whatever the exposure state
    says, a tool the history still talks about keeps its full specification in the projection, and
    this scan is what finds those names.

    The result is an ordered set: names come out in the order they are first seen, which keeps the
    projection reproducible across repeated calls over the same history, and membership stays O(1)
    for the caller that tests every incoming spec against it.

    Args:
        messages: Retained history, ``context.messages``. Left unmodified — the scan only reads.

    Returns:
        A view over the referenced tool names, in first-appearance order, without duplicates.
    """
    referenced: dict[str, None] = {}
    for message in messages:
        for block in message.get("content") or ():
            tool_use = block.get("toolUse")
            # Malformed blocks are skipped rather than raised on: an unnamed toolUse cannot be
            # matched against an incoming spec anyway, and the projection must not fail over one.
            if tool_use and (name := tool_use.get("name")):
                referenced[name] = None
    return referenced.keys()


def _should_passthrough(
    incoming_names: Iterable[str],
    registry_names: Container[str],
    find_tools_name: str = FIND_TOOLS_NAME,
) -> bool:
    """Decide whether the incoming call must be left exactly as it arrived.

    Two cases, both structural — neither reads a mode flag off the context:

    - A name arrives that the registry does not have. Forced structured output swaps ``tool_specs``
      for a synthetic spec that was never registered, and projecting over it would break the mode.
      Any name outside the registry is treated the same way: the projection has no full specification
      to emit for it, and dropping it would strand the caller.
    - The search tool is not in the call. ``init_agent`` returns before the ``_PluginRegistry``
      registers the vended tool, so the first calls can legitimately arrive without it. Without the
      search tool in the projection the model has no way back to a hidden schema, so there is nothing
      to hide.

    Args:
        incoming_names: Tool names received in ``context.tool_specs``, in arrival order.
        registry_names: Names registered in the agent's ``ToolRegistry``. Membership is all that is
            asked of it.
        find_tools_name: Name of the search tool. Defaults to :data:`FIND_TOOLS_NAME`.

    Returns:
        ``True`` when the caller must return the invocation context unchanged, by object identity;
        ``False`` when the projection applies.
    """
    found_find_tools = False
    for name in incoming_names:
        if name not in registry_names:
            return True
        if name == find_tools_name:
            found_find_tools = True

    return not found_find_tools


def _compose_projection(
    incoming: Sequence[ToolSpec],
    exposed: Container[str],
    referenced: Container[str],
    always_available: Container[str],
    catalog_tokens: int | None,
    find_tools_name: str = FIND_TOOLS_NAME,
) -> list[ToolSpec]:
    """Build the projection as the union of five blocks, each name appearing at most once.

    The blocks are visited in a fixed order — the search tool, ``always_available``, the live
    exposures, the names the retained history still references, and the catalog entries of whatever
    is left. Order matters twice over. It decides which form of a tool wins: a name emitted by any
    of the first four blocks carries its full specification, so reaching the catalog block it is
    already seen and never re-emitted as a reduced entry. And it puts the search tool first, which
    is what makes the projection non-empty on every projected path.

    Inside a block, iteration follows ``incoming`` rather than the block's own container. Two calls
    with the same disclosure state, the same history and the same configuration then produce the
    same list in the same order, which is what keeps the provider's prompt cache from being
    invalidated by a reordering that changes no content.

    Args:
        incoming: Specifications received in ``context.tool_specs``, in arrival order. This order is
            the order of every block, and these specifications are what gets emitted — nothing is
            read from the registry here. Left unmodified.
        exposed: Names with a live exposure. Membership is all that is asked of it, so the caller's
            exposure map can be passed directly once expiration has been applied.
        referenced: Names of the ``toolUse`` blocks in the retained history.
        always_available: Names configured to carry their full specification on every call.
        catalog_tokens: Catalog budget in tokens, or ``None`` to omit every catalog entry while
            keeping the other four blocks.
        find_tools_name: Name of the search tool. Defaults to :data:`FIND_TOOLS_NAME`.

    Returns:
        The projected specifications. Every name is a name of ``incoming``, appears once, and a name
        that reached any of the first four blocks appears as its full specification. A name
        configured in ``always_available`` but absent from ``incoming`` is simply omitted.
    """
    projected: list[ToolSpec] = []
    seen: set[str] = set()

    # The first four blocks emit full specifications; only their membership test differs.
    for block in ({find_tools_name}, always_available, exposed, referenced):
        for spec in incoming:
            name = spec["name"]
            if name in block and name not in seen:
                seen.add(name)
                projected.append(spec)

    if catalog_tokens is not None:
        for spec in incoming:
            name = spec["name"]
            if name not in seen:
                seen.add(name)
                projected.append(_catalog_entry(spec, catalog_tokens))

    return projected


def _union_referenced(
    referenced: Container[str],
    source: ReferencedSource | None,
    agent: Agent,
) -> Container[str]:
    """Union the retained history's names with the Supplemental Referenced Source's, keeping order.

    ``source is None`` returns ``referenced`` by the same object. That is what makes ``tool_specs``
    come out field for field identical to what was produced before this channel existed: the
    regression guarantee is by identity, not by comparison.

    A failure of the source degrades to the retained history alone. The ``try`` covers the call and
    the materialization and nothing more — the union itself is outside it, so a half-built set never
    survives a failure. That is the same delimitation :meth:`ProgressiveToolDisclosure.find_tools`
    already practices by keeping its exposure loop out of the guard.

    Args:
        referenced: Names of the ``toolUse`` blocks in the retained history.
        source: Supplemental source, or ``None`` when there is none.
        agent: Agent of the call, passed on to the source.

    Returns:
        ``referenced`` itself when there is no source or the source failed; otherwise a view over the
        union, history names first, in first-appearance order and without duplicates.
    """
    if source is None:
        return referenced

    try:
        supplemental: list[str] = []
        for name in source(agent):
            # A non-string name cannot be matched against a specification name, and honoring the rest
            # of a malformed return would hide the defect. Raised so the guard below reports it once.
            if not isinstance(name, str):
                raise TypeError(f"referenced_source returned the non-string element <{name!r}>")
            if name:
                supplemental.append(name)
    except Exception:
        # A non-iterable return lands here too: the iteration is what raises on it.
        logger.debug("referenced_source failed | composing referenced from the retained history only", exc_info=True)
        return referenced

    merged: dict[str, None] = dict.fromkeys(referenced) if isinstance(referenced, Iterable) else {}
    merged.update(dict.fromkeys(supplemental))
    return merged.keys()


def _project(
    context: InvokeModelContext,
    exposed: Container[str],
    referenced: Container[str],
    always_available: Container[str],
    catalog_tokens: int | None,
    find_tools_name: str = FIND_TOOLS_NAME,
    referenced_source: ReferencedSource | None = None,
) -> InvokeModelContext:
    """Return ``context`` with ``tool_specs`` replaced by the composed projection.

    A new context object rather than a mutation of the received one: ``tool_specs`` is the single
    field this plugin has any say over, and ``replace`` makes that explicit. The retained history,
    the ``ToolRegistry`` and every other field are carried over untouched — the projection changes
    what a call is told about, not what the agent has.

    Args:
        context: Invocation context received by the ``InvokeModelStage.Input`` handler.
        exposed: Names with a live exposure, after expiration has been applied.
        referenced: Names of the ``toolUse`` blocks in ``context.messages``.
        always_available: Names configured to carry their full specification on every call.
        catalog_tokens: Catalog budget in tokens, or ``None`` to omit every catalog entry.
        find_tools_name: Name of the search tool. Defaults to :data:`FIND_TOOLS_NAME`.
        referenced_source: Supplemental Referenced Source, or ``None``. The union happens here rather
            than in the caller because this is already the boundary between what the history says and
            what the projection emits, and ``_compose_projection`` stays unaware the source exists.

    Returns:
        A new invocation context whose ``tool_specs`` is the projection.
    """
    projected = _compose_projection(
        context.tool_specs,
        exposed,
        _union_referenced(referenced, referenced_source, context.agent),
        always_available,
        catalog_tokens,
        find_tools_name,
    )
    return replace(context, tool_specs=projected)


class ProgressiveToolDisclosure(Plugin):
    """Send a lean catalog plus a search tool on each model call, instead of every full schema.

    Every registered tool stays in the ``ToolRegistry`` and stays callable. What changes is the
    projection: a call carries the search tool, the tools configured as always available, the tools
    whose schema is currently exposed, the tools the retained history still references, and a catalog
    entry — name and a short description — for everything else. The model describes what it needs,
    the search tool exposes the matching tools, and their full ``inputSchema`` arrives on the next
    call. An exposure expires by inactivity, measured in event loop cycles and renewed on each use.

    Nothing is added to the system prompt: the usage instruction lives in the search tool's own
    description, which already travels in ``tool_specs``.

    No failure here leaves the agent without tool specifications. A search that raises, or one that
    ranks a tool that does not do what was asked, returns guidance instead of an exception, and the
    search tool is in the next projection like in every other one: the model rewords and searches
    again, at the cost of one cycle. A failure on the projection path degrades to the specifications
    received, which is today's behaviour without the plugin.

    Example:
        ```python
        from strands import Agent
        from strands.vended_plugins.progressive_tool_disclosure import ProgressiveToolDisclosure

        agent = Agent(tools=[...], plugins=[ProgressiveToolDisclosure()])
        ```
    """

    name = "strands:progressive-tool-disclosure"

    def __init__(
        self,
        *,
        catalog_tokens: int | None = _DEFAULT_CATALOG_TOKENS,
        ttl_cycles: int = _DEFAULT_TTL_CYCLES,
        always_available: Sequence[str] = (),
        index: ToolIndex | None = None,
        top_k: int = _DEFAULT_TOP_K,
        referenced_source: ReferencedSource | None = None,
    ) -> None:
        """Fix the configuration of the instance. Nothing is indexed and no call goes out here.

        Args:
            catalog_tokens: Description budget of a catalog entry, in tokens, or ``None`` to drop the
                catalog entirely and leave the search tool's description as the only hint, in the
                projection, that other tools exist at all. That is the cheapest configuration and the
                one with the least to go on: with no name to recognize, the model may well answer from
                what it knows instead of searching.
            ttl_cycles: Cycles an exposure survives after its last use.
            always_available: Names that carry their full specification on every call, skipping the
                discovery cycle.
            index: Search implementation. Defaults to :class:`LexicalToolIndex`, which needs no
                network.
            top_k: How many tools one search exposes.
            referenced_source: Callable receiving the agent of the call and returning tool names that
                are to carry their full specification on this call, on top of the ones the retained
                history references. An extra input to a calculation this plugin keeps ownership of:
                the decision of which names get a full specification and which get a catalog entry
                stays here. ``None`` composes the referenced names from the retained history alone.

        Raises:
            ValueError: When any parameter is outside its accepted values. Every check runs before
                any state is set up, so a construction that fails leaves no handler, hook or tool
                registered on any agent.
        """
        _validate_catalog_tokens(catalog_tokens)
        _validate_positive_int(ttl_cycles, "ttl_cycles")
        _validate_positive_int(top_k, "top_k")
        _validate_always_available(always_available)
        _validate_index(index)
        _validate_referenced_source(referenced_source)

        self._catalog_tokens = catalog_tokens
        self._ttl_cycles = ttl_cycles
        # A tuple, so the sequence the caller keeps cannot change the configuration after the fact.
        self._always_available = tuple(always_available)
        self._top_k = top_k
        # The index is only instantiated here, never built: building reads the specifications of a
        # call, which the first projection is what has.
        self._index: ToolIndex = LexicalToolIndex() if index is None else index
        self._referenced_source = referenced_source
        self._states = _new_disclosure_states()
        super().__init__()

    def init_agent(self, agent: Agent) -> None:
        """Register the projection handler on the agent's ``InvokeModelStage`` input phase.

        One handler per agent, and nothing else: ``Plugin`` auto-registers ``@hook`` and ``@tool``
        members, but not middleware, so this is the whole hook-up. The system prompt, the retained
        history and the ``ToolRegistry`` come out of here untouched — the usage instruction the model
        needs lives in :meth:`find_tools`' own description, which already travels in ``tool_specs``.

        A single instance may be registered on several agents. The handler is the same bound method
        on each, but the disclosure state it reads is keyed by the agent of the call, so exposures
        never cross over.

        The search tool and the pre-call hook are registered by the ``_PluginRegistry`` *after* this
        returns, so the handler cannot assume the search tool is in the registry on its first calls —
        :func:`_should_passthrough` is what covers that window.

        Args:
            agent: Agent being initialized.
        """
        agent._middleware_registry.add_middleware(InvokeModelStage.Input, self._projection_handler)

    async def _projection_handler(self, context: InvokeModelContext) -> InvokeModelContext:
        """Rewrite ``context.tool_specs`` as the projection for this one call.

        The only place ``tool_specs`` is ever rewritten. No hook, no tool and no other stage touches
        it, so what the model is told about a call is decided here or nowhere.

        Any failure on this path degrades to the context received, unchanged: the call goes out with
        the full ``tool_specs``, which is exactly today's behaviour without the plugin. The whole path
        sits under one ``except``, so a failing projection emits one warning and not one per step —
        whether it came from ``build``, from expiration, from the history scan, from a catalog entry or
        from the union itself. Nothing escapes to the stage, and no failure state is kept: the very
        next model call attempts the projection again. A failed ``build`` in particular leaves the
        fingerprint unwritten, so the next call rebuilds rather than searching a half-built index.

        Args:
            context: Invocation context received from the stage. Only ``tool_specs`` is replaced, and
                by way of a new context object rather than a mutation.

        Returns:
            A new context carrying the projection, or ``context`` itself when the projection does not
            apply or fails.
        """
        try:
            agent = context.agent
            registry = agent.tool_registry.registry

            if _should_passthrough((spec["name"] for spec in context.tool_specs), registry):
                return context

            state = _state_for(self._states, agent)
            _expire(state, agent.event_loop_metrics.cycle_count, self._ttl_cycles)

            await self._ensure_index(state, context.tool_specs)

            referenced = _tool_names_referenced_in(context.messages)

            projected = _project(
                context,
                state.exposed,
                referenced,
                self._always_available,
                self._catalog_tokens,
                referenced_source=self._referenced_source,
            )
            _instrument(lambda: _log_projection(projected.tool_specs))
            return projected
        except Exception:
            logger.warning("projection failed | passing the received context through unchanged", exc_info=True)
            return context

    async def _ensure_index(self, state: _DisclosureState, specs: Sequence[ToolSpec]) -> None:
        """Build the index when the incoming tool names differ from the ones it was built from.

        The index cannot be built at construction time: what it indexes are the specifications of a
        call, and the first projection is what has them. It also cannot be built once and forgotten —
        MCP tools and ``register_dynamic_tool`` can arrive at runtime — so the set of incoming names
        is kept as a fingerprint and compared on every projection. A tool registered late is indexed
        on the first projection it shows up in, which is the projection that makes it findable.

        A ``frozenset`` of the names is enough: what the index holds is one entry per specification,
        so a registry that gained or lost a name is a registry the index no longer covers, and the
        order names arrive in has no say over what gets indexed.

        The fingerprint is written after the build returns. A build that raises leaves it as it was,
        so the next projection tries again rather than searching over a half-built index.

        Args:
            state: Disclosure state of the agent. Its fingerprint is the only field written.
            specs: Specifications received in ``context.tool_specs``. Passed on to ``build`` as a
                copy, so the list the projection reads is not the list the index holds.
        """
        fingerprint = frozenset(spec["name"] for spec in specs)
        if state.fingerprint == fingerprint:
            return

        # The index may be a network-backed implementation, so build is allowed to be awaitable.
        built = self._index.build(list(specs))
        if inspect.isawaitable(built):
            await built

        state.fingerprint = fingerprint

    @tool(context=True)
    async def find_tools(self, need: str, tool_context: ToolContext) -> str:
        """Find the tools that can do what you need.

        Most tools are listed to you by name and a one-line description only, without their
        parameters. Call this tool with a description of what you are trying to do, in your own
        words, and the tools that match it will arrive with their full parameters on your next turn.
        Then call the one you want.

        Args:
            need: What you are trying to do, described in your own words. A capability, not a tool
                name — "list the transactions of an investment account" works better than a guess at
                what the tool might be called.
            tool_context: Injected by the framework. Not user-facing.

        Returns:
            The matching tool names with a short description of each, or guidance to describe the
            need or to reword it when there is nothing to list.
        """
        agent = tool_context.agent
        state = _state_for(self._states, agent)
        cycle = agent.event_loop_metrics.cycle_count

        # The counter measures cycles spent searching, so every invocation counts: a blank need and a
        # failed search each cost the cycle just the same as one that answered.
        _instrument(lambda: _record_search(state))

        # A blank need cannot rank anything, so the search is not attempted at all: asking the model
        # to say what it wants is cheaper than a top_k of noise it would then have to discard.
        if not need.strip():
            _instrument(lambda: _log_search_outcome(need, ()))
            return _EMPTY_NEED_GUIDANCE

        # Only the search call sits under the except, and deliberately so: the exposure loop runs on
        # what search returned, so a search that raised never reaches it and the invocation records
        # zero exposures. Widening the guard over the loop would let a half-written set of exposures
        # survive a failure.
        try:
            # The index may be a network-backed implementation, so search is allowed to be awaitable.
            found = self._index.search(need, self._top_k)
            matches: Sequence[ToolMatch] = await found if inspect.isawaitable(found) else found
        except Exception:
            logger.warning("tool search failed | returning guidance to the model", exc_info=True)
            _instrument(lambda: _log_search_outcome(need, ()))
            return _SEARCH_FAILED_GUIDANCE

        registry = agent.tool_registry.registry
        exposed: list[str] = []
        lines: list[str] = []
        for match in matches:
            registered = registry.get(match.name)
            # A match the registry does not have has no specification to expose and no description to
            # report, so it is left out of both the exposures and the text.
            if registered is None:
                continue
            _renew(state, match.name, cycle)
            exposed.append(match.name)
            lines.append(f"- {match.name}: {self._short_description(registered.tool_spec)}")

        _instrument(lambda: _log_search_outcome(need, exposed))

        # Nothing to list: either search ranked no tool, or every match it ranked is absent from the
        # registry. Both leave the header with an empty list under it, which reads as a failure of the
        # tool rather than of the wording, so the reformulation guidance goes out instead.
        if not lines:
            return _NO_MATCH_GUIDANCE

        # Name and short description only. The schema arrives through the projection, which is
        # per-call and therefore forgettable; a tool result is a message, and a message is resident.
        return "\n".join([_MATCHES_HEADER, *lines])

    @hook  # type: ignore[call-overload]  # sync hook method; the @hook overloads only infer async
    def _on_before_tool_call(self, event: BeforeToolCallEvent) -> None:
        """Renew the exposure of the tool about to be called, and recover a premature call.

        A tool being called is the strongest evidence that its schema is still worth sending, so the
        call itself renews the TTL. That is what lets a tool used over a stretch of consecutive cycles
        keep its full specification in every projection without a second search.

        The second job is the call the model made off a catalog entry, before the parameters had ever
        been projected. Such a call arrives with no arguments against a tool that requires some, so it
        would fail on validation and cost a cycle anyway. The cycle is spent exposing the schema
        instead: the call is cancelled with a message asking for the same call again, and the renewal
        above has already exposed the tool, so the next projection carries the full specification.

        The four conditions are all necessary, and each one on its own is a reason to let the call
        through. An already exposed tool was called with the schema in hand. A tool in
        ``always_available`` never had its schema hidden. A tool with no required parameter is
        callable empty. And a call carrying arguments came from a model that knew what to pass.

        A name the registry does not have is left alone entirely — no cancellation and no exposure.
        There is no specification to expose for it, and the event loop already reports the unknown
        tool. ``event.tool_use`` and the ``ToolRegistry`` come out of here unchanged on every path:
        the only writes are the disclosure state and, in the premature case, ``event.cancel_tool``.

        Args:
            event: The pre-call event. Only ``cancel_tool`` is ever written.
        """
        name = event.tool_use["name"]
        agent = event.agent

        if name not in agent.tool_registry.registry:
            return

        state = _state_for(self._states, agent)
        # Read before the write: whether the schema was already projected is what tells a normal call
        # apart from a call made off a catalog entry, and the renewal erases that distinction.
        was_exposed = name in state.exposed
        _renew(state, name, agent.event_loop_metrics.cycle_count)

        if was_exposed or name in self._always_available:
            return

        # An empty call to a tool that requires arguments is the signature of a call made off a
        # catalog entry: the model knew the name but never saw the parameters.
        if _requires_parameters(agent.tool_registry.registry[name].tool_spec) and not event.tool_use.get("input"):
            event.cancel_tool = _PREMATURE_CALL_MESSAGE.format(name=name)
            _instrument(lambda: _record_premature_cancellation(state, name))

    def _short_description(self, spec: ToolSpec) -> str:
        """Cut ``spec``'s description to the catalog budget, for use in the search result.

        Falls back to the default budget when the catalog is suppressed: ``catalog_tokens=None``
        drops the catalog from the projection, it does not mean the search result should carry a full
        description.

        Args:
            spec: Full specification as registered in the ``ToolRegistry``. Left unmodified.

        Returns:
            The short description of the tool.
        """
        budget = _DEFAULT_CATALOG_TOKENS if self._catalog_tokens is None else self._catalog_tokens
        return _truncate_description(spec["description"], budget)

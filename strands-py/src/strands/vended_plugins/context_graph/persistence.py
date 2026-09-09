"""Keep the derived graph across processes, through whatever session manager the agent already has.

**Why persist a graph the design calls derivable.** The rebuild scan is what makes losing the graph
safe, and it stays: this module never replaces it, it only avoids paying for it. Measured, the scan
costs ~30ms over an 18-turn conversation and **~2.9s over a 200-turn one**, and the turn choice runs
on the critical path of the model call. Recomputing is only free while the conversation is short.

The cost is worse than latency in an ephemeral runtime. A session restored into a fresh process
populates ``agent.messages`` directly, which fires no ``MessageAddedEvent`` — so the scan, which runs
on the writing half, has not run when the choice is computed. Every invocation of a per-invocation
runtime therefore decides a full pass, and the strategy never engages at all.

**Storage is the session manager's, not ours.** Every session manager persists ``agent.state``:
``SessionAgent.from_agent`` reads it, and file, S3 and any ``SessionRepository`` — an AgentCore Memory
integration included — store it without knowing what is inside. So a namespaced key here is
file, S3, AgentCore and custom storage at once, and there is no persistence interface to define, no
session field to add, and no second backend to keep in step with the first.

**What is stored, and what deliberately is not.**

=================  =========  ==============================================================
Field              Stored     Why
=================  =========  ==============================================================
``cards``          yes        the ~2.9s this exists to avoid
``links``          yes        same scan derives them
``turn``           yes        the ordinal the two paths have to agree on
``reuse``          yes        not derivable from the messages, and tiny
``choice``         **no**     per turn; restoring it applies the last invocation's decision
``referenced``     **no**     per call
``vectors``        **no**     a cache. Losing it costs one embedding round trip (~262ms);
                              carrying it costs ~369KB of JSON per 18 Cards through a
                              session sync that fires on **every message**
=================  =========  ==============================================================

**Two guards, because a stored graph can be wrong in two ways a derived one cannot.**

A Card holds durable identities into ``agent.messages``, and a stored Card can outlive the message it
addresses — a redaction, a trimmed session, a partial write. So on load a Card is kept only when every
identity it addresses is still present. That is the reconciliation the rebuild scan avoided by never
storing anything, and it is five lines rather than a subsystem (Requirement 14.9: a message that no
longer exists is omitted from every decision, without raising).

And Tags, Descriptions and rarity are functions of the configuration *and* of the graph's population —
``retag`` recounts rarity whenever a Card is added, because what defines a Card depends on what it is
compared against. A Card stored under one configuration is not the Card the current one would derive,
and the difference is silent. Hence the fingerprint: a mismatch discards the payload and falls back to
the scan, which is the behavior that was correct before this module existed.

**The security boundary moves, which is why this is opt-in.** A Description carries numeric lines
copied literally — monetary values, account numbers. Persisting puts a second copy of that in the
session store, in a place the operator audited for messages rather than for derived summaries. The
strategy writes nothing durable unless asked (Requirement 14.2 as written; this module is the
documented exception to it, taken only under ``persist=True``).
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import TYPE_CHECKING, Any

from .state import Card, Link, ToolPair, _GraphState

if TYPE_CHECKING:
    from ...agent.agent import Agent

__all__ = ["load", "save"]

logger = logging.getLogger(__name__)

_STATE_KEY = "strands:context-graph"
"""Namespaced key in ``agent.state``, so the plugin does not squat the application's namespace."""

_VERSION = 1
"""Payload version.

A stored graph has a schema, and a schema that cannot be told apart from the next one is a graph that
loads wrong rather than one that declines to load.
"""


def fingerprint(**config: Any) -> str:
    """Identity of the configuration a stored graph was derived under.

    Args:
        **config: The values every Card was derived with. Must be JSON-serializable.

    Returns:
        A short stable digest. Comparing digests rather than values keeps the payload from carrying a
        copy of the configuration that could disagree with the instance reading it.
    """
    return hashlib.sha256(json.dumps(config, sort_keys=True).encode("utf-8")).hexdigest()[:16]


def save(agent: Agent, state: _GraphState, **config: Any) -> None:
    """Write the derivable half of ``state`` into ``agent.state``.

    Called from the writing half. The session sync this feeds already runs on ``MessageAddedEvent``,
    so writing here adds no round trip of its own — it changes what the sync that was going to happen
    anyway carries.

    Never raises: a store that cannot take the payload costs a rebuild scan on the next process, which
    is the behavior without this module.

    Args:
        agent: The agent whose session carries the payload.
        state: The graph state to store. Read only.
        **config: The configuration the Cards were derived under, for the fingerprint.
    """
    try:
        payload = {
            "version": _VERSION,
            "fingerprint": fingerprint(**config),
            "turn": state.turn,
            "cards": [_encode_card(card) for card in state.cards.values()],
            "links": {title: [_encode_link(link) for link in edges] for title, edges in state.links.items()},
            "reuse": {title: [bonus, cycle] for title, (bonus, cycle) in state.reuse.items()},
        }
        if agent.state.get(_STATE_KEY) == payload:
            # An unchanged graph is not written. ``AgentState.set`` bumps its version on every call,
            # and the session manager syncs on a version change — so an unconditional write turns
            # every turn boundary into a full rewrite of the session's agent record, measured at
            # ~150KB for two dozen Cards, whether or not the graph moved.
            return
        agent.state.set(_STATE_KEY, payload)
    except Exception:
        logger.debug("graph state not stored | the next process rebuilds it by scan", exc_info=True)


def load(agent: Agent, state: _GraphState, **config: Any) -> bool:
    """Restore ``state`` from ``agent.state``, dropping whatever the messages no longer support.

    Args:
        agent: The agent whose session carries the payload.
        state: The graph state to write. Only touched when the return is ``True``.
        **config: The configuration this instance derives under, for the fingerprint.

    Returns:
        Whether the graph was restored. ``False`` means the caller should run the rebuild scan, and it
        covers every way the payload can be unusable: absent, written by another version, derived
        under another configuration, or addressing messages that are gone.
    """
    try:
        return _load(agent, state, **config)
    except Exception:
        logger.debug("graph state not restored | rebuilding it by scan", exc_info=True)
        return False


def _load(agent: Agent, state: _GraphState, **config: Any) -> bool:
    """Restore the payload, or report that the caller should scan instead."""
    stored = agent.state.get(_STATE_KEY)
    if not isinstance(stored, dict):
        return False
    if stored.get("version") != _VERSION or stored.get("fingerprint") != fingerprint(**config):
        return False

    live = {identity for message in agent.messages if (identity := message.get("tracking_id"))}

    cards: dict[str, Card] = {}
    for encoded in stored.get("cards") or ():
        card = _decode_card(encoded)
        addressed = set(card.dialogue_ids) | set(card.evidence_ids)
        # An artifact Card addresses no message, so it is kept on its reference alone; a subject Card
        # is kept only while every message it addresses is still there.
        if addressed and not addressed <= live:
            continue
        cards[card.title] = card

    if not cards:
        return False

    state.cards = cards
    # An edge whose target did not survive is dropped. Propagation already skips a dangling target,
    # but keeping one would make the loaded graph differ from the derived one, and those two agreeing
    # is what keeps the cold path and the warm path deciding alike.
    state.links = {
        title: [_decode_link(edge) for edge in edges if _resolves(edge, cards)]
        for title, edges in (stored.get("links") or {}).items()
        if title in cards
    }
    state.reuse = {
        title: (float(entry[0]), int(entry[1]))
        for title, entry in (stored.get("reuse") or {}).items()
        if title in cards
    }
    state.turn = int(stored.get("turn") or len(cards))
    logger.debug("graph state restored | cards=<%d> | turn=<%d>", len(cards), state.turn)
    return True


def _resolves(edge: dict[str, Any], cards: dict[str, Card]) -> bool:
    """Whether an edge's target still exists. A tool edge targets a name, not a Card."""
    return edge.get("kind") == "tool" or edge.get("target") in cards


def _encode_card(card: Card) -> dict[str, Any]:
    """Render one Card as JSON types. Frozen sets and tuples become lists, in a fixed order."""
    return {
        "title": card.title,
        "kind": card.kind,
        "turn": card.turn,
        "dialogue_ids": list(card.dialogue_ids),
        "evidence_ids": list(card.evidence_ids),
        "pairs": [
            {
                "tool_use_id": pair.tool_use_id,
                "tool_name": pair.tool_name,
                "tracking_ids": list(pair.tracking_ids),
                "consumed": pair.consumed,
            }
            for pair in card.pairs
        ],
        # Sorted, so two runs over the same graph produce the same bytes and a diff of the session is
        # readable.
        "tool_names": sorted(card.tool_names),
        "references": list(card.references),
        "numeric_lines": list(card.numeric_lines),
        "tags": list(card.tags),
        "description": card.description,
        "reference": card.reference,
        "content_type": card.content_type,
        "size_bytes": card.size_bytes,
    }


def _decode_card(encoded: dict[str, Any]) -> Card:
    """Rebuild one Card from its JSON form, restoring the tuple and frozenset fields."""
    return Card(
        title=encoded["title"],
        kind=encoded["kind"],
        turn=int(encoded["turn"]),
        dialogue_ids=tuple(encoded.get("dialogue_ids") or ()),
        evidence_ids=tuple(encoded.get("evidence_ids") or ()),
        pairs=tuple(
            ToolPair(
                tool_use_id=pair["tool_use_id"],
                tool_name=pair["tool_name"],
                tracking_ids=tuple(pair.get("tracking_ids") or ()),
                consumed=bool(pair["consumed"]),
            )
            for pair in encoded.get("pairs") or ()
        ),
        tool_names=frozenset(encoded.get("tool_names") or ()),
        references=tuple(encoded.get("references") or ()),
        numeric_lines=tuple(encoded.get("numeric_lines") or ()),
        tags=tuple(encoded.get("tags") or ()),
        description=encoded.get("description") or "",
        reference=encoded.get("reference"),
        content_type=encoded.get("content_type"),
        size_bytes=encoded.get("size_bytes"),
    )


def _encode_link(link: Link) -> dict[str, Any]:
    """Render one Link as JSON types."""
    return {"kind": link.kind, "target": link.target, "weight": link.weight}


def _decode_link(encoded: dict[str, Any]) -> Link:
    """Rebuild one Link from its JSON form."""
    return Link(kind=encoded["kind"], target=encoded["target"], weight=float(encoded["weight"]))

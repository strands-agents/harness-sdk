"""Keep the derived graph across processes, through whatever session manager the agent already has.

The rebuild scan remains the fallback; this module only avoids paying for it. It matters most in an ephemeral runtime: a
session restored into a fresh process populates ``agent.messages`` directly, firing no ``MessageAddedEvent``, so the
scan on the writing half has not run when the choice is computed and every invocation decides a full pass.

Storage is the session manager's, not ours. Every session manager persists ``agent.state``: ``SessionAgent.from_agent``
reads it, and file, S3 and any ``SessionRepository`` store it without knowing what is inside. So a namespaced key here
is file, S3, AgentCore and custom storage at once, with no persistence interface to define and no session field to add.

Stored: ``cards`` and ``links`` (the scan this exists to avoid), ``turn`` (the ordinal both paths must agree on),
``reuse`` (not derivable from the messages, and tiny). Not stored: ``choice`` (per turn; restoring it applies the last
invocation's decision), ``referenced`` (per call), ``vectors`` (a cache — losing it costs one embedding round trip,
carrying it sends bulk JSON through a sync that fires on every message).

Two guards, because a stored graph can be wrong in two ways a derived one cannot. A Card holds durable identities into
``agent.messages`` and can outlive the message it addresses through a redaction, a trimmed session or a partial write,
so on load a Card is kept only when every identity it addresses is still present (Requirement 14.9: a message that no
longer exists is omitted from every decision, without raising). And Tags, Descriptions and rarity are functions of the
configuration *and* of the graph's population, since ``retag`` recounts rarity whenever a Card is added, so a Card
stored under one configuration is not the Card the current one would derive; the difference being silent, a fingerprint
mismatch discards the payload and falls back to the scan.

The security boundary moves, hence opt-in. A Description carries numeric lines copied literally, monetary values and
account numbers among them, so persisting puts a second copy of that in a store the operator audited for messages rather
than for derived summaries. The strategy writes nothing durable unless asked (Requirement 14.2; this module is the
documented exception, taken only under ``persist=True``).
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
"""Payload version. A mismatch declines to load rather than reading a schema it cannot tell apart."""


def fingerprint(**config: Any) -> str:
    """Identity of the configuration a stored graph was derived under.

    Args:
        **config: The values every Card was derived with. Must be JSON-serializable.

    Returns:
        A short stable digest, compared instead of the values themselves so the payload never carries a copy of the
        configuration.
    """
    return hashlib.sha256(json.dumps(config, sort_keys=True).encode("utf-8")).hexdigest()[:16]


def save(agent: Agent, state: _GraphState, **config: Any) -> None:
    """Write the derivable half of ``state`` into ``agent.state``.

    Called from the writing half, where the session sync it feeds already runs on ``MessageAddedEvent``, so this adds no
    round trip of its own. Never raises: a store that cannot take the payload costs a rebuild scan on the next process,
    the behavior without this module.

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
            # An unchanged graph is not written. ``AgentState.set`` bumps its version on every call and the session
            # manager syncs on a version change, so an unconditional write rewrites the whole agent record every turn.
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
        Whether the graph was restored. ``False`` tells the caller to run the rebuild scan and covers every way the
        payload can be unusable: absent, written by another version, derived under another configuration, or addressing
        messages that are gone.
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
        # An artifact Card addresses no message and is kept on its reference alone; a subject Card is kept only while
        # every message it addresses is still there.
        if addressed and not addressed <= live:
            continue
        cards[card.title] = card

    if not cards:
        return False

    state.cards = cards
    # An edge whose target did not survive is dropped, so the warm path and the cold path decide alike.
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
        # Sorted, so two runs over the same graph produce the same bytes.
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

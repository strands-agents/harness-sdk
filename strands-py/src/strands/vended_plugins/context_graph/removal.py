"""The durable identities the removal asks to drop, derived from the (Card, part) pair.

It asks, it does not decide. ``project_messages`` may preserve any requested identity by pin, by the first user message,
or by tool-pair reconciliation; the compaction computes what actually left by comparing the request against the returned
list. Hence ``ids`` and not ``dropped``.

Absence carries the lag between the two halves: the graph is derived on ``MessageAddedEvent`` and read on
``InvokeModelStage.Input``, so a call can land before the previous turn's Card exists or while the current turn is still
open. Neither needs a check, since an underived Card has no key in ``state.cards`` and the turn in progress is
subtracted via ``current_turn_ids``. A failed derivation costs full content for that turn with no conditional to get
wrong. A title missing from the choice reads as full, the same fail-safe direction. An artifact Card gets no special
case; keeping raw tool returns out of full content is upheld upstream in the scoring.

``project_messages`` is the removal itself and owns the four guards and the monotone closures that make the fixed point
structural. ``apply_removal`` is wiring over it.
"""

from __future__ import annotations

from ...types.content import Messages
from .projection import project_messages
from .state import Resolution, TurnChoice, _GraphState


def removal_ids(
    state: _GraphState,
    choice: TurnChoice,
    current_turn_ids: frozenset[str],
) -> frozenset[str]:
    """Durable identities the removal should attempt to drop.

    Derives from the (Card, part) pair and nothing else, mutating neither the graph state nor ``agent.messages`` (Req.
    11.9).

    Args:
        state: The graph state. Read only.
        choice: The turn choice, frozen at ``BeforeInvocationEvent``. A title absent from ``choice.by_title`` reads as
            full content.
        current_turn_ids: Durable identities of the turn in progress. Never in the return.

    Returns:
        The requested identities. Empty when the choice keeps every part in full content, making the assembled context
        identical field by field to the one produced without the feature.
    """
    requested: set[str] = set()

    for title, card in state.cards.items():
        card_choice = choice.by_title.get(title)
        if card_choice is None:
            continue

        for part_ids, resolution in (
            (card.dialogue_ids, card_choice.dialogue),
            (card.evidence_ids, card_choice.evidence),
        ):
            if _is_full(resolution):
                continue
            requested.update(part_ids)

    return frozenset(requested - current_turn_ids)


def apply_removal(
    messages: Messages,
    state: _GraphState,
    choice: TurnChoice,
    current_turn_ids: frozenset[str],
) -> tuple[Messages, frozenset[str]]:
    """Derive the request and apply it, returning the removal and the request that produced it.

    The compaction needs both: what actually left is ``requested`` minus the identities still present in the returned
    list, and that subtraction keeps a pinned message from paying for its content twice. Mutates nothing — not
    ``messages``, not a dict inside it, not ``agent.messages``, not the graph state — and returns the same list object
    when the request is empty.

    Args:
        messages: The call's message list. Read only.
        state: The graph state. Read only.
        choice: The turn choice, frozen at ``BeforeInvocationEvent``.
        current_turn_ids: Durable identities of the turn in progress. Never removed.

    Returns:
        The removal, a subsequence of ``messages`` holding the same message objects in the same relative order with no
        duplication and no insertion, and the request it was derived from.
    """
    requested = removal_ids(state, choice, current_turn_ids)
    return project_messages(messages, requested), requested


def _is_full(resolution: Resolution) -> bool:
    """Whether a part stays whole, in which case none of its identities is requested."""
    return resolution == "full"

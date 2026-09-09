"""The durable identities the removal asks to drop, derived from the (Card, part) pair.

The module is one function, and its whole design is in what it does *not* do.

**It asks, it does not decide.** The returned set is a request. ``project_messages`` may preserve any
identity in it — by pin, by the first user message, or by tool-pair reconciliation — and that is not
a failure of this function, it is the guards doing their job. Whoever computes what actually left is
the compaction, by comparing this request against the list the projection returned (Requirement 9.4).
Reading the return as a result is the one way to misuse it, which is why the name says ``ids`` and not
``dropped``.

**Two absences carry the lag between the two halves.** The graph is derived on ``MessageAddedEvent``
and read on ``InvokeModelStage.Input``, so a call can land while the previous turn's Card has not
been derived yet, or while the current turn is still open. Neither case needs a check here:

- A Card that was never derived has no entry in ``state.cards``, so its identities are unreachable
  by the loop. Requirements 3.10 and 16.5 hold by absence of a key.
- A message of the turn in progress has its identity in ``current_turn_ids``, subtracted at the end.
  Requirements 3.6 and 6.2 hold by one set difference.
- A message with no Card — no ``tracking_id``, or a turn boundary still open — appears in no id
  tuple, so it cannot be requested either.

A derivation that failed therefore costs full content for that turn, which is the degradation the
design asks for, and it costs it without a single conditional that could be written wrong.

**An artifact Card gets no special case.** Requirement 11.8 — a raw tool return only reaches full
content by explicit model request — is upheld upstream, where the note is turned into a choice: the
scoring never elevates an artifact. Here an artifact is read exactly like a subject, because a second
place that knows about artifacts is a second place that can disagree about them.

**A title missing from the choice is read as full.** The choice is frozen at
``BeforeInvocationEvent``; a Card derived after that instant has no entry in it. Absent means keep,
in the same direction as every other fail-safe in the module.

**The removal itself is ``project_messages``.** ``apply_removal`` is wiring and nothing else: it
derives the request and hands it to that function. The four guards — tool pair travelling together,
the first user message, ``is_pinned`` over any resolution, and a non-empty removal for a non-empty
history — plus the two monotone closures that make the fixed point structural, all live there.
Reimplementing them here would reintroduce a defect that is already solved: a message carrying two
``toolUseId``s, one paired with a protected end and one with a dropped end, loops forever under the
naive scan.
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

    Derives from the (Card, part) pair and from nothing else. Completes without mutating the graph
    state and without touching ``agent.messages`` (Requirement 11.9).

    Args:
        state: The graph state. Read only; never mutated.
        choice: The turn choice, frozen at ``BeforeInvocationEvent``. A title absent from
            ``choice.by_title`` is read as full content.
        current_turn_ids: Durable identities of the turn in progress. Never in the return.

    Returns:
        The requested identities. Empty when the choice keeps every part in full content, which makes
        the assembled context identical, field by field, to the one produced without the feature.
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

    Two lines of wiring over two functions that already hold their own contracts. The request is
    returned alongside the removal because the compaction needs both: what actually left is
    ``requested`` minus the identities still present in the returned list (Requirement 9.4), and that
    subtraction is the only thing that keeps a pinned message from paying for its content twice.

    Nothing is mutated: neither ``messages``, nor any dict inside it, nor ``agent.messages``, nor the
    graph state (Requirements 9.3, 11.9). When the request is empty — every part in full content — the
    **same list object** comes back, so the assembled context is what it would be without the feature
    (Requirement 9.9).

    The turn's short circuit on ``choice.full_pass`` belongs to the caller. Reaching here with a full
    pass is harmless — the request comes out empty and the same list is returned — but it costs one
    scan of the graph that the handler can avoid.

    Args:
        messages: The call's message list. Read only.
        state: The graph state. Read only; never mutated.
        choice: The turn choice, frozen at ``BeforeInvocationEvent``.
        current_turn_ids: Durable identities of the turn in progress. Never removed.

    Returns:
        The removal — a subsequence of ``messages``, made of the same message objects in the same
        relative order, with no duplication and no insertion — and the request it was derived from.
    """
    requested = removal_ids(state, choice, current_turn_ids)
    return project_messages(messages, requested), requested


def _is_full(resolution: Resolution) -> bool:
    """Whether a part stays whole, in which case none of its identities is requested."""
    return resolution == "full"

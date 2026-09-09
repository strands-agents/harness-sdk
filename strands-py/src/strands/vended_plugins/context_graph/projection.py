"""Project the turn's message list, dropping the durable identities the removal requested.

This is step 5 of the event loop, and it runs on ``context.messages`` — the deep defensive copy
built when the model call is assembled — never on ``agent.messages``. That layer difference is what
makes the whole design reversible: a wrong choice costs one poorer model call, never lost
information.

``project_messages`` is a pure function of ``(messages, drop_ids)``. It derives nothing about the
graph: the request arrives already computed as a frozen set of durable identities, so a derivation
finishing mid-turn cannot change the selection under the projection's feet.
"""

from collections import deque

from ...agent.conversation_manager.compression.pin_message import _get_tool_use_ids, is_pinned
from ...types.content import Messages


def project_messages(messages: Messages, drop_ids: frozenset[str]) -> Messages:
    """Return the subsequence of messages to send to the provider.

    Never mutates ``messages`` nor the message dicts inside it. Returns the same list object when
    the request is empty, so the no-drop path allocates nothing and the assembled context is
    bit-for-bit what it would be without this feature installed.

    A message is dropped only when its durable identity is in the request. A message without a
    ``tracking_id``, or with one absent from the request, always stays — that is the structural
    fail-safe for derivation lag: a late derivation sends more context, never less.

    Two guards override the drop decision. An explicit ``is_pinned`` from the main agent wins over
    any request, and the first ``role == "user"`` message is never dropped because providers reject
    a conversation that does not open with a user turn. A third guard reconciles tool pairs: a
    ``toolUse`` and its ``toolResult`` always travel together, so dropping one drops the other —
    unless one end is protected, in which case both ends stay.

    Args:
        messages: The turn's message list. Read only.
        drop_ids: Durable identities requested for removal, frozen for the whole turn.

    Returns:
        A subsequence of ``messages``, made of the same message objects in the same relative order.
        The same list object when ``drop_ids`` is empty. Never empty for a non-empty input.
    """
    if not drop_ids:
        return messages
    first_user_index = _first_user_index(messages)
    protected = _protected_indices(messages, first_user_index)
    keep = _provisional_keep(messages, drop_ids, protected)
    per_index, groups = _tool_pair_groups(messages)
    _reconcile_tool_pairs(keep, per_index, groups, protected)
    if messages and not any(keep):
        # A non-empty history always projects at least one message: an empty request is not a
        # cheaper call, it is a rejected one. Reachable only when nothing was protected — no pin and
        # no user turn at all — and the pair reconciliation dropped whatever pass 1 had kept.
        protected = protected | {0}
        keep[0] = True
        _reconcile_tool_pairs(keep, per_index, groups, protected)
    return [message for index, message in enumerate(messages) if keep[index]]


def _first_user_index(messages: Messages) -> int:
    """Index of the first message with ``role == "user"``, or ``-1`` when there is none.

    One pass, short-circuited: the projection needs this position for the guard that keeps the
    leading user turn, and a history with no user message at all has no such guard to apply.
    """
    for index, message in enumerate(messages):
        if message.get("role") == "user":
            return index
    return -1


def _protected_indices(messages: Messages, first_user_index: int) -> set[int]:
    """Positions a request can never drop: an explicit pin, and the leading user turn.

    Computed once and reused by both passes, so ``is_pinned`` is evaluated a single time per index.

    Args:
        messages: The turn's message list. Read only.
        first_user_index: Position of the leading user turn, or ``-1`` when absent.

    Returns:
        The set of protected positions.
    """
    protected = {index for index in range(len(messages)) if is_pinned(messages, index)}
    if first_user_index >= 0:
        protected.add(first_user_index)
    return protected


def _provisional_keep(messages: Messages, drop_ids: frozenset[str], protected: set[int]) -> list[bool]:
    """Decide keep or drop per index, before tool pairs are reconciled.

    Provisional because a kept message may still be dropped, and a dropped one promoted back, once
    the tool-pair guard runs over the result.

    Args:
        messages: The turn's message list. Read only.
        drop_ids: Durable identities requested for removal.
        protected: Positions no request can drop.

    Returns:
        One flag per index of ``messages``: ``True`` to keep, ``False`` to drop.
    """
    keep = [True] * len(messages)
    for index, message in enumerate(messages):
        tracking_id = message.get("tracking_id")
        if not tracking_id or tracking_id not in drop_ids:
            continue  # Unrequested or unnamed: the fail-safe default is to send it.
        if index in protected:
            continue  # A pin from the main agent, or the user turn the provider requires.
        keep[index] = False
    return keep


def _tool_pair_groups(messages: Messages) -> tuple[list[set[str]], dict[str, list[int]]]:
    """Index the tool pairs of the history in one pass.

    Args:
        messages: The turn's message list. Read only.

    Returns:
        A tuple of the ``toolUseId`` set carried by each index, and the map from ``toolUseId`` to
        every index carrying it — the messages that form that pair.
    """
    per_index: list[set[str]] = []
    groups: dict[str, list[int]] = {}
    for index, message in enumerate(messages):
        tool_use_ids = _get_tool_use_ids(message)
        per_index.append(tool_use_ids)
        for tool_use_id in tool_use_ids:
            groups.setdefault(tool_use_id, []).append(index)
    return per_index, groups


def _reconcile_tool_pairs(
    keep: list[bool],
    per_index: list[set[str]],
    groups: dict[str, list[int]],
    protected: set[int],
) -> None:
    """Rewrite ``keep`` in place so no tool pair is ever split.

    Sending a ``toolUse`` without its ``toolResult`` is a protocol error, so a pair is reconciled
    toward DROP: dropping one end drops the other. When one end is protected the reconciliation goes
    the other way and both ends stay — a request never causes a protected message to leave.

    Two monotone closures instead of the naive scan-until-stable loop. Growth in one direction only
    is what makes termination structural: KEEP promotion starts from a fixed set of protected
    positions and only adds, DROP propagation only removes and never touches a promoted position. A
    message carrying two ``toolUseId``s — one paired with a protected end, one with a dropped end —
    would otherwise flip forever between the two rules.

    Cost is proportional to the number of messages plus the number of pair memberships: each index
    enters each queue at most once.

    Args:
        keep: Per-index flags from pass 1. Mutated in place.
        per_index: ``toolUseId`` set carried by each index.
        groups: Map from ``toolUseId`` to the indices forming that pair.
        protected: Positions no request can drop.
    """
    # Closure 1 — KEEP: protection reaches every partner, transitively.
    must_keep = set(protected)
    pending = deque(protected)
    while pending:
        for tool_use_id in per_index[pending.popleft()]:
            for partner in groups[tool_use_id]:
                if partner not in must_keep:
                    must_keep.add(partner)
                    pending.append(partner)
    for index in must_keep:
        keep[index] = True
    # Closure 2 — DROP: a dropped end takes its partners with it, except the promoted ones.
    dropped = {index for index, kept in enumerate(keep) if not kept}
    pending = deque(dropped)
    while pending:
        for tool_use_id in per_index[pending.popleft()]:
            for partner in groups[tool_use_id]:
                if partner in dropped or partner in must_keep:
                    continue
                dropped.add(partner)
                keep[partner] = False
                pending.append(partner)

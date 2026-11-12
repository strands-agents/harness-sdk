"""Trimming messages from the context window while keeping it valid for the model.

Removing them with their tool pairs, leaving a placeholder for each removed run, and restoring
user/assistant alternation.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any, NamedTuple, cast

from ..types.content import ContentBlock, Message, MessageMetadata, Messages
from ..types.offload import OffloadMethod
from .placeholder import carried_tokens, offload_placeholder

if TYPE_CHECKING:
    from ..models.model import Model
    from .stash import Stash

logger = logging.getLogger(__name__)


class RemovalPlaceholder(NamedTuple):
    """The placeholder left for a removed run: its text and the tokens it stands for."""

    text: str
    tokens: int


PlaceholderText = Callable[[Messages], Awaitable[RemovalPlaceholder | None]]
"""Writes the placeholder for messages about to be removed with their tool pairs.

Its text reads like ``[Dropped: earlier messages, ~1,200 tokens]`` or a summary. Returning None keeps them, as
summarize does when its model call fails.
"""


async def removed_tokens(run: Messages, model: Model) -> int:
    """The tokens a run stands for once it is removed.

    Its current content plus what any marker it carries already stood for, so re-removing a marker's carrier
    reports the whole size rather than the marker's own few tokens.
    """
    carried = carried_tokens([block for message in run for block in message["content"]])
    return await model.count_tokens(run) + carried


def placeholder_for(model: Model, format_marker: Callable[[int], str]) -> PlaceholderText:
    """A :func:`remove_messages` placeholder reading ``format_marker(tokens)``.

    For the methods that always leave a marker. Summarize writes its own, since a failed summary keeps the run.
    """

    async def text_for(removed: Messages) -> RemovalPlaceholder | None:
        tokens = await removed_tokens(removed, model)
        return RemovalPlaceholder(format_marker(tokens), tokens)

    return text_for


def _index_of(messages: Messages, message: Message) -> int | None:
    """The position of ``message`` in ``messages`` by identity, since equal messages are not the same message."""
    return next((index for index, candidate in enumerate(messages) if candidate is message), None)


def collect_removable_with_pair(messages: Messages, index: int) -> list[Message]:
    """Collect a message and its paired partner (if any) for safe removal.

    If removing a message would orphan a tool-use/tool-result pair, includes the partner so the pair is removed
    together. Never collects message 0 or the last message, which the next model call responds to.
    """
    if index <= 0 or index >= len(messages) - 1:
        return []

    message = messages[index]
    result = [message]

    if any("toolResult" in block for block in message["content"]):
        previous = messages[index - 1]
        if any("toolUse" in block for block in previous["content"]):
            if index - 1 == 0:
                return []
            result.append(previous)

    if any("toolUse" in block for block in message["content"]):
        following = messages[index + 1]
        if any("toolResult" in block for block in following["content"]):
            if index + 1 == len(messages) - 1:
                return []
            result.append(following)

    return result


def with_pairs(messages: Messages, to_remove: list[Message]) -> list[Message]:
    """The removable messages among ``to_remove``, with their tool pairs, in conversation order."""
    removable: set[int] = set()
    for message in to_remove:
        index = _index_of(messages, message)
        if index is None:
            continue
        removable.update(id(partner) for partner in collect_removable_with_pair(messages, index))
    return [message for message in messages if id(message) in removable]


def insert_marker(messages: Messages, index: int, marker: ContentBlock) -> None:
    """Add a marker as assistant content at the gap left by removed messages.

    The marker is appended to an assistant message beside the gap, which keeps that message's tracking id and block
    indices for stash refs, or becomes its own assistant message. It never joins message 0, and the last message is
    never removed, so a new marker never ends the history.
    """
    index = max(1, min(index, len(messages)))
    for neighbor in (index - 1, index):
        if 0 < neighbor < len(messages) and messages[neighbor]["role"] == "assistant":
            carrier = messages[neighbor].copy()
            carrier["content"] = [*carrier["content"], marker]
            messages[neighbor] = carrier
            return
    messages.insert(index, Message(role="assistant", content=[marker]))


def repair_alternation(messages: Messages) -> None:
    """Merge consecutive same-role messages to restore the user/assistant alternation that models require.

    Called after message-level operations that may leave gaps. Constructs new messages for merges to avoid mutating
    ones that may be referenced elsewhere (session storage, event payloads). A merge keeps the earlier message's
    tracking id and merges both messages' metadata, so it is pinned if either was.
    """
    write_index = 0
    for current in list(messages):
        previous = messages[write_index - 1] if write_index > 0 else None
        if previous is not None and previous["role"] == current["role"]:
            merged = previous.copy()
            merged["content"] = [*previous["content"], *current["content"]]
            metadata = _merge_metadata(previous.get("metadata"), current.get("metadata"))
            if metadata is not None:
                merged["metadata"] = metadata
            messages[write_index - 1] = merged
        else:
            messages[write_index] = current
            write_index += 1
    del messages[write_index:]


def _merge_metadata(earlier: MessageMetadata | None, later: MessageMetadata | None) -> MessageMetadata | None:
    """The later message's metadata fields win, and ``custom`` holds both messages' entries."""
    if earlier is None or later is None:
        return later if later is not None else earlier
    merged: dict[str, Any] = {**earlier, **later}
    custom = {**earlier.get("custom", {}), **later.get("custom", {})}
    if custom:
        merged["custom"] = custom
    return cast(MessageMetadata, merged)


async def remove_messages(
    messages: Messages,
    to_remove: list[Message],
    text_for: PlaceholderText,
    method: OffloadMethod,
    stash: Stash | None,
) -> bool:
    """Remove messages with their tool pairs, leaving one placeholder for each contiguous run of them.

    Each run is stashed under its own reference. A run whose text is None is kept, and a failed stash write leaves
    the placeholder without a reference. Callers restore alternation once they are done.

    Returns:
        Whether anything was removed.
    """
    acted = False
    # Last run first, so removing a run leaves the earlier runs' positions unchanged.
    for run in reversed(_split_into_runs(messages, with_pairs(messages, to_remove))):
        if await _remove_run(messages, run, text_for, method, stash):
            acted = True
    return acted


async def _remove_run(
    messages: Messages, run: Messages, text_for: PlaceholderText, method: OffloadMethod, stash: Stash | None
) -> bool:
    """Replace a contiguous run of messages with one placeholder."""
    placeholder = await text_for(run)
    if placeholder is None:
        return False

    start = _index_of(messages, run[0])
    if start is None:
        return False
    del messages[start : start + len(run)]
    stash_ref = await stash_removed(stash, run, method)
    insert_marker(messages, start, offload_placeholder(method, placeholder.text, stash_ref, placeholder.tokens))
    return True


async def stash_removed(stash: Stash | None, removed: Messages, method: OffloadMethod) -> str | None:
    """The reference a run of removed messages is retrievable under.

    None when there is no stash or the write failed, which leaves the placeholder without a reference rather than
    keeping content the caller has accounted for.
    """
    if stash is None or not removed:
        return None
    try:
        return await stash.store_removed(removed)
    except Exception:
        logger.warning("method=<%s> | failed to stash removed messages", method, exc_info=True)
        return None


def _split_into_runs(messages: Messages, selected: Messages) -> list[Messages]:
    """Split ``selected``, in conversation order, into runs of messages adjacent in ``messages``."""
    runs: list[Messages] = []
    previous_index = -2
    for message in selected:
        index = _index_of(messages, message)
        if index is None:
            continue
        if index == previous_index + 1:
            runs[-1].append(message)
        else:
            runs.append([message])
        previous_index = index
    return runs

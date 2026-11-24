"""Trimming messages from the context window while keeping it valid for the model.

Removing them with their tool pairs, leaving a placeholder for each removed run, and restoring
user/assistant alternation.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, cast

from ..models._model_proxy import ModelProxy
from ..types.content import ContentBlock, Message, MessageMetadata, Messages, Role, _ensure_tracking_id
from ..types.offload import OffloadMethod
from .placeholder import carried_tokens, offload_placeholder
from .types import is_tool_use_block

if TYPE_CHECKING:
    from ..models.model import Model
    from .archive import Archive

logger = logging.getLogger(__name__)


async def removed_tokens(run: Messages, model: Model) -> int:
    """The tokens a run stands for once it is removed.

    Its current content plus what any marker it carries already stood for, so re-removing a marker's carrier
    reports the whole size rather than the marker's own few tokens.

    Counted through :class:`ModelProxy`, so the run is measured as the model receives it rather than with the
    offload bookkeeping a provider's own counting endpoint would reject.
    """
    carried = carried_tokens([block for message in run for block in message["content"]])
    return await ModelProxy(model).count_tokens(run) + carried


def _index_of(messages: Messages, message: Message) -> int | None:
    """The position of ``message`` in ``messages`` by identity, since equal messages are not the same message."""
    return next((index for index, candidate in enumerate(messages) if candidate is message), None)


def _run_start(messages: Messages, run: Messages) -> int | None:
    """The index ``run`` starts at, or None once ``messages`` no longer holds it as a contiguous run.

    A pass awaits between selecting a run and removing it, so the run can be displaced or broken up before the
    removal reaches it. Removing ``len(run)`` messages from a stale start takes messages nobody selected, and those
    are not in the archive entry the run was written to.
    """
    start = _index_of(messages, run[0])
    if start is None:
        return None
    return start if _holds_run(messages, start, run) else None


def _holds_run(messages: Messages, start: int, run: Messages) -> bool:
    """Whether ``messages`` still holds ``run`` as a contiguous run beginning at ``start``, by identity."""
    held = messages[start : start + len(run)]
    return len(held) == len(run) and all(kept is member for kept, member in zip(held, run, strict=True))


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


def new_message(role: Role, content: list[ContentBlock]) -> Message:
    """A message joining the history, with the tracking id an archive ref is keyed by.

    Without one the message shares the fallback key space with every other message that lacks one, so a block
    offloaded from it takes the ref of whatever was stored at that block index first.
    """
    message = Message(role=role, content=content)
    _ensure_tracking_id(message)
    return message


def insert_marker(messages: Messages, index: int, marker: ContentBlock) -> None:
    """Add a marker as assistant content at the gap left by removed messages.

    The marker joins an assistant message beside the gap, before any trailing ``toolUse`` blocks, which keeps that
    message's tracking id for archive refs; otherwise it becomes its own assistant message. It never joins message 0,
    and the last message is never removed, so a new marker never ends the history.
    """
    index = max(1, min(index, len(messages)))
    for neighbor in (index - 1, index):
        if 0 < neighbor < len(messages) and messages[neighbor]["role"] == "assistant":
            carrier = messages[neighbor].copy()
            carrier["content"] = _content_with_marker(carrier["content"], marker)
            messages[neighbor] = carrier
            return
    messages.insert(index, new_message("assistant", [marker]))


def _content_with_marker(content: list[ContentBlock], marker: ContentBlock) -> list[ContentBlock]:
    """The carrier's content with the marker added before any trailing ``toolUse`` blocks.

    Anthropic models with thinking enabled reject a request whose assistant message carries a text block after a
    ``toolUse`` block, as assistant prefill.
    """
    end = len(content)
    while end > 0 and is_tool_use_block(content[end - 1]):
        end -= 1
    return [*content[:end], marker, *content[end:]]


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
    model: Model,
    format_marker: Callable[[int], str],
    method: OffloadMethod,
    archive: Archive | None,
) -> bool:
    """Remove messages with their tool pairs, leaving one ``format_marker(tokens)`` placeholder per contiguous run.

    For the methods that always leave a marker. Summarize drives :func:`_replace_run` itself, since a failed summary
    keeps the run it was called for. Callers restore alternation once they are done.
    """
    acted = False
    # Last run first, so removing a run leaves the earlier runs' positions unchanged.
    for run in reversed(_split_into_runs(messages, with_pairs(messages, to_remove))):
        tokens = await removed_tokens(run, model)
        if await _replace_run(messages, run, format_marker(tokens), tokens, method, archive):
            acted = True
    return acted


async def _replace_run(
    messages: Messages, run: Messages, text: str, tokens: int, method: OffloadMethod, archive: Archive | None
) -> bool:
    """Replace a contiguous run of messages with one placeholder reading ``text``, archived under its own reference.

    A failed archive write leaves the placeholder without a reference, rather than keeping content already accounted
    for.
    """
    archive_ref = await archive_removed(archive, run, method)
    start = _run_start(messages, run)
    if start is None:
        return False
    # Archived before the splice and the marker inserted without an await between: a cancellation here would
    # otherwise leave the run neither in the history nor retrievable.
    del messages[start : start + len(run)]
    insert_marker(messages, start, offload_placeholder(method, text, archive_ref, tokens))
    return True


async def archive_removed(archive: Archive | None, removed: Messages, method: OffloadMethod) -> str | None:
    """The reference a run of removed messages is retrievable under.

    None when there is no archive or the write failed, which leaves the placeholder without a reference rather than
    keeping content the caller has accounted for.
    """
    if archive is None or not removed:
        return None
    try:
        return await archive.store_removed(removed)
    except Exception:
        logger.warning("method=<%s> | failed to archive removed messages", method, exc_info=True)
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

"""Message pinning utilities for protecting messages from context eviction."""

from ....types.content import Message, Messages


def _get_tool_use_ids(message: Message) -> set[str]:
    """Extract toolUseIds from toolUse or toolResult blocks in a message."""
    ids: set[str] = set()
    for content in message.get("content", []):
        if isinstance(content, dict):
            if "toolUse" in content:
                tool_id = content["toolUse"].get("toolUseId")
                if tool_id:
                    ids.add(tool_id)
            elif "toolResult" in content:
                tool_id = content["toolResult"].get("toolUseId")
                if tool_id:
                    ids.add(tool_id)
    return ids


def _has_pinned_flag(message: Message) -> bool:
    """Check if a message has metadata.custom.pinned set to True."""
    metadata = message.get("metadata")
    return metadata is not None and metadata.get("custom", {}).get("pinned") is True


def is_pinned(messages: Messages, index: int) -> bool:
    """Check if a message is pinned, including tool-pair partner protection.

    Returns True if the message at index is pinned, or if its adjacent
    tool-pair partner (toolUse/toolResult matched by toolUseId) is pinned.

    Args:
        messages: The full messages array.
        index: The index to check.

    Returns:
        True if the message or its tool-pair partner is pinned.
    """
    if _has_pinned_flag(messages[index]):
        return True

    # Check if adjacent partner shares a toolUseId and is pinned
    my_ids = _get_tool_use_ids(messages[index])
    if not my_ids:
        return False

    for neighbor_index in (index - 1, index + 1):
        if 0 <= neighbor_index < len(messages):
            neighbor = messages[neighbor_index]
            if _has_pinned_flag(neighbor) and my_ids & _get_tool_use_ids(neighbor):
                return True

    return False


def apply_pin_first(messages: Messages, count: int) -> None:
    """Pin the first N messages in the array permanently.

    Args:
        messages: The messages array.
        count: Number of messages from the start to pin.
    """
    for i in range(min(count, len(messages))):
        pin_message(messages, i)


def partition_pinned(messages: Messages, start: int, end: int) -> tuple[list[Message], list[Message]]:
    """Partition a range of messages into pinned (protected) and unpinned arrays.

    Args:
        messages: The full messages array.
        start: Start index of the range (inclusive).
        end: End index of the range (exclusive).

    Returns:
        A tuple of (pinned, unpinned) message lists.
    """
    pinned: list[Message] = []
    unpinned: list[Message] = []
    for i in range(start, end):
        if is_pinned(messages, i):
            pinned.append(messages[i])
        else:
            unpinned.append(messages[i])
    return pinned, unpinned


def pin_message(messages: Messages, index: int) -> None:
    """Pin a message so it is protected from eviction during context reduction.

    Mutates the message in place by setting metadata.custom.pinned = True.

    Args:
        messages: The messages array.
        index: The index of the message to pin.
    """
    message = messages[index]
    metadata = message.get("metadata", {})
    custom = metadata.get("custom", {})
    custom["pinned"] = True
    metadata["custom"] = custom
    message["metadata"] = metadata


def unpin_message(messages: Messages, index: int) -> None:
    """Unpin a message so it can be evicted during context reduction.

    Mutates the message in place by removing the pinned flag from metadata.

    Args:
        messages: The messages array.
        index: The index of the message to unpin.
    """
    message = messages[index]
    metadata = message.get("metadata")
    if metadata is None:
        return

    custom = metadata.get("custom")
    if custom is None:
        return

    custom.pop("pinned", None)

    if not custom:
        del metadata["custom"]
    if not metadata:
        del message["metadata"]

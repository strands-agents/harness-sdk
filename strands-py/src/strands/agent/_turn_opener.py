"""Marks the user message that opens a turn, so context reduction can keep the request the agent works on."""

from ..types.content import Message, Messages

# The ``metadata.custom`` key set on the user message a caller's prompt became.
TURN_OPENER_KEY = "turn_opener"


def is_turn_opener(message: Message) -> bool:
    """Whether ``message`` is a user message the agent marked as the opener of a turn."""
    metadata = message.get("metadata")
    return metadata is not None and metadata.get("custom", {}).get(TURN_OPENER_KEY) is True


def mark_turn_opener(messages: Messages) -> Messages:
    """``messages`` with the last user message that holds no tool result marked as the turn's opener.

    The marked message is a copy, so a message the caller passed in is left unchanged. Messages the SDK adds later
    in the turn, such as a structured output prompt, are not marked, and per-call injected text never enters the
    history, so the mark always names the caller's request.
    """
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        if message["role"] == "user" and not any("toolResult" in block for block in message["content"]):
            metadata = message.get("metadata", {})
            marked = Message(**message)
            marked["metadata"] = {**metadata, "custom": {**metadata.get("custom", {}), TURN_OPENER_KEY: True}}
            return [*messages[:index], marked, *messages[index + 1 :]]
    return messages

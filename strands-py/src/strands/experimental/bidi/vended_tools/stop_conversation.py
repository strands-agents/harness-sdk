"""Tool to gracefully stop a bidirectional connection."""

from ....tools.decorator import tool


@tool
def stop_conversation() -> str:
    """Stop the bidirectional conversation gracefully.

    Use ONLY when user says "stop conversation" exactly.
    Do NOT use for: "stop", "goodbye", "bye", "exit", "quit", "end" or other farewells or phrases.

    Returns:
        Success message confirming the conversation will end.
    """
    return "Ending conversation"

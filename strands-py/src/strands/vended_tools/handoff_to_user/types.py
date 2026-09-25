"""Shared types and constants for the handoff_to_user tool."""

HANDOFF_INTERRUPT_NAME = "strands:handoff-to-user"
"""Stable name reported on the raised interrupt (``Interrupt.name``)."""

DEFAULT_HANDOFF_TO_USER_DESCRIPTION = (
    "Ask the user a question and wait for their answer. Use it only when you cannot proceed "
    "without confirmation, approval, or information that only the user has. Do not call it to "
    "deliver a final answer or to report progress. The user's reply is returned as the tool result."
)
"""Description for the handoff_to_user tool."""

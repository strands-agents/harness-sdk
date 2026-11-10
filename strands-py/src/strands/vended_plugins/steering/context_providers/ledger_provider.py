"""Ledger context provider for comprehensive agent activity tracking.

Tracks complete agent activity ledger including tool calls, conversation history,
and timing information. This comprehensive audit trail enables steering handlers
to make informed guidance decisions based on agent behavior patterns and history.

Data captured:

    - Tool call history with inputs, outputs, timing, success/failure
    - Conversation messages and agent responses
    - Session metadata and timing information
    - Error patterns and recovery attempts

Usage:
    Use as context provider functions or mix into steering handlers.
"""

import logging
from datetime import datetime
from typing import Any

from ....hooks.events import AfterToolCallEvent, BeforeToolCallEvent
from ..core.context import SteeringContext, SteeringContextCallback, SteeringContextProvider

logger = logging.getLogger(__name__)


class LedgerBeforeToolCall(SteeringContextCallback[BeforeToolCallEvent]):
    """Context provider for ledger tracking before tool calls."""

    def __init__(self) -> None:
        """Initialize the ledger provider."""
        self.session_start = datetime.now().isoformat()

    def __call__(self, event: BeforeToolCallEvent, steering_context: SteeringContext, **kwargs: Any) -> None:
        """Update ledger before tool call."""
        ledger = steering_context.data.get("ledger") or {}

        if not ledger:
            ledger = {
                "session_start": self.session_start,
                "tool_calls": [],
                "conversation_history": [],
                "session_metadata": {},
            }

        tool_call_entry = {
            "timestamp": datetime.now().isoformat(),
            "tool_use_id": event.tool_use.get("toolUseId"),
            "tool_name": event.tool_use.get("name"),
            "tool_args": event.tool_use.get("input", {}),
            "status": "pending",
        }
        ledger["tool_calls"].append(tool_call_entry)
        steering_context.data.set("ledger", ledger)


class LedgerAfterToolCall(SteeringContextCallback[AfterToolCallEvent]):
    """Context provider for ledger tracking after tool calls."""

    def __call__(self, event: AfterToolCallEvent, steering_context: SteeringContext, **kwargs: Any) -> None:
        """Update ledger after tool call."""
        ledger = steering_context.data.get("ledger") or {}

        if ledger.get("tool_calls"):
            tool_use_id = event.tool_use.get("toolUseId")

            # Search for the matching tool call in the ledger to update it
            for call in reversed(ledger["tool_calls"]):
                if call.get("tool_use_id") == tool_use_id and call.get("status") == "pending":
                    call.update(
                        {
                            "completion_timestamp": datetime.now().isoformat(),
                            "status": event.result["status"],
                            "result": event.result["content"],
                            "error": str(event.exception) if event.exception else None,
                        }
                    )
                    steering_context.data.set("ledger", ledger)
                    break


class LedgerProvider(SteeringContextProvider):
    """Combined ledger context provider for both before and after tool calls."""

    def context_providers(self, **kwargs: Any) -> list[SteeringContextCallback]:
        """Return ledger context providers with shared state."""
        return [
            LedgerBeforeToolCall(),
            LedgerAfterToolCall(),
        ]

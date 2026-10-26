"""Wrapper for streaming agents inside tool calls.

Provides common functionality for streaming child agents inside a parent agent's tool calls. This includes
session persistence (via the parent agent's interrupt context), interrupt response forwarding, event conversion,
and cancellation support. These features are implemented around stream calls and not within them
because they require knowledge of the parent agent.
"""

from __future__ import annotations

import copy
import logging
from collections.abc import AsyncIterator, Callable
from typing import TYPE_CHECKING, Any, Protocol, cast
from urllib.parse import quote

from ..interrupt import Interrupt, _InterruptState
from ..types._events import ToolInterruptEvent, ToolResultEvent
from ..types._snapshot import Snapshot
from ..types.event_loop import _LIMIT_STOP_REASONS, _limit_stop_message
from ..types.tools import ToolResultContent, ToolUse
from ._snapshot import load_snapshot, take_snapshot
from .base import MultiAgentBase, Status

if TYPE_CHECKING:
    from ..agent.agent import Agent
    from ..types.interrupt import InterruptResponseContent

logger = logging.getLogger(__name__)

_RESPONSES_KEY = "responses"
_INTERRUPTED_TURNS_KEY = "sub_agent_interrupted_turns"


class _ChildAdapter(Protocol):
    """Provides persistence, interrupt, and result handling that differs between child agent types."""

    label: str
    """Model-facing name of the child, used in terminal error messages."""

    def take_snapshot(self, child: Any) -> Snapshot:
        """Capture snapshot needed to resume the child invocation."""
        ...

    def restore(self, child: Any, snapshot: Snapshot | None) -> bool:
        """Restore snapshot and report whether it awaits interrupt responses."""
        ...

    def classify(self, child: Any, result: Any) -> list[Interrupt] | str | None:
        """Return interrupts, a failure message, or None for a successful result."""
        ...

    def pending_interrupt_ids(self, turn: Any) -> set[str]:
        """Return the interrupt ids a stored turn awaits, without restoring a child."""
        ...


class _ChildAgentAdapter:
    """Adapts an agent child to the tool streamer interface."""

    def __init__(self, *, label: str, agent_name: str) -> None:
        self.label = label
        self.agent_name = agent_name

    def take_snapshot(self, child: Agent) -> Snapshot:
        return child.take_snapshot(preset="session")

    def restore(self, child: Agent, snapshot: Snapshot | None) -> bool:
        if snapshot is not None:
            child.load_snapshot(snapshot)
        return child._interrupt_state.activated

    def classify(self, child: Agent, result: Any) -> list[Interrupt] | str | None:
        if result.stop_reason == "interrupt" and result.interrupts:
            return list(result.interrupts)
        if result.stop_reason == "cancelled" and child.cancel_signal.is_set():
            return f"{self.label} cancelled"
        if result.stop_reason in _LIMIT_STOP_REASONS:
            return _limit_stop_message(self.agent_name, result.stop_reason)
        return None

    def pending_interrupt_ids(self, turn: Any) -> set[str]:
        return set(_InterruptState.from_dict(turn["data"]["interrupt_state"]).interrupts)


class _ChildMultiAgentAdapter:
    """Adapts a multi-agent child to the tool streamer interface."""

    def __init__(self, *, label: str) -> None:
        self.label = label

    def take_snapshot(self, child: MultiAgentBase) -> Snapshot:
        return take_snapshot(child)

    def restore(self, child: MultiAgentBase, snapshot: Snapshot | None) -> bool:
        if snapshot is not None:
            load_snapshot(child, snapshot)
        interrupt_state = cast(_InterruptState, cast(Any, child)._interrupt_state)
        return interrupt_state.activated

    def classify(self, child: MultiAgentBase, result: Any) -> list[Interrupt] | str | None:
        """Classify a MultiAgentResult."""
        if result.status is Status.INTERRUPTED and result.interrupts:
            return list(result.interrupts)
        if result.status is not Status.COMPLETED:
            return (
                f"{self.label} stopped before completing (status={result.status.value}, "
                f"{result.execution_count} iterations). Partial output:\n{result}"
            )
        return None

    def pending_interrupt_ids(self, turn: Any) -> set[str]:
        interrupt_state = turn["data"]["state"]["_internal_state"]["interrupt_state"]
        return set(_InterruptState.from_dict(interrupt_state).interrupts)


class _AgentToolStreamer:
    """Stream a child invocation through the parent tool lifecycle."""

    def __init__(
        self,
        *,
        interrupt_state: _InterruptState | None,
        tool_use_id: str,
        namespace: str,
        persist_interrupted_turn: bool = True,
    ) -> None:
        """Initialize tool-stream state for one child invocation."""
        self._interrupt_state = interrupt_state
        self._tool_use_id = tool_use_id
        self._prefix = f"{namespace}:{quote(tool_use_id, safe='')}:"
        self._persist_interrupted_turn = persist_interrupted_turn
        self.result: Any | None = None
        self.interrupts: list[Interrupt] | None = None
        self.error: str | None = None
        self._outcome: list[Interrupt] | str | None = None

    async def stream(
        self,
        adapter: _ChildAdapter,
        child: Any,
        events: AsyncIterator[dict[str, Any]],
    ) -> AsyncIterator[dict[str, Any]]:
        """Yield child progress events and retain terminal state for the tool."""
        async for event in events:
            if "result" in event:
                self.result = event["result"]
                self._outcome = adapter.classify(child, self.result)
                continue
            yield event

        if self.result is None:
            self.error = f"{adapter.label} did not produce a result."
            return

        outcome = self._outcome
        if isinstance(outcome, list):
            # Without a parent interrupt state there is nothing to resume against, so ids pass through raw.
            if self._interrupt_state is not None:
                if self._persist_interrupted_turn:
                    turns = self._interrupt_state.context.setdefault(_INTERRUPTED_TURNS_KEY, {})
                    turns[self._tool_use_id] = copy.deepcopy(adapter.take_snapshot(child).to_dict())
                    self._interrupt_state._version += 1
                outcome = [
                    Interrupt(f"{self._prefix}{interrupt.id}", interrupt.name, interrupt.reason)
                    for interrupt in outcome
                ]
            self.interrupts = outcome
            return

        if self._interrupt_state is not None:
            self._clear_interrupted_turn()
        self.error = outcome

    def terminal_event(
        self,
        tool_use: ToolUse,
        render_success: Callable[[Any], list[ToolResultContent]] | None = None,
    ) -> ToolInterruptEvent | ToolResultEvent:
        """Return the terminal tool event for the child invocation."""
        if self.interrupts is not None:
            return ToolInterruptEvent(tool_use, self.interrupts)
        if self.error is not None:
            return ToolResultEvent(
                {
                    "toolUseId": tool_use["toolUseId"],
                    "status": "error",
                    "content": [{"text": self.error}],
                }
            )
        return ToolResultEvent(
            {
                "toolUseId": tool_use["toolUseId"],
                "status": "success",
                "content": [{"text": str(self.result)}] if render_success is None else render_success(self.result),
            }
        )

    def is_resuming(self) -> bool:
        """Return whether this tool call has a child turn to resume."""
        return (
            self._interrupt_state is not None
            and self._interrupt_state.activated
            and any(interrupt_id.startswith(self._prefix) for interrupt_id in self._interrupt_state.interrupts)
        )

    def resume(
        self,
        adapter: _ChildAdapter,
        child: Any | None,
        unavailable_message: str,
    ) -> list[InterruptResponseContent] | None:
        """Restore the child invocation and return its scoped interrupt responses.

        A ``None`` child (it could not be rebuilt) is handled like a failed restore.
        """
        if not self.is_resuming():
            return None
        assert self._interrupt_state is not None

        if child is None:
            self._handle_failed_restore(adapter, unavailable_message)
            return None
        turns = self._interrupt_state.context.get(_INTERRUPTED_TURNS_KEY) or {}
        turn = turns.get(self._tool_use_id)
        try:
            snapshot = Snapshot.from_dict(turn) if turn is not None else None
            awaiting_responses = adapter.restore(child, snapshot)
        except Exception as error:
            logger.error(
                "tool_use_id=<%s>, error=<%s> | failed to restore interrupted sub-agent turn",
                self._tool_use_id,
                error,
            )
            self._handle_failed_restore(adapter, unavailable_message)
            return None

        if turn is not None:
            self._clear_interrupted_turn()
        if not awaiting_responses:
            logger.error("tool_use_id=<%s> | cannot resume: the sub-agent turn is not available", self._tool_use_id)
            self.error = unavailable_message
            return None
        return [
            {
                "interruptResponse": {
                    "interruptId": response["interruptResponse"]["interruptId"][len(self._prefix) :],
                    "response": response["interruptResponse"]["response"],
                }
            }
            for response in self._interrupt_state.context.get(_RESPONSES_KEY) or []
            if response["interruptResponse"]["interruptId"].startswith(self._prefix)
        ]

    def _handle_failed_restore(self, adapter: _ChildAdapter, unavailable_message: str) -> None:
        """Re-raise pending interrupts when the child state cannot be restored."""
        assert self._interrupt_state is not None
        # Get all pending interrupt ids for this agent
        turn = (self._interrupt_state.context.get(_INTERRUPTED_TURNS_KEY) or {}).get(self._tool_use_id)
        try:
            pending = adapter.pending_interrupt_ids(turn)
        except Exception:
            logger.error("tool_use_id=<%s> | stored turn has no readable interrupt state", self._tool_use_id)
            self.error = unavailable_message
            return
        # Map interrupt ids to parent interrupts
        self.interrupts = [
            interrupt
            for interrupt_id, interrupt in self._interrupt_state.interrupts.items()
            if interrupt_id.startswith(self._prefix) and interrupt_id[len(self._prefix) :] in pending
        ]
        if not self.interrupts:
            self.interrupts = None
            self.error = unavailable_message
            return
        # Empty responses so that this agent's interrupts remain on parent's interrupt state
        for interrupt in self.interrupts:
            interrupt.response = None

    def _clear_interrupted_turn(self) -> None:
        """Discard stored child state after a non-interrupt terminal result."""
        if self._interrupt_state is None:
            return
        turns = self._interrupt_state.context.get(_INTERRUPTED_TURNS_KEY)
        if not isinstance(turns, dict) or turns.pop(self._tool_use_id, None) is None:
            return
        self._interrupt_state._version += 1

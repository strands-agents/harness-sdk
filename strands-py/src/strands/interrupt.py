"""Human-in-the-loop interrupt system for agent workflows."""

import copy
import logging
from dataclasses import asdict, dataclass, field
from typing import TYPE_CHECKING, Any, cast
from urllib.parse import quote

if TYPE_CHECKING:
    from .agent import Agent
    from .types._events import ToolInterruptEvent, ToolResultEvent
    from .types.agent import AgentInput
    from .types.content import Message
    from .types.interrupt import InterruptResponseContent
    from .types.tools import ToolResult, ToolUse

logger = logging.getLogger(__name__)

_AGENT_STREAM_INTERRUPT_ID_PREFIX = "v1:middleware_agent_stream:"
"""Id prefix for interrupts scoped to a whole invocation pass rather than a single tool call."""

_RESPONSES_KEY = "responses"
"""Key in ``_InterruptState.context`` holding the responses supplied on the current resume."""


@dataclass
class Interrupt:
    """Represents an interrupt that can pause agent execution for human-in-the-loop workflows.

    Attributes:
        id: Unique identifier. Treat as opaque: pass it back to resume the agent, do not parse or
            construct it.
        name: User defined name.
        reason: User provided reason for raising the interrupt.
        response: Human response provided when resuming the agent after an interrupt.
    """

    id: str
    name: str
    reason: Any = None
    response: Any = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize to dict for session management."""
        return asdict(self)


class InterruptException(Exception):
    """Exception raised when human input is required."""

    def __init__(self, interrupt: Interrupt) -> None:
        """Set the interrupt."""
        self.interrupt = interrupt


@dataclass
class PendingToolExecution:
    """State required to resume tool execution without calling the model again.

    Attributes:
        assistant_message: Assistant message containing the pending tool uses.
        completed_tool_results: Results completed or synthesized during the interrupted execution.
    """

    assistant_message: "Message"
    completed_tool_results: list["ToolResult"]


@dataclass
class _InterruptState:
    """Track the state of interrupt events raised by the user.

    Note, unanswered interrupts are cleared after resuming; an answered invocation-scoped response
    is retained for the rest of its interrupt cycle.

    Attributes:
        interrupts: Interrupts raised by the user. May be non-empty even when ``activated`` is
            False because retained responses persist until their cycle ends.
        context: Additional context associated with an interrupt event.
        activated: True if agent is in an interrupt state, False otherwise.
        pending_tool_execution: State required to resume an interrupted tool execution.
    """

    interrupts: dict[str, Interrupt] = field(default_factory=dict)
    context: dict[str, Any] = field(default_factory=dict)
    activated: bool = False
    pending_tool_execution: PendingToolExecution | None = None
    _version: int = field(default=0, compare=False, repr=False)

    def activate(self) -> None:
        """Activate the interrupt state."""
        self.activated = True
        self._version += 1

    def deactivate(self) -> None:
        """Deactivate the interrupt state.

        Interrupts, context, and pending tool execution are cleared.
        """
        self.interrupts = {}
        self.context = {}
        self.activated = False
        self.pending_tool_execution = None
        self._version += 1

    def end_tool_cycle(self) -> None:
        """Clear a completed tool cycle's state, keeping answered invocation-scoped responses."""
        self.interrupts = {
            interrupt_id: interrupt
            for interrupt_id, interrupt in self.interrupts.items()
            if interrupt_id.startswith(_AGENT_STREAM_INTERRUPT_ID_PREFIX) and interrupt.response is not None
        }
        self.context = {}
        self.activated = False
        self.pending_tool_execution = None
        self._version += 1

    def end_interrupt_cycle(self) -> None:
        """Release invocation-scoped interrupts once their interrupt cycle is over."""
        remaining = {
            interrupt_id: interrupt
            for interrupt_id, interrupt in self.interrupts.items()
            if not interrupt_id.startswith(_AGENT_STREAM_INTERRUPT_ID_PREFIX)
        }
        if remaining == self.interrupts:
            return

        self.interrupts = remaining
        self._version += 1

    def resume(self, prompt: "AgentInput") -> None:
        """Configure the interrupt state if resuming from an interrupt event.

        Args:
            prompt: User responses if resuming from interrupt.

        Raises:
            TypeError: If in interrupt state but user did not provide responses.
        """
        if not self.activated:
            return

        if not isinstance(prompt, list):
            raise TypeError(f"prompt_type={type(prompt)} | must resume from interrupt with list of interruptResponse's")

        invalid_types = [
            content_type for content in prompt for content_type in content if content_type != "interruptResponse"
        ]
        if invalid_types:
            raise TypeError(
                f"content_types=<{invalid_types}> | must resume from interrupt with list of interruptResponse's"
            )

        contents = cast(list["InterruptResponseContent"], prompt)
        for content in contents:
            interrupt_id = content["interruptResponse"]["interruptId"]
            interrupt_response = content["interruptResponse"]["response"]

            if interrupt_id not in self.interrupts:
                raise KeyError(f"interrupt_id=<{interrupt_id}> | no interrupt found")

            self.interrupts[interrupt_id].response = interrupt_response

        self.context[_RESPONSES_KEY] = contents
        self._version += 1

    def set_pending_tool_results(self, completed_tool_results: list["ToolResult"]) -> None:
        """Update completed results for a pending tool execution."""
        if self.pending_tool_execution is None:
            return

        self.pending_tool_execution.completed_tool_results = completed_tool_results
        self._version += 1

    def _get_version(self) -> int:
        """Get the current version number of the interrupt state.

        The version is incremented each time the state is mutated — activate(), deactivate(),
        resume(), set_pending_tool_results(), end_tool_cycle(), or end_interrupt_cycle().
        Consumers can compare versions to detect changes without requiring
        explicit dirty flag clearing.

        Returns:
            The current version number.
        """
        return self._version

    def to_dict(self) -> dict[str, Any]:
        """Serialize to dict for session management.

        Exclude deactivated invocation-scoped responses — persisting them would
        give a restored agent a standing approval.
        """
        interrupts = self.interrupts
        if not self.activated:
            interrupts = {
                interrupt_id: interrupt
                for interrupt_id, interrupt in interrupts.items()
                if not interrupt_id.startswith(_AGENT_STREAM_INTERRUPT_ID_PREFIX)
            }

        data: dict[str, Any] = {
            "interrupts": {k: v.to_dict() for k, v in interrupts.items()},
            "context": self.context,
            "activated": self.activated,
        }
        if self.pending_tool_execution is not None:
            data["pending_tool_execution"] = asdict(self.pending_tool_execution)
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "_InterruptState":
        """Initialize interrupt state from serialized interrupt state.

        Interrupt state can be serialized with the `to_dict` method. Legacy tool execution context
        is migrated into the typed pending state.
        """
        activated = data["activated"]
        context: dict[str, Any] = data["context"].copy()
        pending_tool_execution_data = data.get("pending_tool_execution")
        legacy_tool_use_message = context.pop("tool_use_message", None)
        legacy_tool_results = context.pop("tool_results", []) if legacy_tool_use_message is not None else []

        pending_tool_execution: PendingToolExecution | None
        if pending_tool_execution_data is not None:
            try:
                pending_tool_execution = PendingToolExecution(**pending_tool_execution_data)
            except TypeError as error:
                # Avoid importing the types package while this module is still initializing.
                from .types.exceptions import SessionException

                raise SessionException(f"Failed to restore pending tool execution state: {error}") from error
        elif legacy_tool_use_message is not None:
            pending_tool_execution = PendingToolExecution(
                assistant_message=cast("Message", legacy_tool_use_message),
                completed_tool_results=cast(list["ToolResult"], legacy_tool_results),
            )
        else:
            pending_tool_execution = None

        return cls(
            interrupts={
                interrupt_id: Interrupt(**interrupt_data)
                for interrupt_id, interrupt_data in data["interrupts"].items()
                # Mirror to_dict's filter — don't revive a stale response as a standing approval.
                if activated or not interrupt_id.startswith(_AGENT_STREAM_INTERRUPT_ID_PREFIX)
            },
            context=context,
            activated=activated,
            pending_tool_execution=pending_tool_execution,
        )


class _NestedInterruptState:
    """Persist a nested agent's interrupted turn in its parent's interrupt state, scoped to one tool call."""

    def __init__(self, state: _InterruptState, key: str, namespace: str, tool_use_id: str) -> None:
        """Initialize the state.

        Args:
            state: The parent's interrupt state.
            key: Key in ``state.context`` the interrupted turns are stored under.
            namespace: Tool-specific id namespace, e.g. ``v1:subagent``.
            tool_use_id: Id of the tool call that runs the nested agent.
        """
        self._state = state
        self._key = key
        self._tool_use_id = tool_use_id
        self.prefix = f"{namespace}:{quote(tool_use_id, safe='')}:"

    def is_resuming(self) -> bool:
        """Whether the parent is holding an interrupt raised by this tool call."""
        return self._state.activated and any(i.startswith(self.prefix) for i in self._state.interrupts)

    def store(self, agent: "Agent", interrupts: list[Interrupt]) -> list[Interrupt]:
        """Store the agent's interrupted turn.

        Args:
            agent: The interrupted nested agent.
            interrupts: The interrupts the agent stopped on.

        Returns:
            The parent-scoped interrupts to raise.
        """
        turns = self._state.context.setdefault(self._key, {})
        # The snapshot's interrupt state holds the agent's live context, so copy it to detach the stored turn.
        turns[self._tool_use_id] = copy.deepcopy(agent.take_snapshot(preset="session").to_dict())
        self._state._version += 1
        return [Interrupt(f"{self.prefix}{i.id}", i.name, i.reason) for i in interrupts]

    def resume(
        self, agent: "Agent | None", tool_use: "ToolUse", unavailable_message: str
    ) -> "list[InterruptResponseContent] | ToolInterruptEvent | ToolResultEvent":
        """Restore the stored turn, if any, and map this call's responses back to the nested agent's ids.

        Args:
            agent: The nested agent to resume, or None if it could not be built.
            tool_use: The tool call that runs the nested agent.
            unavailable_message: Error text for the tool result when there is no turn to resume.

        Returns:
            The responses to resume the nested agent with; otherwise the interrupts to raise again if the turn
            could not be loaded, or an error result if there is no turn to resume.
        """
        # Importing here to avoid circular import
        from .types._events import ToolResultEvent
        from .types._snapshot import Snapshot

        unavailable = ToolResultEvent(
            {"toolUseId": tool_use["toolUseId"], "status": "error", "content": [{"text": unavailable_message}]}
        )
        if agent is None:
            return self._reraise(tool_use) or unavailable
        turns = self._state.context.get(self._key) or {}
        turn = turns.get(self._tool_use_id)
        try:
            if turn is not None:
                agent.load_snapshot(Snapshot.from_dict(turn))
        except Exception as error:
            logger.error(
                "tool_use_id=<%s>, error=<%s> | failed to restore interrupted sub-agent turn", self._tool_use_id, error
            )
            return self._reraise(tool_use) or unavailable

        if turns.pop(self._tool_use_id, None) is not None:
            self._state._version += 1
        if not agent._interrupt_state.activated:
            logger.error("tool_use_id=<%s> | cannot resume: the nested agent turn is not available", self._tool_use_id)
            return unavailable
        return [
            {
                "interruptResponse": {
                    "interruptId": response["interruptResponse"]["interruptId"][len(self.prefix) :],
                    "response": response["interruptResponse"]["response"],
                }
            }
            for response in self._state.context.get(_RESPONSES_KEY) or []
            if response["interruptResponse"]["interruptId"].startswith(self.prefix)
        ]

    def _reraise(self, tool_use: "ToolUse") -> "ToolInterruptEvent | None":
        """Raise the stored turn's still-awaited interrupts again, keeping the turn for a later attempt.

        Returns:
            The interrupts to raise again, or None if the stored turn has no readable interrupt state.
        """
        from .types._events import ToolInterruptEvent

        turn = (self._state.context.get(self._key) or {}).get(self._tool_use_id)
        try:
            # Read the raw dict rather than Snapshot.from_dict, since the turn may be stored but fail validation.
            awaited = _InterruptState.from_dict(turn["data"]["interrupt_state"]).interrupts  # type: ignore[index]
        except Exception:
            logger.error("tool_use_id=<%s> | stored turn has no readable interrupt state", self._tool_use_id)
            return None
        pending = [
            interrupt
            for interrupt_id, interrupt in self._state.interrupts.items()
            if interrupt_id.startswith(self.prefix) and interrupt_id[len(self.prefix) :] in awaited
        ]
        if not pending:
            return None
        for interrupt in pending:
            interrupt.response = None
        return ToolInterruptEvent(tool_use, pending)

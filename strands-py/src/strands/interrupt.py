"""Human-in-the-loop interrupt system for agent workflows."""

import logging
from dataclasses import asdict, dataclass, field
from typing import TYPE_CHECKING, Any, cast

if TYPE_CHECKING:
    from .types.agent import AgentInput
    from .types.content import Message
    from .types.interrupt import InterruptResponseContent
    from .types.tools import ToolResult

logger = logging.getLogger(__name__)

_AGENT_STREAM_INTERRUPT_ID_PREFIX = "v1:middleware_agent_stream:"
"""Id prefix for interrupts scoped to a whole invocation pass rather than a single tool call."""


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

        self.context["responses"] = contents
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

        if pending_tool_execution_data is None and legacy_tool_use_message is not None:
            pending_tool_execution_data = {
                "assistant_message": legacy_tool_use_message,
                "completed_tool_results": legacy_tool_results,
            }

        # Only an activated state replays a pending execution; a stale one is dropped rather than restored.
        pending_tool_execution: PendingToolExecution | None = None
        if activated and pending_tool_execution_data is not None:
            pending_tool_execution = _restore_pending_tool_execution(pending_tool_execution_data)

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


def _restore_pending_tool_execution(data: dict[str, Any]) -> PendingToolExecution | None:
    """Rebuild a pending tool execution from session data.

    Malformed data raises ``SessionException`` naming the field. Well-formed data the event loop could not replay
    (no tool uses, or a result for an unknown tool use) is dropped with a warning instead, so a persisted session
    stays loadable and the next invocation calls the model again.
    """
    # Avoid importing the types package while this module is still initializing.
    from .types.exceptions import SessionException

    try:
        pending = PendingToolExecution(**data)
    except TypeError as error:
        raise SessionException(
            f"field=<pending_tool_execution> | failed to restore pending tool execution state: {error}"
        ) from error

    message = pending.assistant_message
    if not isinstance(message, dict) or not isinstance(message.get("content"), list):
        raise SessionException(
            "field=<pending_tool_execution.assistant_message> | failed to parse restored pending tool execution"
        )
    if message.get("role") != "assistant":
        raise SessionException(
            "field=<pending_tool_execution.assistant_message.role> | pending tool execution message must be an "
            "assistant message"
        )

    tool_use_ids = {
        block["toolUse"]["toolUseId"]
        for block in message["content"]
        if isinstance(block, dict) and isinstance(block.get("toolUse"), dict) and "toolUseId" in block["toolUse"]
    }
    if not tool_use_ids:
        logger.warning(
            "field=<pending_tool_execution.assistant_message.content> | pending tool execution message has no tool "
            "uses, dropping it"
        )
        return None

    if not isinstance(pending.completed_tool_results, list):
        raise SessionException(
            "field=<pending_tool_execution.completed_tool_results> | completed tool results must be a list"
        )
    for result in pending.completed_tool_results:
        tool_use_id = result.get("toolUseId") if isinstance(result, dict) else None
        field_name = f"field=<pending_tool_execution.completed_tool_results>, tool_use_id=<{tool_use_id}>"
        if not isinstance(result, dict):
            raise SessionException(f"{field_name} | failed to parse restored pending tool execution")
        if "status" not in result:
            raise SessionException(f"{field_name} | completed tool result has no status")
        if not isinstance(result.get("content"), list):
            raise SessionException(f"{field_name} | completed tool result content must be a list")
        if tool_use_id not in tool_use_ids:
            logger.warning("%s | does not match a tool use in the pending assistant message, dropping it", field_name)
            return None

    return pending

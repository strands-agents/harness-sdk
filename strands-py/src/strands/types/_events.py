"""event system for the Strands Agents framework.

This module defines the event types that are emitted during agent execution,
providing a structured way to observe to different events of the event loop and
agent lifecycle.
"""

from collections.abc import Sequence
from typing import TYPE_CHECKING, Any, cast

from pydantic import BaseModel
from typing_extensions import override

from ..interrupt import Interrupt
from ..telemetry import EventLoopMetrics
from .citations import Citation
from .content import Message
from .event_loop import Metrics, StopReason, Usage
from .streaming import ContentBlockDelta, StreamEvent
from .tools import ToolResult, ToolUse

if TYPE_CHECKING:
    from ..agent import AgentResult
    from ..agent._agent_as_tool import _AgentAsTool
    from ..experimental.checkpoint import Checkpoint
    from ..multiagent.base import MultiAgentResult, NodeResult


class TypedEvent(dict):
    """Base class for all typed events in the agent system."""

    def __init__(self, data: dict[str, Any] | None = None) -> None:
        """Initialize the typed event with optional data.

        Args:
            data: Optional dictionary of event data to initialize with
        """
        super().__init__(data or {})

    @property
    def is_callback_event(self) -> bool:
        """True if this event should trigger the callback_handler to fire."""
        return True

    def as_dict(self) -> dict:
        """Convert this event to a raw dictionary for emitting purposes."""
        return {**self}

    def prepare(self, invocation_state: dict) -> None:
        """Prepare the event for emission by adding invocation state.

        This allows a subset of events to merge with the invocation_state without needing to
        pass around the invocation_state throughout the system.
        """
        ...


class InitEventLoopEvent(TypedEvent):
    """Event emitted at the very beginning of agent execution.

    This event is fired before any processing begins and provides access to the
    initial invocation state.

    Args:
            invocation_state: The invocation state passed into the request
    """

    def __init__(self) -> None:
        """Initialize the event loop initialization event."""
        super().__init__({"init_event_loop": True})

    @override
    def prepare(self, invocation_state: dict) -> None:
        self.update(invocation_state)


class StartEvent(TypedEvent):
    """Event emitted at the start of each event loop cycle.

    !!deprecated!!
        Use StartEventLoopEvent instead.

    This event events the beginning of a new processing cycle within the agent's
    event loop. It's fired before model invocation and tool execution begin.
    """

    def __init__(self) -> None:
        """Initialize the event loop start event."""
        super().__init__({"start": True})


class StartEventLoopEvent(TypedEvent):
    """Event emitted when the event loop cycle begins processing.

    This event is fired after StartEvent and indicates that the event loop
    has begun its core processing logic, including model invocation preparation.
    """

    def __init__(self) -> None:
        """Initialize the event loop processing start event."""
        super().__init__({"start_event_loop": True})


class ModelStreamChunkEvent(TypedEvent):
    """Event emitted during model response streaming for each raw chunk."""

    def __init__(self, chunk: StreamEvent) -> None:
        """Initialize with streaming delta data from the model.

        Args:
            chunk: Incremental streaming data from the model response
        """
        super().__init__({"event": chunk})

    @property
    def chunk(self) -> StreamEvent:
        return cast(StreamEvent, self.get("event"))


class ModelStreamEvent(TypedEvent):
    """Event emitted during model response streaming.

    This event is fired when the model produces streaming output during response
    generation.
    """

    def __init__(self, delta_data: dict[str, Any]) -> None:
        """Initialize with streaming delta data from the model.

        Args:
            delta_data: Incremental streaming data from the model response
        """
        super().__init__(delta_data)

    @property
    def is_callback_event(self) -> bool:
        # Only invoke a callback if we're non-empty
        return len(self.keys()) > 0

    @override
    def prepare(self, invocation_state: dict) -> None:
        if "delta" in self:
            self.update(invocation_state)


class ToolUseStreamEvent(ModelStreamEvent):
    """Event emitted during tool use input streaming."""

    def __init__(self, delta: ContentBlockDelta, current_tool_use: dict[str, Any]) -> None:
        """Initialize with delta and current tool use state."""
        super().__init__({"type": "tool_use_stream", "delta": delta, "current_tool_use": current_tool_use})


class TextStreamEvent(ModelStreamEvent):
    """Event emitted during text content streaming."""

    def __init__(self, delta: ContentBlockDelta, text: str) -> None:
        """Initialize with delta and text content."""
        super().__init__({"data": text, "delta": delta})


class CitationStreamEvent(ModelStreamEvent):
    """Event emitted during citation streaming."""

    def __init__(self, delta: ContentBlockDelta, citation: Citation) -> None:
        """Initialize with delta and citation content."""
        super().__init__({"citation": citation, "delta": delta})


class ReasoningTextStreamEvent(ModelStreamEvent):
    """Event emitted during reasoning text streaming."""

    def __init__(self, delta: ContentBlockDelta, reasoning_text: str | None) -> None:
        """Initialize with delta and reasoning text."""
        super().__init__({"reasoningText": reasoning_text, "delta": delta, "reasoning": True})


class ReasoningRedactedContentStreamEvent(ModelStreamEvent):
    """Event emitted during redacted content streaming."""

    def __init__(self, delta: ContentBlockDelta, redacted_content: bytes | None) -> None:
        """Initialize with delta and redacted content."""
        super().__init__({"reasoningRedactedContent": redacted_content, "delta": delta, "reasoning": True})


class ReasoningSignatureStreamEvent(ModelStreamEvent):
    """Event emitted during reasoning signature streaming."""

    def __init__(self, delta: ContentBlockDelta, reasoning_signature: str | None) -> None:
        """Initialize with delta and reasoning signature."""
        super().__init__({"reasoning_signature": reasoning_signature, "delta": delta, "reasoning": True})


class ModelStopReason(TypedEvent):
    """Event emitted during reasoning signature streaming."""

    def __init__(
        self,
        stop_reason: StopReason,
        message: Message,
        usage: Usage,
        metrics: Metrics,
    ) -> None:
        """Initialize with the final execution results.

        Args:
            stop_reason: Why the agent execution stopped
            message: Final message from the model
            usage: Usage information from the model
            metrics: Execution metrics and performance data
        """
        super().__init__({"stop": (stop_reason, message, usage, metrics)})

    @property
    @override
    def is_callback_event(self) -> bool:
        return False


class EventLoopStopEvent(TypedEvent):
    """Event emitted when the agent execution completes normally."""

    def __init__(
        self,
        stop_reason: StopReason,
        message: Message,
        metrics: "EventLoopMetrics",
        request_state: Any,
        interrupts: Sequence[Interrupt] | None = None,
        structured_output: BaseModel | None = None,
        checkpoint: "Checkpoint | None" = None,
    ) -> None:
        """Initialize with the final execution results.

        Args:
            stop_reason: Why the agent execution stopped
            message: Final message from the model
            metrics: Execution metrics and performance data
            request_state: Final state of the agent execution
            interrupts: Interrupts raised by user during agent execution.
            structured_output: Optional structured output result
            checkpoint: Optional checkpoint when stop_reason == "checkpoint".
        """
        super().__init__(
            {"stop": (stop_reason, message, metrics, request_state, interrupts, structured_output, checkpoint)}
        )

    @property
    @override
    def is_callback_event(self) -> bool:
        return False


class StructuredOutputEvent(TypedEvent):
    """Event emitted when structured output is detected and processed."""

    def __init__(self, structured_output: BaseModel) -> None:
        """Initialize with the structured output result.

        Args:
            structured_output: The parsed structured output instance
        """
        super().__init__({"structured_output": structured_output})


class EventLoopThrottleEvent(TypedEvent):
    """Event emitted when the event loop is throttled due to rate limiting."""

    def __init__(self, delay: int) -> None:
        """Initialize with the throttle delay duration.

        Args:
            delay: Delay in seconds before the next retry attempt
        """
        super().__init__({"event_loop_throttled_delay": delay})

    @override
    def prepare(self, invocation_state: dict) -> None:
        self.update(invocation_state)


class ToolResultEvent(TypedEvent):
    """Event emitted when a tool execution completes."""

    def __init__(self, tool_result: ToolResult, exception: Exception | None = None) -> None:
        """Initialize tool result event."""
        super().__init__({"type": "tool_result", "tool_result": tool_result})
        self._exception = exception

    @property
    def exception(self) -> Exception | None:
        """The original exception that occurred, if any.

        Can be used for re-raising or type-based error handling.
        """
        return self._exception

    @property
    def tool_use_id(self) -> str:
        """The toolUseId associated with this result."""
        return cast(ToolResult, self.get("tool_result"))["toolUseId"]

    @property
    def tool_result(self) -> ToolResult:
        """Final result from the completed tool execution."""
        return cast(ToolResult, self.get("tool_result"))

    @property
    @override
    def is_callback_event(self) -> bool:
        return False


class ToolStreamEvent(TypedEvent):
    """Event emitted when a tool yields sub-events as part of tool execution."""

    def __init__(self, tool_use: ToolUse, tool_stream_data: Any) -> None:
        """Initialize with tool streaming data.

        Args:
            tool_use: The tool invocation producing the stream
            tool_stream_data: The yielded event from the tool execution
        """
        super().__init__({"type": "tool_stream", "tool_stream_event": {"tool_use": tool_use, "data": tool_stream_data}})

    @property
    def tool_use_id(self) -> str:
        """The toolUseId associated with this stream."""
        return cast(ToolUse, cast(dict, self.get("tool_stream_event")).get("tool_use"))["toolUseId"]


class AgentAsToolStreamEvent(ToolStreamEvent):
    """Event emitted when an agent-as-tool yields intermediate events during execution.

    Extends ToolStreamEvent with a reference to the originating _AgentAsTool so callers
    can distinguish sub-agent stream events from regular tool stream events and access
    the wrapped agent, tool name, description, etc. The payload additionally carries
    ``sub_agent``, for a consumer that sees only the emitted dict.
    """

    def __init__(self, tool_use: ToolUse, tool_stream_data: Any, agent_as_tool: "_AgentAsTool") -> None:
        """Initialize with tool streaming data and agent-tool reference.

        Args:
            tool_use: The tool invocation producing the stream.
            tool_stream_data: The yielded event from the sub-agent execution.
            agent_as_tool: The _AgentAsTool instance that produced this event.
        """
        super().__init__(tool_use, tool_stream_data)
        # A consumer of the emitted dict has no other way to tell a sub-agent's forwarded event
        # from a chunk the tool yielded itself: without this key the two payloads are identical.
        self["tool_stream_event"]["sub_agent"] = True
        self._agent_as_tool = agent_as_tool

    @property
    def agent_as_tool(self) -> "_AgentAsTool":
        """The _AgentAsTool instance that produced this event."""
        return self._agent_as_tool


class ToolCancelEvent(TypedEvent):
    """Event emitted when a user cancels a tool call from their BeforeToolCallEvent hook."""

    def __init__(self, tool_use: ToolUse, message: str) -> None:
        """Initialize with tool streaming data.

        Args:
            tool_use: Information about the tool being cancelled
            message: The tool cancellation message
        """
        super().__init__({"tool_cancel_event": {"tool_use": tool_use, "message": message}})

    @property
    def tool_use_id(self) -> str:
        """The id of the tool cancelled."""
        return cast(ToolUse, cast(dict, self.get("tool_cancel_event")).get("tool_use"))["toolUseId"]

    @property
    def message(self) -> str:
        """The tool cancellation message."""
        return cast(str, self["tool_cancel_event"]["message"])


class ToolInterruptEvent(TypedEvent):
    """Event emitted when a tool is interrupted."""

    def __init__(self, tool_use: ToolUse, interrupts: list[Interrupt]) -> None:
        """Set interrupt in the event payload."""
        super().__init__({"tool_interrupt_event": {"tool_use": tool_use, "interrupts": interrupts}})

    @property
    def is_interrupt(self) -> bool:
        """True — this is a control-flow signal, never a stage result.

        Satisfies the ``InterruptControlEvent`` protocol so the middleware Output-phase
        adapter recognizes an interrupt as never-a-result (see ``_middleware/registry.py``)
        without the stage-agnostic registry importing tool-specific event types.
        """
        return True

    @property
    def tool_use_id(self) -> str:
        """The id of the tool interrupted."""
        return cast(ToolUse, cast(dict, self.get("tool_interrupt_event")).get("tool_use"))["toolUseId"]

    @property
    def interrupts(self) -> list[Interrupt]:
        """The interrupt instances."""
        return cast(list[Interrupt], self["tool_interrupt_event"]["interrupts"])


class ModelMessageEvent(TypedEvent):
    """Event emitted when the model invocation has completed.

    This event is fired whenever the model generates a response message that
    gets added to the conversation history.
    """

    def __init__(self, message: Message) -> None:
        """Initialize with the model-generated message.

        Args:
            message: The response message from the model
        """
        super().__init__({"message": message})


class ToolResultMessageEvent(TypedEvent):
    """Event emitted when tool results are formatted as a message.

    This event is fired when tool execution results are converted into a
    message format to be added to the conversation history. It provides
    access to the formatted message containing tool results.
    """

    def __init__(self, message: Any) -> None:
        """Initialize with the model-generated message.

        Args:
            message: Message containing tool results for conversation history
        """
        super().__init__({"message": message})


class ForceStopEvent(TypedEvent):
    """Event emitted when the agent execution is forcibly stopped, either by a tool or by an exception."""

    def __init__(self, reason: str | Exception) -> None:
        """Initialize with the reason for forced stop.

        Args:
            reason: String description or exception that caused the forced stop
        """
        super().__init__(
            {
                "force_stop": True,
                "force_stop_reason": str(reason),
            }
        )


class AgentResultEvent(TypedEvent):
    def __init__(self, result: "AgentResult"):
        super().__init__({"result": result})


class MultiAgentResultEvent(TypedEvent):
    """Event emitted when multi-agent execution completes with final result."""

    def __init__(self, result: "MultiAgentResult") -> None:
        """Initialize with multi-agent result.

        Args:
            result: The final result from multi-agent execution (SwarmResult, GraphResult, etc.)
        """
        super().__init__({"type": "multiagent_result", "result": result})


class MultiAgentNodeStartEvent(TypedEvent):
    """Event emitted when a node begins execution in multi-agent context."""

    def __init__(self, node_id: str, node_type: str) -> None:
        """Initialize with node information.

        Args:
            node_id: Unique identifier for the node
            node_type: Type of node ("agent", "swarm", "graph")
        """
        super().__init__({"type": "multiagent_node_start", "node_id": node_id, "node_type": node_type})


class MultiAgentNodeStopEvent(TypedEvent):
    """Event emitted when a node stops execution.

    Similar to EventLoopStopEvent but for individual nodes in multi-agent orchestration.
    Provides the complete NodeResult which contains execution details, metrics, and status.
    """

    def __init__(
        self,
        node_id: str,
        node_result: "NodeResult",
    ) -> None:
        """Initialize with stop information.

        Args:
            node_id: Unique identifier for the node
            node_result: Complete result from the node execution containing result,
                execution_time, status, accumulated_usage, accumulated_metrics, and execution_count
        """
        super().__init__(
            {
                "type": "multiagent_node_stop",
                "node_id": node_id,
                "node_result": node_result,
            }
        )


class MultiAgentHandoffEvent(TypedEvent):
    """Event emitted during node transitions in multi-agent systems.

    Supports both single handoffs (Swarm) and batch transitions (Graph).
    For Swarm: Single node-to-node handoffs with a message.
    For Graph: Batch transitions where multiple nodes complete and multiple nodes begin.
    """

    def __init__(
        self,
        from_node_ids: list[str],
        to_node_ids: list[str],
        message: str | None = None,
    ) -> None:
        """Initialize with handoff information.

        Args:
            from_node_ids: List of node ID(s) completing execution.
                - Swarm: Single-element list ["agent_a"]
                - Graph: Multi-element list ["node1", "node2"]
            to_node_ids: List of node ID(s) beginning execution.
                - Swarm: Single-element list ["agent_b"]
                - Graph: Multi-element list ["node3", "node4"]
            message: Optional message explaining the transition (typically used in Swarm)

        Examples:
            Swarm handoff: MultiAgentHandoffEvent(["researcher"], ["analyst"], "Need calculations")
            Graph batch: MultiAgentHandoffEvent(["node1", "node2"], ["node3", "node4"])
        """
        event_data = {
            "type": "multiagent_handoff",
            "from_node_ids": from_node_ids,
            "to_node_ids": to_node_ids,
        }

        if message is not None:
            event_data["message"] = message

        super().__init__(event_data)


class MultiAgentNodeStreamEvent(TypedEvent):
    """Event emitted during node execution - forwards agent events with node context."""

    def __init__(self, node_id: str, agent_event: dict[str, Any]) -> None:
        """Initialize with node context and agent event.

        Args:
            node_id: Unique identifier for the node generating the event
            agent_event: The original agent event data
        """
        super().__init__(
            {
                "type": "multiagent_node_stream",
                "node_id": node_id,
                "event": agent_event,  # Nest agent event to avoid field conflicts
            }
        )


class MultiAgentNodeCancelEvent(TypedEvent):
    """Event emitted when a user cancels node execution from their BeforeNodeCallEvent hook."""

    def __init__(self, node_id: str, message: str) -> None:
        """Initialize with cancel message.

        Args:
            node_id: Unique identifier for the node.
            message: The node cancellation message.
        """
        super().__init__(
            {
                "type": "multiagent_node_cancel",
                "node_id": node_id,
                "message": message,
            }
        )


class MultiAgentNodeInterruptEvent(TypedEvent):
    """Event emitted when a node is interrupted."""

    def __init__(self, node_id: str, interrupts: list[Interrupt]) -> None:
        """Set interrupt in the event payload.

        Args:
            node_id: Unique identifier for the node generating the event.
            interrupts: Interrupts raised by user.
        """
        super().__init__(
            {
                "type": "multiagent_node_interrupt",
                "node_id": node_id,
                "interrupts": interrupts,
            }
        )

    @property
    def interrupts(self) -> list[Interrupt]:
        """The interrupt instances."""
        return cast(list[Interrupt], self["interrupts"])

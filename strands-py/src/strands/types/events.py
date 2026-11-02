"""Public stream event types.

The agent stream is a sequence of ``TypedEvent`` instances. The types in this module are public
because middleware constructs or receives them: ``ModelStopReason`` is the result of a model call
and ``ToolResultEvent`` is the result of a tool call. The other stream events are internal.
"""

from typing import Any, cast

from typing_extensions import override

from .content import Message
from .event_loop import Metrics, StopReason, Usage
from .tools import ToolResult

__all__ = ["ModelStopReason", "ToolResultEvent", "TypedEvent"]


class TypedEvent(dict):
    """Base class for every event in the agent stream.

    An event is a dict whose items are its payload. Events that a middleware Wrap handler yields
    into the stream must be ``TypedEvent`` instances: the agent loop calls ``prepare()`` and reads
    ``is_callback_event`` on every event, so a plain dict fails.
    """

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


class ModelStopReason(TypedEvent):
    """Final event of a model call, carrying the aggregated response.

    This is the result event of ``InvokeModelStage``: the model stream ends with it, an Output
    handler receives it as ``InvokeModelResult.result``, and a Wrap handler yields one to
    short-circuit the model call. Read it through ``stop_reason``, ``message``, ``usage`` and
    ``metrics``. ``event["stop"]`` holds the same values as a ``(stop_reason, message, usage,
    metrics)`` tuple for model providers that unpack it from ``process_stream``. It is not sent to
    callback handlers.
    """

    def __init__(
        self,
        stop_reason: StopReason,
        message: Message,
        usage: Usage,
        metrics: Metrics,
    ) -> None:
        """Initialize with the final execution results.

        Args:
            stop_reason: Why the model stopped generating
            message: Final message from the model
            usage: Usage information from the model
            metrics: Execution metrics and performance data
        """
        super().__init__({"stop": (stop_reason, message, usage, metrics)})
        self._stop_reason = stop_reason
        self._message = message
        self._usage = usage
        self._metrics = metrics

    @property
    def stop_reason(self) -> StopReason:
        """Why the model stopped generating."""
        return self._stop_reason

    @property
    def message(self) -> Message:
        """Final message from the model."""
        return self._message

    @property
    def usage(self) -> Usage:
        """Usage information from the model."""
        return self._usage

    @property
    def metrics(self) -> Metrics:
        """Execution metrics and performance data."""
        return self._metrics

    @property
    @override
    def is_callback_event(self) -> bool:
        return False


class ToolResultEvent(TypedEvent):
    """Final event of a tool call, carrying the tool result.

    This is the result event of ``ExecuteToolStage``: tool execution ends with it, an Output handler
    receives it as ``ExecuteToolResult.result``, and a Wrap handler yields one to short-circuit or
    deny the tool call. When building a replacement for an existing result, pass its ``exception``
    through so ``AfterToolCallEvent`` still receives it. It is not sent to callback handlers.
    """

    def __init__(
        self, tool_result: ToolResult, exception: Exception | None = None, *, backgrounded: bool = False
    ) -> None:
        """Initialize tool result event.

        Args:
            tool_result: The tool result returned to the model.
            exception: The exception behind an error result, if any.
            backgrounded: Whether this result only acknowledges that the tool was dispatched to the
                background.
        """
        super().__init__({"type": "tool_result", "tool_result": tool_result})
        self._exception = exception
        self._backgrounded = backgrounded

    @property
    def backgrounded(self) -> bool:
        """Whether this result only acknowledges that the tool was dispatched to the background."""
        return self._backgrounded

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

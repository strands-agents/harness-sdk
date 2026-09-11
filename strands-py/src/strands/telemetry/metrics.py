"""Utilities for collecting and reporting performance metrics in the SDK."""

import logging
import threading
import time
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any, Optional

import opentelemetry.metrics as metrics_api
from opentelemetry.metrics import Counter, Histogram, Meter

from ..telemetry import metrics_constants as constants
from ..types.content import Message
from ..types.event_loop import Metrics, Usage
from ..types.tools import ToolUse

logger = logging.getLogger(__name__)


class Trace:
    """A trace representing a single operation or step in the execution flow."""

    def __init__(
        self,
        name: str,
        parent_id: str | None = None,
        start_time: float | None = None,
        raw_name: str | None = None,
        metadata: dict[str, Any] | None = None,
        message: Message | None = None,
    ) -> None:
        """Initialize a new trace.

        Args:
            name: Human-readable name of the operation being traced.
            parent_id: ID of the parent trace, if this is a child operation.
            start_time: Timestamp when the trace started.
                If not provided, the current time will be used.
            raw_name: System level name.
            metadata: Additional contextual information about the trace.
            message: Message associated with the trace.
        """
        self.id: str = str(uuid.uuid4())
        self.name: str = name
        self.raw_name: str | None = raw_name
        self.parent_id: str | None = parent_id
        self.start_time: float = start_time if start_time is not None else time.time()
        self.end_time: float | None = None
        self.children: list[Trace] = []
        self.metadata: dict[str, Any] = metadata or {}
        self.message: Message | None = message

    def end(self, end_time: float | None = None) -> None:
        """Mark the trace as complete with the given or current timestamp.

        Args:
            end_time: Timestamp to use as the end time.
                If not provided, the current time will be used.
        """
        self.end_time = end_time if end_time is not None else time.time()

    def add_child(self, child: "Trace") -> None:
        """Add a child trace to this trace.

        Args:
            child: The child trace to add.
        """
        self.children.append(child)

    def duration(self) -> float | None:
        """Calculate the duration of this trace.

        Returns:
            The duration in seconds, or None if the trace hasn't ended yet.
        """
        return None if self.end_time is None else self.end_time - self.start_time

    def add_message(self, message: Message) -> None:
        """Add a message to the trace.

        Args:
            message: The message to add.
        """
        self.message = message

    def to_dict(self) -> dict[str, Any]:
        """Convert the trace to a dictionary representation.

        Returns:
            A dictionary containing all trace information, suitable for serialization.
        """
        return {
            "id": self.id,
            "name": self.name,
            "raw_name": self.raw_name,
            "parent_id": self.parent_id,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "duration": self.duration(),
            "children": [child.to_dict() for child in self.children],
            "metadata": self.metadata,
            "message": self.message,
        }


@dataclass
class ToolMetrics:
    """Metrics for a specific tool's usage.

    Attributes:
        tool: The tool being tracked.
        call_count: Number of times the tool has been called.
        success_count: Number of successful tool calls.
        error_count: Number of failed tool calls.
        total_time: Total execution time across all calls in seconds.
    """

    tool: ToolUse
    call_count: int = 0
    success_count: int = 0
    error_count: int = 0
    total_time: float = 0.0

    def add_call(
        self,
        tool: ToolUse,
        duration: float,
        success: bool,
        metrics_client: "MetricsClient",
        attributes: dict[str, Any] | None = None,
    ) -> None:
        """Record a new tool call with its outcome.

        Args:
            tool: The tool that was called.
            duration: How long the call took in seconds.
            success: Whether the call was successful.
            metrics_client: The metrics client for recording the metrics.
            attributes: attributes of the metrics.
        """
        self.tool = tool  # Update with latest tool state
        self.call_count += 1
        self.total_time += duration
        metrics_client.tool_call_count.add(1, attributes=attributes)
        metrics_client.tool_duration.record(duration, attributes=attributes)
        if success:
            self.success_count += 1
            metrics_client.tool_success_count.add(1, attributes=attributes)
        else:
            self.error_count += 1
            metrics_client.tool_error_count.add(1, attributes=attributes)


@dataclass
class EventLoopCycleMetric:
    """Aggregated metrics for a single event loop cycle.

    Attributes:
        event_loop_cycle_id: Current eventLoop cycle id.
        usage: Total token usage for the entire cycle (succeeded model invocation, excluding tool invocations).
    """

    event_loop_cycle_id: str
    usage: Usage


@dataclass
class AgentInvocation:
    """Metrics for a single agent invocation.

    AgentInvocation contains all the event loop cycles and accumulated token usage for that invocation.

    Attributes:
        cycles: List of event loop cycles that occurred during this invocation.
        usage: Accumulated token usage for this invocation across all cycles.
    """

    cycles: list[EventLoopCycleMetric] = field(default_factory=list)
    usage: Usage = field(default_factory=lambda: Usage(inputTokens=0, outputTokens=0, totalTokens=0))


def _total_prompt_tokens(usage: Usage) -> int:
    """Return the total prompt the model processed, including cached tokens.

    Providers either fold cache tokens into ``inputTokens`` or report them separately; the totals tell
    us which. ``inputTokens + outputTokens == totalTokens`` means cache is already inside
    ``inputTokens``; otherwise the cache counters are added on top. Uncached usage returns
    ``inputTokens`` either way.

    Args:
        usage: Token usage from a model invocation.

    Returns:
        The total prompt token count.
    """
    input_tokens = usage["inputTokens"]
    output_tokens = usage["outputTokens"]
    total_tokens = usage["totalTokens"]
    if input_tokens + output_tokens == total_tokens:
        return input_tokens
    return input_tokens + usage.get("cacheReadInputTokens", 0) + usage.get("cacheWriteInputTokens", 0)


@dataclass
class EventLoopMetrics:
    """Aggregated metrics for an event loop's execution.

    Attributes:
        cycle_count: Number of event loop cycles executed.
        tool_metrics: Metrics for each tool used, keyed by tool name.
        cycle_durations: List of durations for each cycle in seconds.
        agent_invocations: Agent invocation metrics containing cycles and usage data.
        traces: List of execution traces.
        accumulated_usage: Accumulated token usage across all model invocations (across all requests).
        accumulated_metrics: Accumulated performance metrics across all model invocations.
    """

    cycle_count: int = 0
    tool_metrics: dict[str, ToolMetrics] = field(default_factory=dict)
    cycle_durations: list[float] = field(default_factory=list)
    agent_invocations: list[AgentInvocation] = field(default_factory=list)
    traces: list[Trace] = field(default_factory=list)
    accumulated_usage: Usage = field(default_factory=lambda: Usage(inputTokens=0, outputTokens=0, totalTokens=0))
    accumulated_metrics: Metrics = field(default_factory=lambda: Metrics(latencyMs=0))

    @property
    def latest_context_size(self) -> int | None:
        """Most recent context size from the last LLM call.

        This represents the current context size as reported by the model.

        Returns:
            The total prompt the model processed on the most recent cycle, including cached tokens, or
            None if no data is available.
        """
        if self.agent_invocations and self.agent_invocations[-1].cycles:
            usage = self.agent_invocations[-1].cycles[-1].usage
            if usage.get("inputTokens") is not None:
                return _total_prompt_tokens(usage)
        return None

    @property
    def projected_context_size(self) -> int | None:
        """Projected context size for the next model call.

        Computed from the most recent cycle's usage as the total prompt the model processed (including
        cached tokens) plus the generated output that is now part of the conversation, approximating the
        input token count for the next model call.

        Returns:
            The projected token count, or None if no data is available.
        """
        if self.agent_invocations and self.agent_invocations[-1].cycles:
            usage = self.agent_invocations[-1].cycles[-1].usage
            input_tokens = usage.get("inputTokens")
            output_tokens = usage.get("outputTokens")
            if input_tokens is not None and output_tokens is not None:
                return _total_prompt_tokens(usage) + output_tokens
        return None

    @property
    def _metrics_client(self) -> "MetricsClient":
        """Get the singleton MetricsClient instance."""
        return MetricsClient()

    @property
    def latest_agent_invocation(self) -> AgentInvocation | None:
        """Get the most recent agent invocation.

        Returns:
            The most recent AgentInvocation, or None if no invocations exist.
        """
        return self.agent_invocations[-1] if self.agent_invocations else None

    def start_cycle(
        self,
        attributes: dict[str, Any],
    ) -> tuple[float, Trace]:
        """Start a new event loop cycle and create a trace for it.

        Args:
            attributes: attributes of the metrics, including event_loop_cycle_id.

        Returns:
            A tuple containing the start time and the cycle trace object.
        """
        self._metrics_client.event_loop_cycle_count.add(1, attributes=attributes)
        self._metrics_client.event_loop_start_cycle.add(1, attributes=attributes)
        self.cycle_count += 1
        start_time = time.time()
        cycle_trace = Trace(f"Cycle {self.cycle_count}", start_time=start_time)
        self.traces.append(cycle_trace)

        self.agent_invocations[-1].cycles.append(
            EventLoopCycleMetric(
                event_loop_cycle_id=attributes["event_loop_cycle_id"],
                usage=Usage(inputTokens=0, outputTokens=0, totalTokens=0),
            )
        )

        return start_time, cycle_trace

    def end_cycle(self, start_time: float, cycle_trace: Trace, attributes: dict[str, Any] | None = None) -> None:
        """End the current event loop cycle and record its duration.

        Args:
            start_time: The timestamp when the cycle started.
            cycle_trace: The trace object for this cycle.
            attributes: attributes of the metrics.
        """
        self._metrics_client.event_loop_end_cycle.add(1, attributes)
        end_time = time.time()
        duration = end_time - start_time
        self._metrics_client.event_loop_cycle_duration.record(duration, attributes)
        self.cycle_durations.append(duration)
        cycle_trace.end(end_time)

    def add_tool_usage(
        self,
        tool: ToolUse,
        duration: float,
        tool_trace: Trace,
        success: bool,
        message: Message | None = None,
    ) -> None:
        """Record metrics for a tool invocation.

        Args:
            tool: The tool that was used.
            duration: How long the tool call took in seconds.
            tool_trace: The trace object for this tool call.
            success: Whether the tool call was successful.
            message: The message associated with the tool call, if any. Pass ``None``
                when the call ended without producing a tool result (e.g. on interrupt).
        """
        tool_name = tool.get("name", "unknown_tool")
        tool_use_id = tool.get("toolUseId", "unknown")

        tool_trace.metadata.update(
            {
                "toolUseId": tool_use_id,
                "tool_name": tool_name,
            }
        )
        tool_trace.raw_name = f"{tool_name} - {tool_use_id}"
        if message is not None:
            tool_trace.add_message(message)

        self.tool_metrics.setdefault(tool_name, ToolMetrics(tool)).add_call(
            tool,
            duration,
            success,
            self._metrics_client,
            attributes={
                "tool_name": tool_name,
                "tool_use_id": tool_use_id,
            },
        )
        tool_trace.end()

    def _accumulate_usage(self, target: Usage, source: Usage) -> None:
        """Helper method to accumulate usage from source to target.

        Args:
            target: The Usage object to accumulate into.
            source: The Usage object to accumulate from.
        """
        target["inputTokens"] += source["inputTokens"]
        target["outputTokens"] += source["outputTokens"]
        target["totalTokens"] += source["totalTokens"]

        if "cacheReadInputTokens" in source:
            target["cacheReadInputTokens"] = target.get("cacheReadInputTokens", 0) + source["cacheReadInputTokens"]

        if "cacheWriteInputTokens" in source:
            target["cacheWriteInputTokens"] = target.get("cacheWriteInputTokens", 0) + source["cacheWriteInputTokens"]

    def update_usage(self, usage: Usage) -> None:
        """Update the accumulated token usage with new usage data.

        Args:
            usage: The usage data to add to the accumulated totals.
        """
        # Record metrics to OpenTelemetry
        self._metrics_client.event_loop_input_tokens.record(usage["inputTokens"])
        self._metrics_client.event_loop_output_tokens.record(usage["outputTokens"])

        # Handle optional cached token metrics for OpenTelemetry
        if "cacheReadInputTokens" in usage:
            self._metrics_client.event_loop_cache_read_input_tokens.record(usage["cacheReadInputTokens"])
        if "cacheWriteInputTokens" in usage:
            self._metrics_client.event_loop_cache_write_input_tokens.record(usage["cacheWriteInputTokens"])

        self._accumulate_usage(self.accumulated_usage, usage)
        self._accumulate_usage(self.agent_invocations[-1].usage, usage)

        if self.agent_invocations[-1].cycles:
            current_cycle = self.agent_invocations[-1].cycles[-1]
            self._accumulate_usage(current_cycle.usage, usage)

    def reset_usage_metrics(self) -> None:
        """Start a new agent invocation by creating a new AgentInvocation.

        This should be called at the start of a new request to begin tracking
        a new agent invocation with fresh usage and cycle data.
        """
        self.agent_invocations.append(AgentInvocation())

    def update_metrics(self, metrics: Metrics) -> None:
        """Update the accumulated performance metrics with new metrics data.

        Args:
            metrics: The metrics data to add to the accumulated totals.
        """
        self._metrics_client.event_loop_latency.record(metrics["latencyMs"])
        if metrics.get("timeToFirstByteMs") is not None:
            self._metrics_client.model_time_to_first_token.record(metrics["timeToFirstByteMs"])
        self.accumulated_metrics["latencyMs"] += metrics["latencyMs"]

    def get_summary(self) -> dict[str, Any]:
        """Generate a comprehensive summary of all collected metrics.

        Returns:
            A dictionary containing summarized metrics data.
            This includes cycle statistics, tool usage, traces, and accumulated usage information.
        """
        summary = {
            "total_cycles": self.cycle_count,
            "total_duration": sum(self.cycle_durations),
            "average_cycle_time": (sum(self.cycle_durations) / self.cycle_count if self.cycle_count > 0 else 0),
            "tool_usage": {
                tool_name: {
                    "tool_info": {
                        "tool_use_id": metrics.tool.get("toolUseId", "N/A"),
                        "name": metrics.tool.get("name", "unknown"),
                        "input_params": metrics.tool.get("input", {}),
                    },
                    "execution_stats": {
                        "call_count": metrics.call_count,
                        "success_count": metrics.success_count,
                        "error_count": metrics.error_count,
                        "total_time": metrics.total_time,
                        "average_time": (metrics.total_time / metrics.call_count if metrics.call_count > 0 else 0),
                        "success_rate": (metrics.success_count / metrics.call_count if metrics.call_count > 0 else 0),
                    },
                }
                for tool_name, metrics in self.tool_metrics.items()
            },
            "traces": [trace.to_dict() for trace in self.traces],
            "accumulated_usage": self.accumulated_usage,
            "accumulated_metrics": self.accumulated_metrics,
            "agent_invocations": [
                {
                    "usage": invocation.usage,
                    "cycles": [
                        {"event_loop_cycle_id": cycle.event_loop_cycle_id, "usage": cycle.usage}
                        for cycle in invocation.cycles
                    ],
                }
                for invocation in self.agent_invocations
            ],
        }
        return summary


def _metrics_summary_to_lines(event_loop_metrics: EventLoopMetrics, allowed_names: set[str]) -> Iterable[str]:
    """Convert event loop metrics to a series of formatted text lines.

    Args:
        event_loop_metrics: The metrics to format.
        allowed_names: Set of names that are allowed to be displayed unmodified.

    Returns:
        An iterable of formatted text lines representing the metrics.
    """
    summary = event_loop_metrics.get_summary()
    yield "Event Loop Metrics Summary:"
    yield (
        f"├─ Cycles: total={summary['total_cycles']}, avg_time={summary['average_cycle_time']:.3f}s, "
        f"total_time={summary['total_duration']:.3f}s"
    )

    # Build token display with optional cached tokens
    token_parts = [
        f"in={summary['accumulated_usage']['inputTokens']}",
        f"out={summary['accumulated_usage']['outputTokens']}",
        f"total={summary['accumulated_usage']['totalTokens']}",
    ]

    # Add cached token info if present
    if summary["accumulated_usage"].get("cacheReadInputTokens"):
        token_parts.append(f"cache_read_input_tokens={summary['accumulated_usage']['cacheReadInputTokens']}")
    if summary["accumulated_usage"].get("cacheWriteInputTokens"):
        token_parts.append(f"cache_write_input_tokens={summary['accumulated_usage']['cacheWriteInputTokens']}")

    yield f"├─ Tokens: {', '.join(token_parts)}"
    yield f"├─ Bedrock Latency: {summary['accumulated_metrics']['latencyMs']}ms"

    yield "├─ Tool Usage:"
    for tool_name, tool_data in summary.get("tool_usage", {}).items():
        # tool_info = tool_data["tool_info"]
        exec_stats = tool_data["execution_stats"]

        # Tool header - show just name for multi-call case
        yield f"   └─ {tool_name}:"
        # Execution stats
        yield f"      ├─ Stats: calls={exec_stats['call_count']}, success={exec_stats['success_count']}"
        yield f"      │         errors={exec_stats['error_count']}, success_rate={exec_stats['success_rate']:.1%}"
        yield f"      ├─ Timing: avg={exec_stats['average_time']:.3f}s, total={exec_stats['total_time']:.3f}s"
        # All tool calls with their inputs
        yield "      └─ Tool Calls:"
        # Show tool use ID and input for each call from the traces
        for trace in event_loop_metrics.traces:
            for child in trace.children:
                if child.metadata.get("tool_name") == tool_name:
                    tool_use_id = child.metadata.get("toolUseId", "unknown")
                    # tool_input = child.metadata.get('tool_input', {})
                    yield f"         ├─ {tool_use_id}: {tool_name}"
                    # yield f"         │  └─ Input: {json.dumps(tool_input, sort_keys=True)}"

    yield "├─ Execution Trace:"

    for trace in event_loop_metrics.traces:
        yield from _trace_to_lines(trace.to_dict(), allowed_names=allowed_names, indent=1)


def _trace_to_lines(trace: dict, allowed_names: set[str], indent: int) -> Iterable[str]:
    """Convert a trace to a series of formatted text lines.

    Args:
        trace: The trace dictionary to format.
        allowed_names: Set of names that are allowed to be displayed unmodified.
        indent: The indentation level for the output lines.

    Returns:
        An iterable of formatted text lines representing the trace.
    """
    duration = trace.get("duration", "N/A")
    duration_str = f"{duration:.4f}s" if isinstance(duration, (int, float)) else str(duration)

    safe_name = trace.get("raw_name", trace.get("name"))

    tool_use_id = ""
    # Check if this trace contains tool info with toolUseId
    if trace.get("raw_name") and isinstance(safe_name, str) and " - tooluse_" in safe_name:
        # Already includes toolUseId, use as is
        yield f"{'   ' * indent}└─ {safe_name} - Duration: {duration_str}"
    else:
        # Extract toolUseId if it exists in metadata
        metadata = trace.get("metadata", {})
        if isinstance(metadata, dict) and metadata.get("toolUseId"):
            tool_use_id = f" - {metadata['toolUseId']}"
        yield f"{'   ' * indent}└─ {safe_name}{tool_use_id} - Duration: {duration_str}"

    for child in trace.get("children", []):
        yield from _trace_to_lines(child, allowed_names, indent + 1)


def metrics_to_string(event_loop_metrics: EventLoopMetrics, allowed_names: set[str] | None = None) -> str:
    """Convert event loop metrics to a human-readable string representation.

    Args:
        event_loop_metrics: The metrics to format.
        allowed_names: Set of names that are allowed to be displayed unmodified.

    Returns:
        A formatted string representation of the metrics.
    """
    return "\n".join(_metrics_summary_to_lines(event_loop_metrics, allowed_names or set()))


class MetricsClient:
    """Singleton client for managing OpenTelemetry metrics instruments.

    The actual metrics export destination (console, OTLP endpoint, etc.) is configured
    through OpenTelemetry SDK configuration by users, not by this client.

    This class uses a thread-safe double-checked locking pattern to ensure safe
    concurrent initialization across multiple threads.
    """

    _instance: Optional["MetricsClient"] = None
    _lock: threading.Lock = threading.Lock()
    meter: Meter
    event_loop_cycle_count: Counter
    event_loop_start_cycle: Counter
    event_loop_end_cycle: Counter
    event_loop_cycle_duration: Histogram
    event_loop_latency: Histogram
    event_loop_input_tokens: Histogram
    event_loop_output_tokens: Histogram
    event_loop_cache_read_input_tokens: Histogram
    event_loop_cache_write_input_tokens: Histogram
    model_time_to_first_token: Histogram
    tool_call_count: Counter
    tool_success_count: Counter
    tool_error_count: Counter
    tool_duration: Histogram

    def __new__(cls) -> "MetricsClient":
        """Create or return the singleton instance of MetricsClient.

        Uses double-checked locking to ensure thread safety without
        acquiring the lock on every access after initialization.

        Returns:
            The single MetricsClient instance.
        """
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self) -> None:
        """Initialize the MetricsClient.

        This method only runs once due to the singleton pattern.
        Sets up the OpenTelemetry meter and creates metric instruments.
        Uses a lock to prevent concurrent initialization races.
        """
        if hasattr(self, "meter"):
            return

        with self._lock:
            # Double-check after acquiring the lock
            if hasattr(self, "meter"):
                return

            logger.info("Creating Strands MetricsClient")
            meter_provider: metrics_api.MeterProvider = metrics_api.get_meter_provider()
            self.meter = meter_provider.get_meter(__name__)
            self.create_instruments()

    def create_instruments(self) -> None:
        """Create and initialize all OpenTelemetry metric instruments."""
        self.event_loop_cycle_count = self.meter.create_counter(
            name=constants.STRANDS_EVENT_LOOP_CYCLE_COUNT, unit="Count"
        )
        self.event_loop_start_cycle = self.meter.create_counter(
            name=constants.STRANDS_EVENT_LOOP_START_CYCLE, unit="Count"
        )
        self.event_loop_end_cycle = self.meter.create_counter(name=constants.STRANDS_EVENT_LOOP_END_CYCLE, unit="Count")
        self.event_loop_cycle_duration = self.meter.create_histogram(
            name=constants.STRANDS_EVENT_LOOP_CYCLE_DURATION, unit="s"
        )
        self.event_loop_latency = self.meter.create_histogram(name=constants.STRANDS_EVENT_LOOP_LATENCY, unit="ms")
        self.tool_call_count = self.meter.create_counter(name=constants.STRANDS_TOOL_CALL_COUNT, unit="Count")
        self.tool_success_count = self.meter.create_counter(name=constants.STRANDS_TOOL_SUCCESS_COUNT, unit="Count")
        self.tool_error_count = self.meter.create_counter(name=constants.STRANDS_TOOL_ERROR_COUNT, unit="Count")
        self.tool_duration = self.meter.create_histogram(name=constants.STRANDS_TOOL_DURATION, unit="s")
        self.event_loop_input_tokens = self.meter.create_histogram(
            name=constants.STRANDS_EVENT_LOOP_INPUT_TOKENS, unit="token"
        )
        self.event_loop_output_tokens = self.meter.create_histogram(
            name=constants.STRANDS_EVENT_LOOP_OUTPUT_TOKENS, unit="token"
        )
        self.event_loop_cache_read_input_tokens = self.meter.create_histogram(
            name=constants.STRANDS_EVENT_LOOP_CACHE_READ_INPUT_TOKENS, unit="token"
        )
        self.event_loop_cache_write_input_tokens = self.meter.create_histogram(
            name=constants.STRANDS_EVENT_LOOP_CACHE_WRITE_INPUT_TOKENS, unit="token"
        )
        self.model_time_to_first_token = self.meter.create_histogram(
            name=constants.STRANDS_MODEL_TIME_TO_FIRST_TOKEN, unit="ms"
        )

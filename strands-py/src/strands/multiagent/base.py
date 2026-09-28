"""Multi-Agent Base Class.

Provides minimal foundation for multi-agent patterns (Swarm, Graph).
"""

import logging
import time
import warnings
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Union

from .._async import run_async
from ..agent import AgentResult
from ..hooks.registry import HookCallback, HookOrder
from ..interrupt import Interrupt
from ..types.event_loop import Metrics, Usage
from ..types.multiagent import MultiAgentInput
from ..types.traces import AttributeValue

logger = logging.getLogger(__name__)


class Status(Enum):
    """Execution status for both graphs and nodes.

    Attributes:
        PENDING: Task has not started execution yet.
        EXECUTING: Task is currently running.
        COMPLETED: Task finished successfully.
        FAILED: Task encountered an error and could not complete.
        INTERRUPTED: Task was interrupted by user.
    """

    PENDING = "pending"
    EXECUTING = "executing"
    COMPLETED = "completed"
    FAILED = "failed"
    INTERRUPTED = "interrupted"


@dataclass
class NodeResult:
    """Unified result from node execution - handles both Agent and nested MultiAgentBase results."""

    # Core result data - single AgentResult, nested MultiAgentResult, or Exception
    result: Union[AgentResult, "MultiAgentResult", Exception]

    # Execution metadata
    execution_time: int = 0
    status: Status = Status.PENDING

    # Accumulated metrics from this node and all children
    accumulated_usage: Usage = field(default_factory=lambda: Usage(inputTokens=0, outputTokens=0, totalTokens=0))
    accumulated_metrics: Metrics = field(default_factory=lambda: Metrics(latencyMs=0))
    execution_count: int = 0
    interrupts: list[Interrupt] = field(default_factory=list)

    def __str__(self) -> str:
        """Return a human-readable string representation of the node result.

        Delegates to the inner result's string representation:
        - AgentResult: Uses AgentResult.__str__ (extracts text content)
        - MultiAgentResult: Uses MultiAgentResult.__str__ (recursive)
        - Exception: Uses the exception's string representation

        Returns:
            String representation of the node's result.
        """
        return str(self.result)

    def get_agent_results(self) -> list[AgentResult]:
        """Get all AgentResult objects from this node, flattened if nested."""
        if isinstance(self.result, Exception):
            return []  # No agent results for exceptions
        elif isinstance(self.result, AgentResult):
            return [self.result]
        else:
            # Flatten nested results from MultiAgentResult
            flattened = []
            for nested_node_result in self.result.results.values():
                flattened.extend(nested_node_result.get_agent_results())
            return flattened

    def to_dict(self) -> dict[str, Any]:
        """Convert NodeResult to JSON-serializable dict, ignoring state field."""
        if isinstance(self.result, Exception):
            result_data: dict[str, Any] = {"type": "exception", "message": str(self.result)}
        elif isinstance(self.result, AgentResult):
            result_data = self.result.to_dict()
        else:
            # MultiAgentResult case
            result_data = self.result.to_dict()

        return {
            "result": result_data,
            "execution_time": self.execution_time,
            "status": self.status.value,
            "accumulated_usage": self.accumulated_usage,
            "accumulated_metrics": self.accumulated_metrics,
            "execution_count": self.execution_count,
            "interrupts": [interrupt.to_dict() for interrupt in self.interrupts],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "NodeResult":
        """Rehydrate a NodeResult from persisted JSON."""
        if "result" not in data:
            raise TypeError("NodeResult.from_dict: missing 'result'")
        raw = data["result"]

        result: AgentResult | MultiAgentResult | Exception
        if isinstance(raw, dict) and raw.get("type") == "agent_result":
            result = AgentResult.from_dict(raw)
        elif isinstance(raw, dict) and raw.get("type") == "exception":
            result = Exception(str(raw.get("message", "node failed")))
        elif isinstance(raw, dict) and raw.get("type") == "multiagent_result":
            result = MultiAgentResult.from_dict(raw)
        else:
            raise TypeError(f"NodeResult.from_dict: unsupported result payload: {raw!r}")

        usage = _parse_usage(data.get("accumulated_usage", {}))
        metrics = _parse_metrics(data.get("accumulated_metrics", {}))

        interrupts = []
        for interrupt_data in data.get("interrupts", []):
            interrupts.append(Interrupt(**interrupt_data))

        return cls(
            result=result,
            execution_time=int(data.get("execution_time", 0)),
            status=Status(data.get("status", "pending")),
            accumulated_usage=usage,
            accumulated_metrics=metrics,
            execution_count=int(data.get("execution_count", 0)),
            interrupts=interrupts,
        )


@dataclass
class MultiAgentResult:
    """Result from multi-agent execution with accumulated metrics."""

    status: Status = Status.PENDING
    results: dict[str, NodeResult] = field(default_factory=lambda: {})
    accumulated_usage: Usage = field(default_factory=lambda: Usage(inputTokens=0, outputTokens=0, totalTokens=0))
    accumulated_metrics: Metrics = field(default_factory=lambda: Metrics(latencyMs=0))
    execution_count: int = 0
    execution_time: int = 0
    interrupts: list[Interrupt] = field(default_factory=list)

    def __str__(self) -> str:
        """Return a human-readable string representation of the multi-agent result.

        Priority order:
        1. Interrupts (if present) → stringified list of interrupt dicts
        2. Node results → each node's string output, prefixed with node name

        Returns:
            String representation based on the priority order above.
        """
        if self.interrupts:
            return str([interrupt.to_dict() for interrupt in self.interrupts])

        parts = []
        for node_name, node_result in self.results.items():
            # Remove only the single trailing newline that AgentResult.__str__ appends
            # as a framework separator, preserving all user-owned whitespace (leading
            # indentation, internal markdown hard-break spaces, payload trailing newlines).
            node_str = str(node_result).removesuffix("\n")
            if node_str:
                parts.append(f"{node_name}: {node_str}")

        return "\n".join(parts)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MultiAgentResult":
        """Rehydrate a MultiAgentResult from persisted JSON."""
        if data.get("type") != "multiagent_result":
            raise TypeError(f"MultiAgentResult.from_dict: unexpected type {data.get('type')!r}")

        results = {k: NodeResult.from_dict(v) for k, v in data.get("results", {}).items()}
        usage = _parse_usage(data.get("accumulated_usage", {}))
        metrics = _parse_metrics(data.get("accumulated_metrics", {}))

        interrupts = []
        for interrupt_data in data.get("interrupts", []):
            interrupts.append(Interrupt(**interrupt_data))

        multiagent_result = cls(
            status=Status(data["status"]),
            results=results,
            accumulated_usage=usage,
            accumulated_metrics=metrics,
            execution_count=int(data.get("execution_count", 0)),
            execution_time=int(data.get("execution_time", 0)),
            interrupts=interrupts,
        )
        return multiagent_result

    def to_dict(self) -> dict[str, Any]:
        """Convert MultiAgentResult to JSON-serializable dict."""
        return {
            "type": "multiagent_result",
            "status": self.status.value,
            "results": {k: v.to_dict() for k, v in self.results.items()},
            "accumulated_usage": self.accumulated_usage,
            "accumulated_metrics": self.accumulated_metrics,
            "execution_count": self.execution_count,
            "execution_time": self.execution_time,
            "interrupts": [interrupt.to_dict() for interrupt in self.interrupts],
        }


class MultiAgentBase(ABC):
    """Base class for multi-agent helpers.

    This class integrates with existing Strands Agent instances and provides
    multi-agent orchestration capabilities.

    Attributes:
        id: Unique MultiAgent id for session management,etc.
    """

    id: str
    # Wall-clock start of the active invocation, or None when no invocation is running. Set at
    # invocation start; folded into the orchestrator's committed execution-time total exactly once
    # at finalization.
    _invocation_start_time: float | None

    def __init__(self) -> None:
        """Initialize base multi-agent state."""
        self._invocation_start_time = None

    def _execution_time_with_active_interval(self, committed_time: int) -> int:
        """Committed execution time (ms) plus the active invocation's in-flight interval.

        The active interval is folded into the committed total only once, at finalization, so any
        read that must reflect elapsed time — checkpoints, result building — adds it on here.

        Args:
            committed_time: Execution time in milliseconds already committed by prior invocations.

        Returns:
            committed_time plus the current invocation's elapsed milliseconds, or committed_time
            unchanged when no invocation is running.
        """
        if self._invocation_start_time is None:
            return committed_time
        return committed_time + round((time.time() - self._invocation_start_time) * 1000)

    def _commit_active_interval(self, committed_time: int) -> int:
        """Fold the active invocation's interval into committed_time and end the interval.

        Idempotent: with no active interval this returns committed_time unchanged, so calling it at
        finalization never double-counts.

        Args:
            committed_time: Execution time in milliseconds already committed by prior invocations.

        Returns:
            The new committed total including the interval that just ended.
        """
        total = self._execution_time_with_active_interval(committed_time)
        self._invocation_start_time = None
        return total

    @abstractmethod
    async def invoke_async(
        self, task: MultiAgentInput, invocation_state: dict[str, Any] | None = None, **kwargs: Any
    ) -> MultiAgentResult:
        """Invoke asynchronously.

        Args:
            task: The task to execute
            invocation_state: Additional state/context passed to underlying agents.
                Defaults to None to avoid mutable default argument issues.
            **kwargs: Additional keyword arguments passed to underlying agents.
        """
        raise NotImplementedError("invoke_async not implemented")

    async def stream_async(
        self, task: MultiAgentInput, invocation_state: dict[str, Any] | None = None, **kwargs: Any
    ) -> AsyncIterator[dict[str, Any]]:
        """Stream events during multi-agent execution.

        Default implementation executes invoke_async and yields the result as a single event.
        Subclasses can override this method to provide true streaming capabilities.

        Args:
            task: The task to execute
            invocation_state: Additional state/context passed to underlying agents.
                Defaults to None to avoid mutable default argument issues.
            **kwargs: Additional keyword arguments passed to underlying agents.

        Yields:
            Dictionary events containing multi-agent execution information including:
            - Multi-agent coordination events (node start/complete, handoffs)
            - Forwarded single-agent events with node context
            - Final result event
        """
        # Default implementation for backward compatibility
        # Execute invoke_async and yield the result as a single event
        result = await self.invoke_async(task, invocation_state, **kwargs)
        yield {"result": result}

    def __call__(
        self, task: MultiAgentInput, invocation_state: dict[str, Any] | None = None, **kwargs: Any
    ) -> MultiAgentResult:
        """Invoke synchronously.

        Args:
            task: The task to execute
            invocation_state: Additional state/context passed to underlying agents.
                Defaults to None to avoid mutable default argument issues.
            **kwargs: Additional keyword arguments passed to underlying agents.
        """
        if invocation_state is None:
            invocation_state = {}

        if kwargs:
            invocation_state.update(kwargs)
            warnings.warn("`**kwargs` parameter is deprecating, use `invocation_state` instead.", stacklevel=2)

        return run_async(lambda: self.invoke_async(task, invocation_state))

    def serialize_state(self) -> dict[str, Any]:
        """Return a JSON-serializable snapshot of the orchestrator state."""
        raise NotImplementedError

    def deserialize_state(self, payload: dict[str, Any]) -> None:
        """Restore orchestrator state from a session dict."""
        raise NotImplementedError

    def add_hook(
        self, callback: HookCallback, event_type: type | list[type] | None = None, *, order: float = HookOrder.DEFAULT
    ) -> None:
        """Register a hook callback with the orchestrator.

        Subclasses that support hooks should override this method to register
        the callback with their hook registry.

        Args:
            callback: The callback function to invoke when events of this type occur.
            event_type: The class type(s) of events this callback should handle.
                Can be a single type, a list of types, or None to infer from
                the callback's first parameter type hint.
            order: Execution priority. Lower values execute first.
        """
        raise NotImplementedError(f"{type(self).__name__} must implement add_hook() to support plugins")

    def _parse_trace_attributes(
        self, attributes: Mapping[str, AttributeValue] | None = None
    ) -> dict[str, AttributeValue]:
        trace_attributes: dict[str, AttributeValue] = {}
        if attributes:
            for k, v in attributes.items():
                if isinstance(v, (str, int, float, bool)) or (
                    isinstance(v, list) and all(isinstance(x, (str, int, float, bool)) for x in v)
                ):
                    trace_attributes[k] = v
        return trace_attributes


# Private helper function to avoid duplicate code


def _parse_usage(usage_data: dict[str, Any]) -> Usage:
    """Parse Usage from dict data."""
    usage = Usage(
        inputTokens=usage_data.get("inputTokens", 0),
        outputTokens=usage_data.get("outputTokens", 0),
        totalTokens=usage_data.get("totalTokens", 0),
    )
    # Add optional fields if they exist
    if "cacheReadInputTokens" in usage_data:
        usage["cacheReadInputTokens"] = usage_data["cacheReadInputTokens"]
    if "cacheWriteInputTokens" in usage_data:
        usage["cacheWriteInputTokens"] = usage_data["cacheWriteInputTokens"]
    return usage


def _parse_metrics(metrics_data: dict[str, Any]) -> Metrics:
    """Parse Metrics from dict data."""
    return Metrics(latencyMs=metrics_data.get("latencyMs", 0))


def _accumulate_cache_usage(target: Usage, source: Usage) -> None:
    """Add source's optional cache token counters into target."""
    if "cacheReadInputTokens" in source:
        target["cacheReadInputTokens"] = target.get("cacheReadInputTokens", 0) + source["cacheReadInputTokens"]
    if "cacheWriteInputTokens" in source:
        target["cacheWriteInputTokens"] = target.get("cacheWriteInputTokens", 0) + source["cacheWriteInputTokens"]

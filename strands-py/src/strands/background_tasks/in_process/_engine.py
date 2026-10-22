"""Compatibility adapter for tool-shaped in-process background tasks."""

from __future__ import annotations

import copy
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import cast

from strands.background_tasks._errors import BackgroundTaskNotFoundError
from strands.background_tasks._types import BackgroundTaskError
from strands.types.tools import ToolResult

from ._task_engine import TaskEngine, TaskNotFoundError
from ._task_engine import _timestamp as _task_timestamp
from ._task_types import TaskExecutionContext, TaskOutcome, TaskRecord
from ._types import (
    CancelSignal,
    InProcessTaskExecutionContext,
    InProcessTaskExecutionOutcome,
    InProcessTaskRecord,
    InterruptStateData,
)


@dataclass(frozen=True)
class _ToolTaskInput:
    tool_use_id: str
    tool_name: str
    invocation_state_id: str


_ToolTaskRecord = TaskRecord[_ToolTaskInput, ToolResult]


class InProcessTaskEngine:
    """Run and track bounded tool-shaped tasks.

    This compatibility facade preserves the original background-task engine contract while
    delegating scheduling to the generic ``TaskEngine``.
    """

    def __init__(
        self,
        *,
        max_concurrency: int,
        timeout: float,
        execute: Callable[[InProcessTaskExecutionContext], Awaitable[InProcessTaskExecutionOutcome]],
        on_task_updated: Callable[[InProcessTaskRecord], None],
    ) -> None:
        """Initialize the engine.

        Args:
            max_concurrency: Maximum concurrent physical executions.
            timeout: Per-execution timeout in seconds, or infinity.
            execute: Callback that executes one task.
            on_task_updated: Best-effort committed-update callback.

        Raises:
            TypeError: If execution configuration is invalid.
        """

        async def execute_task(context: TaskExecutionContext[_ToolTaskInput]) -> TaskOutcome[ToolResult]:
            input = context.input
            legacy_context = InProcessTaskExecutionContext(
                task_id=context.task_id,
                tool_use_id=input.tool_use_id,
                tool_name=input.tool_name,
                invocation_state_id=input.invocation_state_id,
                cancel_signal=cast(CancelSignal, context.cancel_signal),
                state=context.state,
            )
            # Preserve the original engine's snapshot contract: an uncopyable result fails execution.
            outcome = copy.deepcopy(await execute(legacy_context))
            return cast(TaskOutcome[ToolResult], outcome)

        def notify(record: _ToolTaskRecord) -> None:
            on_task_updated(_to_legacy_record(record))

        self._engine = TaskEngine[_ToolTaskInput, ToolResult](
            max_concurrency=max_concurrency,
            timeout=timeout,
            execute=execute_task,
            on_task_updated=notify,
            cancel_signal_factory=CancelSignal,
        )
        # Retained for the task manager's internal idle-waiter inspection.
        self._idle_waiters = self._engine._idle_waiters

    def submit(self, *, tool_use_id: str, tool_name: str, invocation_state_id: str) -> InProcessTaskRecord:
        """Submit a task for execution."""
        record = self._engine.submit(
            _ToolTaskInput(
                tool_use_id=tool_use_id,
                tool_name=tool_name,
                invocation_state_id=invocation_state_id,
            )
        )
        return _to_legacy_record(record)

    def get(self, task_id: str) -> InProcessTaskRecord | None:
        """Return a task snapshot if it exists."""
        record = self._engine.get(task_id)
        return _to_legacy_record(record) if record is not None else None

    def list(self) -> list[InProcessTaskRecord]:
        """Return all task snapshots."""
        return [_to_legacy_record(record) for record in self._engine.list()]

    def remove(self, task_id: str) -> None:
        """Remove a terminal task."""
        try:
            self._engine.remove(task_id)
        except TaskNotFoundError as error:
            raise BackgroundTaskNotFoundError(task_id) from error
        except RuntimeError as error:
            raise RuntimeError(str(error).replace("Task ", "Background task ", 1)) from error

    def cancel(self, task_id: str, *, reason: str) -> InProcessTaskRecord:
        """Cancel a non-terminal task."""
        try:
            return _to_legacy_record(self._engine.cancel(task_id, reason=reason))
        except TaskNotFoundError as error:
            raise BackgroundTaskNotFoundError(task_id) from error

    async def wait_for_idle(self, *, cancel_signal: CancelSignal | None = None) -> None:
        """Wait until no task is queued or physically executing."""
        await self._engine.wait_for_idle(cancel_signal=cancel_signal)

    def resume(
        self,
        task_id: str,
        update: Callable[[InterruptStateData], tuple[InterruptStateData, bool]],
    ) -> InProcessTaskRecord:
        """Apply input to a task that requires it."""
        try:
            return _to_legacy_record(self._engine.resume(task_id, update))
        except TaskNotFoundError as error:
            raise BackgroundTaskNotFoundError(task_id) from error
        except RuntimeError as error:
            raise RuntimeError(str(error).replace("Task ", "Background task ", 1)) from error


def _to_legacy_record(record: _ToolTaskRecord) -> InProcessTaskRecord:
    input = record["input"]
    snapshot = InProcessTaskRecord(
        task_id=record["task_id"],
        tool_use_id=input.tool_use_id,
        tool_name=input.tool_name,
        invocation_state_id=input.invocation_state_id,
        status=record["status"],
        created_at=record["created_at"],
        last_updated_at=record["last_updated_at"],
    )
    if "state" in record:
        snapshot["state"] = copy.deepcopy(record["state"])
    if "result" in record:
        snapshot["result"] = copy.deepcopy(record["result"])
    if "failure" in record:
        failure = dict(record["failure"])
        if failure["message"] == "Task execution failed":
            failure["message"] = "Background task execution failed"
        snapshot["failure"] = cast(BackgroundTaskError, failure)
    return snapshot


def _timestamp() -> str:
    """Return the timestamp format retained by the background-task compatibility interface."""
    return _task_timestamp()

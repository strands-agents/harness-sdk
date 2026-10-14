"""Generic bounded in-process task execution."""

from __future__ import annotations

import asyncio
import copy
import math
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import partial
from typing import Generic
from uuid import uuid4

from ._task_types import (
    CompletedTaskOutcome,
    FailedTaskOutcome,
    TaskCancellation,
    TaskCancelSignal,
    TaskExecutionContext,
    TaskOutcome,
    TaskRecord,
    TaskState,
    TaskStatus,
    TInput,
    TResult,
)

_DEFAULT_EXECUTION_FAILURE_MESSAGE = "Task execution failed"


class TaskNotFoundError(KeyError):
    """Raised when a task identifier is not tracked by the engine."""

    def __init__(self, task_id: str) -> None:
        super().__init__(f"Task '{task_id}' was not found")
        self.task_id = task_id


@dataclass
class _ActiveExecution:
    cancel_signal: TaskCancellation
    timeout_handle: asyncio.TimerHandle | None = None


class TaskEngine(Generic[TInput, TResult]):
    """Run and track bounded in-process tasks with consumer-defined input and result types.

    The engine owns scheduling, concurrency, timeouts, cancellation, and status; it never
    interprets the task payload. ``execute`` receives the submitted ``TInput`` and returns a
    ``TResult`` on completion, so consumers such as background tools and background
    summarization each bring their own types.
    """

    def __init__(
        self,
        *,
        max_concurrency: int,
        timeout: float,
        execute: Callable[[TaskExecutionContext[TInput]], Awaitable[TaskOutcome[TResult]]],
        on_task_updated: Callable[[TaskRecord[TInput, TResult]], None],
        cancel_signal_factory: Callable[[], TaskCancellation] = TaskCancelSignal,
    ) -> None:
        """Initialize the engine.

        Args:
            max_concurrency: Maximum concurrent physical executions.
            timeout: Per-execution timeout in seconds, or infinity.
            execute: Callback that executes one task.
            on_task_updated: Best-effort committed-update callback.
            cancel_signal_factory: Creates the cancellation signal passed to each execution.

        Raises:
            TypeError: If execution configuration is invalid.
        """
        if isinstance(max_concurrency, bool) or not isinstance(max_concurrency, int) or max_concurrency <= 0:
            raise TypeError(f"max_concurrency must be a positive finite integer, got {max_concurrency}")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or math.isnan(timeout) or timeout <= 0:
            raise TypeError(f"timeout must be a positive number or infinity, got {timeout}")
        self._max_concurrency = max_concurrency
        self._timeout = timeout
        self._execute_callback = execute
        self._on_task_updated = on_task_updated
        self._cancel_signal_factory = cancel_signal_factory
        self._tasks: dict[str, TaskRecord[TInput, TResult]] = {}
        self._queue: dict[str, None] = {}
        self._active_executions: dict[str, _ActiveExecution] = {}
        self._idle_waiters: set[asyncio.Future[None]] = set()
        self._spawned_tasks: set[asyncio.Task[None]] = set()

    def submit(self, input: TInput) -> TaskRecord[TInput, TResult]:
        """Submit a task for execution.

        The input is stored on the record by reference and must stay immutable while the task is tracked.
        """
        now = _timestamp()
        stored = TaskRecord[TInput, TResult](
            task_id=str(uuid4()),
            input=input,
            status="queued",
            created_at=now,
            last_updated_at=now,
        )
        self._tasks[stored["task_id"]] = stored
        self._notify_task_updated(stored)
        self._schedule_task(stored["task_id"])
        return _snapshot(stored)

    def get(self, task_id: str) -> TaskRecord[TInput, TResult] | None:
        """Return a task snapshot if it exists."""
        task = self._tasks.get(task_id)
        return _snapshot(task) if task is not None else None

    def list(self) -> list[TaskRecord[TInput, TResult]]:
        """Return all task snapshots."""
        return [_snapshot(task) for task in self._tasks.values()]

    def remove(self, task_id: str) -> None:
        """Remove a terminal task."""
        task = self._require_task(task_id)
        if not _is_task_status_terminal(task["status"]):
            raise RuntimeError(f"Task '{task_id}' cannot be removed before reaching a terminal status")
        del self._tasks[task_id]

    def cancel(self, task_id: str, *, reason: str) -> TaskRecord[TInput, TResult]:
        """Cancel a non-terminal task."""
        current = self._require_task(task_id)
        if _is_task_status_terminal(current["status"]):
            return _snapshot(current)
        task = self._update_task(task_id, _cancel_task)
        assert task is not None
        self._queue.pop(task_id, None)
        active_execution = self._active_executions.get(task_id)
        if active_execution is not None:
            if active_execution.timeout_handle is not None:
                active_execution.timeout_handle.cancel()
                active_execution.timeout_handle = None
            active_execution.cancel_signal.abort(reason)
        self._wake_idle_waiters()
        return task

    async def wait_for_idle(self, *, cancel_signal: TaskCancellation | None = None) -> None:
        """Wait until no task is queued or physically executing."""
        while self._queue or self._active_executions:
            if cancel_signal is not None and cancel_signal.aborted:
                raise _exception_from_reason(cancel_signal.reason)
            await self._wait_for_idle_change(cancel_signal)

    async def _wait_for_idle_change(self, cancel_signal: TaskCancellation | None) -> None:
        loop = asyncio.get_running_loop()
        waiter = loop.create_future()
        self._idle_waiters.add(waiter)

        def wake_waiter() -> None:
            if not waiter.done():
                waiter.set_result(None)

        def on_abort() -> None:
            # Abort may arrive from another thread, and possibly after the loop closed.
            try:
                loop.call_soon_threadsafe(wake_waiter)
            except RuntimeError:
                pass

        if cancel_signal is not None:
            cancel_signal.add_abort_callback(on_abort)
        try:
            await waiter
        finally:
            if cancel_signal is not None:
                cancel_signal.remove_abort_callback(on_abort)
            self._idle_waiters.discard(waiter)
            if not waiter.done():
                waiter.cancel()

    def resume(
        self,
        task_id: str,
        update: Callable[[TaskState], tuple[TaskState, bool]],
    ) -> TaskRecord[TInput, TResult]:
        """Apply interrupt responses to a task that requires input."""

        def resume_task(record: TaskRecord[TInput, TResult]) -> bool:
            if record["status"] != "input_required":
                raise RuntimeError(
                    f"Task '{task_id}' cannot be resumed: status is '{record['status']}', not 'input_required'"
                )
            if "state" not in record:
                raise RuntimeError(f"Task '{task_id}' cannot be resumed: interrupt state is missing")
            state, ready = update(record["state"])
            record["state"] = state
            if ready:
                record["status"] = "queued"
            return True

        task = self._update_task(task_id, resume_task)
        assert task is not None
        if task["status"] == "queued":
            self._schedule_task(task_id)
        return task

    def _schedule_task(self, task_id: str) -> None:
        if task_id in self._active_executions:
            return
        self._queue[task_id] = None
        self._start_queued_tasks()

    def _start_queued_tasks(self) -> None:
        while len(self._active_executions) < self._max_concurrency and self._queue:
            task_id = next(iter(self._queue))
            del self._queue[task_id]
            active_execution = _ActiveExecution(cancel_signal=self._cancel_signal_factory())
            self._active_executions[task_id] = active_execution
            task = asyncio.create_task(self._execute(task_id, active_execution))
            self._spawned_tasks.add(task)
            task.add_done_callback(partial(self._finish_execution, task_id, active_execution))
            task.add_done_callback(self._spawned_tasks.discard)

    async def _execute(self, task_id: str, active_execution: _ActiveExecution) -> None:
        working = self._update_task(task_id, _mark_working)
        if working is None:
            return
        if math.isfinite(self._timeout):
            active_execution.timeout_handle = asyncio.get_running_loop().call_later(
                self._timeout,
                self._timeout_task,
                task_id,
                active_execution,
            )
        try:
            outcome = await self._execute_callback(
                TaskExecutionContext(
                    task_id=task_id,
                    input=working["input"],
                    state=working.get("state"),
                    cancel_signal=active_execution.cancel_signal,
                )
            )
        except Exception as error:
            outcome = FailedTaskOutcome(
                status="failed",
                failure={"type": "execution_error", "message": _execution_failure_message(error)},
            )
        try:
            self._finish_outcome(task_id, outcome)
        except Exception as error:
            self._finish_outcome(
                task_id,
                FailedTaskOutcome(
                    status="failed",
                    failure={"type": "execution_error", "message": _execution_failure_message(error)},
                ),
            )

    def _finish_execution(
        self,
        task_id: str,
        active_execution: _ActiveExecution,
        completed: asyncio.Task[None],
    ) -> None:
        if active_execution.timeout_handle is not None:
            active_execution.timeout_handle.cancel()
        self._active_executions.pop(task_id, None)
        current = self._tasks.get(task_id)
        if current is not None and current["status"] == "queued":
            self._queue[task_id] = None
        self._wake_idle_waiters()
        self._start_queued_tasks()
        try:
            completed.result()
        except asyncio.CancelledError:
            pass

    def _finish_outcome(self, task_id: str, outcome: TaskOutcome[TResult]) -> None:
        if outcome["status"] == "input_required":
            self._update_task(task_id, partial(_require_input, state=outcome["state"]))
            return
        self._update_task(task_id, partial(_finish_terminal_outcome, outcome=outcome))

    def _timeout_task(self, task_id: str, active_execution: _ActiveExecution) -> None:
        active_execution.timeout_handle = None
        reason = f"Timed out after {self._timeout}s"

        def time_out(record: TaskRecord[TInput, TResult]) -> bool:
            if record["status"] != "working":
                return False
            record["status"] = "failed"
            record.pop("state", None)
            record["failure"] = {"type": "timeout", "message": reason}
            return True

        task = self._update_task(task_id, time_out)
        if task is not None:
            active_execution.cancel_signal.abort(reason)

    def _update_task(
        self,
        task_id: str,
        update: Callable[[TaskRecord[TInput, TResult]], bool],
    ) -> TaskRecord[TInput, TResult] | None:
        current = self._require_task(task_id)
        next_task = _snapshot(current)
        if not update(next_task):
            return None
        next_task["last_updated_at"] = _timestamp()
        stored = _snapshot(next_task)
        self._tasks[task_id] = stored
        self._notify_task_updated(stored)
        return _snapshot(stored)

    def _require_task(self, task_id: str) -> TaskRecord[TInput, TResult]:
        task = self._tasks.get(task_id)
        if task is None:
            raise TaskNotFoundError(task_id)
        return task

    def _notify_task_updated(self, task: TaskRecord[TInput, TResult]) -> None:
        asyncio.get_running_loop().call_soon(self._run_notification, _snapshot(task))

    def _run_notification(self, task: TaskRecord[TInput, TResult]) -> None:
        try:
            self._on_task_updated(task)
        except Exception:
            pass

    def _wake_idle_waiters(self) -> None:
        for waiter in self._idle_waiters:
            if not waiter.done():
                waiter.set_result(None)
        self._idle_waiters.clear()


def _cancel_task(record: TaskRecord[TInput, TResult]) -> bool:
    record["status"] = "cancelled"
    record.pop("state", None)
    return True


def _mark_working(record: TaskRecord[TInput, TResult]) -> bool:
    if record["status"] != "queued":
        return False
    record["status"] = "working"
    return True


def _require_input(record: TaskRecord[TInput, TResult], *, state: TaskState) -> bool:
    if record["status"] != "working":
        return False
    record["status"] = "input_required"
    record["state"] = state
    return True


def _finish_terminal_outcome(
    record: TaskRecord[TInput, TResult],
    *,
    outcome: CompletedTaskOutcome[TResult] | FailedTaskOutcome[TResult],
) -> bool:
    if record["status"] != "working":
        return False
    record.pop("state", None)
    if outcome["status"] == "failed":
        record["status"] = "failed"
        record["failure"] = {
            "type": outcome["failure"]["type"],
            "message": outcome["failure"]["message"] or _DEFAULT_EXECUTION_FAILURE_MESSAGE,
        }
        if "result" in outcome:
            record["result"] = outcome["result"]
        return True
    record["status"] = "completed"
    record["result"] = outcome["result"]
    return True


def _execution_failure_message(error: Exception) -> str:
    try:
        return str(error) or _DEFAULT_EXECUTION_FAILURE_MESSAGE
    except Exception:
        return _DEFAULT_EXECUTION_FAILURE_MESSAGE


def _exception_from_reason(reason: object | None) -> BaseException:
    if isinstance(reason, BaseException):
        return reason
    return RuntimeError(str(reason) if reason is not None else "Operation cancelled")


def _snapshot(record: TaskRecord[TInput, TResult]) -> TaskRecord[TInput, TResult]:
    """Copy the engine-owned fields; ``input`` and ``result`` belong to the consumer and are shared by reference."""
    snapshot = dict(record)
    if "state" in record:
        snapshot["state"] = copy.deepcopy(record["state"])
    if "failure" in record:
        snapshot["failure"] = dict(record["failure"])
    return snapshot  # type: ignore[return-value]


def _is_task_status_terminal(status: TaskStatus) -> bool:
    return status in {"completed", "failed", "cancelled"}


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

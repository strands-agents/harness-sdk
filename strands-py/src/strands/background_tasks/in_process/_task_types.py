"""Generic types for bounded in-process task execution."""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Generic, Literal, Protocol, TypeAlias, TypeVar

from typing_extensions import NotRequired, TypedDict

TInput = TypeVar("TInput")
TResult = TypeVar("TResult")

TaskStatus: TypeAlias = Literal["queued", "working", "input_required", "completed", "failed", "cancelled"]
TaskState: TypeAlias = dict[str, Any]


class TaskFailure(TypedDict):
    """Failure recorded by the task engine."""

    type: str
    message: str


class TaskRecord(TypedDict, Generic[TInput, TResult]):
    """State tracked for one in-process task."""

    task_id: str
    input: TInput
    status: TaskStatus
    created_at: str
    last_updated_at: str
    state: NotRequired[TaskState]
    result: NotRequired[TResult]
    failure: NotRequired[TaskFailure]


class TaskCancellation(Protocol):
    """Cancellation behavior required by the task scheduler."""

    reason: object | None

    @property
    def aborted(self) -> bool:
        """Return whether cancellation was requested."""
        ...

    def abort(self, reason: object | None = None) -> None:
        """Request cancellation once."""
        ...

    def add_abort_callback(self, callback: Callable[[], None]) -> None:
        """Register a callback that runs when cancellation is requested."""
        ...

    def remove_abort_callback(self, callback: Callable[[], None]) -> None:
        """Unregister a cancellation callback."""
        ...


class TaskCancelSignal(threading.Event):
    """Thread-compatible cancellation signal with an abort reason."""

    def __init__(self) -> None:
        """Initialize an unset signal."""
        super().__init__()
        self.reason: object | None = None
        self._abort_callbacks: list[Callable[[], None]] = []
        self._callback_lock = threading.Lock()

    @property
    def aborted(self) -> bool:
        """Return whether cancellation was requested."""
        return self.is_set()

    def abort(self, reason: object | None = None) -> None:
        """Request cancellation once."""
        with self._callback_lock:
            if self.is_set():
                return
            self.reason = reason
            self.set()
            callbacks = self._abort_callbacks
            self._abort_callbacks = []
        for callback in callbacks:
            callback()

    def add_abort_callback(self, callback: Callable[[], None]) -> None:
        """Invoke callback on abort, immediately if already aborted.

        The callback runs on the aborting thread and must be thread-safe.
        """
        with self._callback_lock:
            if not self.is_set():
                self._abort_callbacks.append(callback)
                return
        callback()

    def remove_abort_callback(self, callback: Callable[[], None]) -> None:
        """Unregister a previously added callback."""
        with self._callback_lock:
            if callback in self._abort_callbacks:
                self._abort_callbacks.remove(callback)


@dataclass(frozen=True)
class TaskExecutionContext(Generic[TInput]):
    """Context supplied to one task execution."""

    task_id: str
    input: TInput
    cancel_signal: TaskCancellation
    state: TaskState | None = None


class CompletedTaskOutcome(TypedDict, Generic[TResult]):
    """Successful task outcome."""

    status: Literal["completed"]
    result: TResult


class InputRequiredTaskOutcome(TypedDict):
    """Task outcome requiring input before it can run again."""

    status: Literal["input_required"]
    state: TaskState


class FailedTaskOutcome(TypedDict, Generic[TResult]):
    """Failed task outcome."""

    status: Literal["failed"]
    failure: TaskFailure
    result: NotRequired[TResult]


TaskOutcome: TypeAlias = CompletedTaskOutcome[TResult] | InputRequiredTaskOutcome | FailedTaskOutcome[TResult]

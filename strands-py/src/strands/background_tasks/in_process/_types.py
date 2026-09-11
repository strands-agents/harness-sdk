"""Internal types for in-process background task execution."""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, TypeAlias

from typing_extensions import NotRequired, TypedDict

from strands.background_tasks._types import BackgroundTaskError, BackgroundTaskStatus
from strands.types.tools import ToolResult

InterruptStateData: TypeAlias = dict[str, Any]


class InProcessTaskRecord(TypedDict):
    """State tracked for one in-process task."""

    task_id: str
    tool_use_id: str
    tool_name: str
    invocation_state_id: str
    status: BackgroundTaskStatus
    created_at: str
    last_updated_at: str
    state: NotRequired[InterruptStateData]
    result: NotRequired[ToolResult]
    failure: NotRequired[BackgroundTaskError]


class CancelSignal(threading.Event):
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
class InProcessTaskExecutionContext:
    """Context supplied to one task execution."""

    task_id: str
    tool_use_id: str
    tool_name: str
    invocation_state_id: str
    cancel_signal: CancelSignal
    state: InterruptStateData | None = None


class CompletedTaskExecutionOutcome(TypedDict):
    """Successful task outcome."""

    status: Literal["completed"]
    result: ToolResult


class InputRequiredTaskExecutionOutcome(TypedDict):
    """Task outcome requiring input."""

    status: Literal["input_required"]
    state: InterruptStateData


class FailedTaskExecutionOutcome(TypedDict):
    """Failed task outcome."""

    status: Literal["failed"]
    failure: BackgroundTaskError
    result: NotRequired[ToolResult]


InProcessTaskExecutionOutcome: TypeAlias = (
    CompletedTaskExecutionOutcome | InputRequiredTaskExecutionOutcome | FailedTaskExecutionOutcome
)

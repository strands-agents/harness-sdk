"""Background task configuration and internal task snapshots."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Literal, TypeAlias

from typing_extensions import NotRequired, TypedDict

from strands.types.tools import AgentTool, ToolResultContent


class BackgroundTasksConfig(TypedDict, total=False):
    """Configure background tool execution.

    Attributes:
        wait_for_completion: Wait for background work before an invocation returns. Defaults to True.
        agentic: Tools or registered tool names whose execution mode is selected by the model.
            Defaults to ``["*"]``.
        always: Tools or registered tool names that always execute in the background.
        never: Tools or registered tool names that never execute in the background.
        max_concurrency: Maximum number of physically executing background tasks. Defaults to 4.
        timeout: Per-execution timeout in seconds. Defaults to infinity.
    """

    wait_for_completion: bool
    agentic: Sequence[AgentTool | str]
    always: Sequence[AgentTool | str]
    never: Sequence[AgentTool | str]
    max_concurrency: int
    timeout: float


BackgroundTaskStatus: TypeAlias = Literal[
    "queued",
    "working",
    "input_required",
    "completed",
    "failed",
    "cancelled",
]
BackgroundTaskFailureType: TypeAlias = Literal["tool_error", "execution_error", "timeout"]


class BackgroundTaskResult(TypedDict):
    """Visible background task result."""

    content: list[ToolResultContent]


class BackgroundTaskError(TypedDict):
    """Background task failure details."""

    type: BackgroundTaskFailureType
    message: str


class BackgroundTaskInterrupt(TypedDict):
    """Visible unanswered background task interrupt."""

    id: str
    name: str
    reason: object
    source: Literal["middleware", "tool"]


class BackgroundTask(TypedDict):
    """Snapshot of one background task."""

    task_id: str
    tool_use_id: str
    tool_name: str
    status: BackgroundTaskStatus
    created_at: str
    last_updated_at: str
    result: NotRequired[BackgroundTaskResult]
    error: NotRequired[BackgroundTaskError]
    interrupts: NotRequired[list[BackgroundTaskInterrupt]]


def is_task_status_terminal(status: BackgroundTaskStatus) -> bool:
    """Return whether a task status is terminal."""
    return status in {"completed", "failed", "cancelled"}

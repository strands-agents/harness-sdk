"""Types and configuration for MCP task-augmented tool execution.

This surface is experimental and subject to change. The finalized SEP-2663
models require mcp 2.x (``MCPCreateTaskResult``, ``MCPGetTaskResult``, and the
other task result types). On the runtime pin ``mcp<2.0.0`` they cannot
round-trip server JSON; the corresponding client methods raise ``RuntimeError``.
"""

from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Annotated, Any, Literal

from mcp.types import (
    CallToolResult,
    CreateMessageRequest,
    CreateMessageResult,
    CreateMessageResultWithTools,
    ElicitRequest,
    ElicitResult,
    ListRootsRequest,
    ListRootsResult,
    Request,
    RequestParams,
    Result,
)
from pydantic import Field, field_validator, model_validator
from typing_extensions import Self, TypedDict

_TASKS_EXTENSION = "io.modelcontextprotocol/tasks"
_TASKS_PROTOCOL_VERSION = "2026-07-28"

MCPTaskStatus = Literal["working", "input_required", "completed", "failed", "cancelled"]
MCPCallToolResult = CallToolResult
MCPInputRequest = CreateMessageRequest | ListRootsRequest | ElicitRequest
MCPInputResponse = CreateMessageResult | CreateMessageResultWithTools | ListRootsResult | ElicitResult
MCPInputRequests = dict[str, MCPInputRequest]
MCPInputResponses = dict[str, MCPInputResponse]
_NonNegativeInteger = Annotated[int, Field(ge=0, strict=True)]


def _parse_task_timestamp(value: str) -> datetime:
    """Parse an ISO 8601 task timestamp, accepting both ``Z`` and numeric UTC offsets."""
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class TasksConfig(TypedDict, total=False):
    """Configuration for MCP task-augmented tool execution.

    Experimental: this configuration and the task lifecycle it enables are
    subject to change as MCP Tasks evolve.

    On MCP 2.x, enabling this configuration advertises the SEP-2663 Tasks
    extension and automatically completes task handles returned by tools.
    On MCP 1.x, the legacy 2025-11-25 task flow remains supported.

    Attributes:
        poll_timeout: Overall timeout for task completion. Defaults to 5 minutes.
        request_timeout: Timeout for each task lifecycle request. Defaults to 1 minute.
        poll_interval: Polling delay when the server omits ``pollIntervalMs``.
            Defaults to 1 second.
        ttl: Legacy 2025-11-25 task time-to-live. Defaults to 1 minute.
    """

    poll_timeout: timedelta
    request_timeout: timedelta
    poll_interval: timedelta
    ttl: timedelta


class MCPTaskError(Result):
    """JSON-RPC error stored by a failed MCP task."""

    code: int
    message: str
    data: Any = None


class MCPTask(Result):
    """Operational state shared by every SEP-2663 task result."""

    task_id: Annotated[str, Field(min_length=1)]
    status: MCPTaskStatus
    status_message: str | None = None
    created_at: str
    last_updated_at: str
    # SEP-2663 requires ttlMs on every task object; null means the server did not
    # advertise a TTL. Omitting the field is a validation error.
    ttl_ms: _NonNegativeInteger | None
    poll_interval_ms: _NonNegativeInteger | None = None

    @field_validator("created_at", "last_updated_at")
    @classmethod
    def validate_timestamp(cls, value: str) -> str:
        """Validate an ISO 8601 timestamp with a UTC offset."""
        parsed = _parse_task_timestamp(value)
        if parsed.tzinfo is None:
            raise ValueError("MCP task timestamps require a UTC offset")
        return value

    @model_validator(mode="after")
    def validate_chronology(self) -> Self:
        """Validate that the task update does not predate its creation."""
        created_at = _parse_task_timestamp(self.created_at)
        last_updated_at = _parse_task_timestamp(self.last_updated_at)
        if last_updated_at < created_at:
            raise ValueError("MCP task lastUpdatedAt must not precede createdAt")
        return self


class MCPCreateTaskResult(MCPTask):
    """Task handle returned instead of an immediate tool result."""

    result_type: Literal["task"]


class MCPGetTaskResult(MCPTask):
    """Status-specific task state returned by ``tasks/get``."""

    result_type: Literal["complete"]
    input_requests: MCPInputRequests | None = None
    result: CallToolResult | None = None
    error: MCPTaskError | None = None

    @model_validator(mode="before")
    @classmethod
    def validate_status_fields(cls, value: Any) -> Any:
        """Reject status-specific fields on every other task status."""
        if not isinstance(value, Mapping):
            return value
        status = value.get("status")
        allowed_by_status = {
            "input_required": "inputRequests",
            "completed": "result",
            "failed": "error",
        }
        allowed = allowed_by_status.get(status) if isinstance(status, str) else None
        for field in ("inputRequests", "result", "error"):
            if field != allowed and field in value:
                raise ValueError(f'MCP task status "{status}" contains an unexpected status-specific payload')
        return value

    @model_validator(mode="after")
    def validate_status_payload(self) -> Self:
        """Validate the payload associated with the task's current status."""
        payloads = {
            "input_required": self.input_requests,
            "completed": self.result,
            "failed": self.error,
        }
        if self.status in payloads and payloads[self.status] is None:
            raise ValueError(f'MCP task status "{self.status}" requires its status-specific payload')
        return self


class _MCPTaskAcknowledgement(Result):
    """Validated empty acknowledgement for a task lifecycle operation."""

    result_type: Literal["complete"]

    @model_validator(mode="before")
    @classmethod
    def validate_empty_acknowledgement(cls, value: Any) -> Any:
        """Reject task state in an operation's empty acknowledgement."""
        task_fields = {
            "taskId",
            "status",
            "statusMessage",
            "createdAt",
            "lastUpdatedAt",
            "ttlMs",
            "pollIntervalMs",
            "inputRequests",
            "result",
            "error",
        }
        if isinstance(value, Mapping) and task_fields.intersection(value):
            raise ValueError("MCP task acknowledgement must not contain task state")
        return value


class MCPUpdateTaskResult(_MCPTaskAcknowledgement):
    """Acknowledgement returned by ``tasks/update``."""


class MCPCancelTaskResult(_MCPTaskAcknowledgement):
    """Acknowledgement returned by ``tasks/cancel``."""


class _GetTaskRequestParams(RequestParams):
    task_id: str


class _GetTaskRequest(Request[_GetTaskRequestParams, Literal["tasks/get"]]):
    method: Literal["tasks/get"] = "tasks/get"
    params: _GetTaskRequestParams


_GetTaskRequest.name_param = "taskId"  # type: ignore[attr-defined]


class _UpdateTaskRequestParams(RequestParams):
    task_id: str
    input_responses: MCPInputResponses


class _UpdateTaskRequest(Request[_UpdateTaskRequestParams, Literal["tasks/update"]]):
    method: Literal["tasks/update"] = "tasks/update"
    params: _UpdateTaskRequestParams


_UpdateTaskRequest.name_param = "taskId"  # type: ignore[attr-defined]


class _CancelTaskRequestParams(RequestParams):
    task_id: str


class _CancelTaskRequest(Request[_CancelTaskRequestParams, Literal["tasks/cancel"]]):
    method: Literal["tasks/cancel"] = "tasks/cancel"
    params: _CancelTaskRequestParams


_CancelTaskRequest.name_param = "taskId"  # type: ignore[attr-defined]


DEFAULT_TASK_TTL = timedelta(minutes=1)
DEFAULT_TASK_POLL_TIMEOUT = timedelta(minutes=5)
DEFAULT_TASK_REQUEST_TIMEOUT = timedelta(minutes=1)
DEFAULT_TASK_POLL_INTERVAL = timedelta(seconds=1)
DEFAULT_TASK_CONFIG = TasksConfig(
    ttl=DEFAULT_TASK_TTL,
    poll_timeout=DEFAULT_TASK_POLL_TIMEOUT,
    request_timeout=DEFAULT_TASK_REQUEST_TIMEOUT,
    poll_interval=DEFAULT_TASK_POLL_INTERVAL,
)


__all__ = [
    "DEFAULT_TASK_CONFIG",
    "DEFAULT_TASK_POLL_INTERVAL",
    "DEFAULT_TASK_POLL_TIMEOUT",
    "DEFAULT_TASK_REQUEST_TIMEOUT",
    "DEFAULT_TASK_TTL",
    "MCPCallToolResult",
    "MCPCancelTaskResult",
    "MCPCreateTaskResult",
    "MCPGetTaskResult",
    "MCPInputRequest",
    "MCPInputRequests",
    "MCPInputResponse",
    "MCPInputResponses",
    "MCPTask",
    "MCPTaskError",
    "MCPTaskStatus",
    "MCPUpdateTaskResult",
    "TasksConfig",
]

"""Tests for finalized SEP-2663 Tasks support on mcp 2.x."""

import asyncio
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Any
from unittest.mock import MagicMock

import pytest
from mcp.types import CallToolResult, TextContent
from pydantic import ValidationError

from strands.tools.mcp import (
    MCPCancelTaskResult,
    MCPClient,
    MCPCreateTaskResult,
    MCPGetTaskResult,
    MCPUpdateTaskResult,
)
from strands.tools.mcp._compat import MCP_V2, MCPError
from strands.types.exceptions import MCPClientInitializationError

pytestmark = pytest.mark.skipif(not MCP_V2, reason="requires mcp 2.x")

TASK_BASE = {
    "taskId": "task-1",
    "createdAt": "2026-09-01T00:00:00Z",
    "lastUpdatedAt": "2026-09-01T00:00:01Z",
    "ttlMs": None,
    "pollIntervalMs": 0,
}


class FakeTaskSession:
    """Minimal MCP 2.x session fake for task protocol tests."""

    protocol_version = "2026-07-28"

    def __init__(self, responses: dict[str, list[Any]] | None = None) -> None:
        self.responses = responses or {}
        self.requests: list[dict[str, Any]] = []
        self.tool_calls: list[dict[str, Any]] = []
        self.input_requests: list[Any] = []

    async def send_request(
        self,
        request: Any,
        result_type: type[Any],
        request_read_timeout_seconds: float | None = None,
    ) -> Any:
        dumped = request.model_dump(by_alias=True, mode="json", exclude_none=True)
        dumped["timeout"] = request_read_timeout_seconds
        dumped["name_param"] = type(request).name_param
        self.requests.append(dumped)
        return result_type.model_validate(self.responses[request.method].pop(0))

    async def call_tool(self, name: str, arguments: dict[str, Any] | None, timeout: float | None, **kwargs: Any) -> Any:
        self.tool_calls.append({"name": name, "arguments": arguments, "timeout": timeout, **kwargs})
        return self.responses["tools/call"].pop(0)

    async def dispatch_input_request(self, context: Any, request: Any) -> Any:
        from mcp.types import ElicitResult

        self.input_requests.append((context, request))
        return ElicitResult.model_validate({"action": "accept", "content": {"approved": True}})


def task_client(session: FakeTaskSession) -> MCPClient:
    """Create a disconnected client wired directly to a fake MCP 2.x session."""
    client = MCPClient(lambda: None, tasks_config={"poll_interval": timedelta(microseconds=1)})
    client._background_thread_session = session
    client._server_task_capable = True
    return client


def create_task(status: str = "working") -> MCPCreateTaskResult:
    """Create a valid task handle."""
    return MCPCreateTaskResult.model_validate({**TASK_BASE, "resultType": "task", "status": status})


def test_public_task_lifecycle_over_real_mcp_transport() -> None:
    """Test public task APIs, negotiation, decoding, and routing headers end to end."""
    import httpx2
    from mcp.client.streamable_http import streamable_http_client
    from mcp.server import MCPServer
    from mcp.server.context import CallNext, HandlerResult, ServerRequestContext
    from mcp.server.extension import Extension, MethodBinding
    from mcp_types import CallToolRequestParams
    from pydantic import BaseModel, Field

    class GetTaskParams(BaseModel):
        task_id: str = Field(alias="taskId")

    class UpdateTaskParams(GetTaskParams):
        input_responses: dict[str, Any] = Field(alias="inputResponses")

    seen_headers: dict[str, dict[str, str | None]] = {}

    def completed(task_id: str) -> dict[str, Any]:
        return {
            **TASK_BASE,
            "resultType": "complete",
            "taskId": task_id,
            "status": "completed",
            "result": {
                "resultType": "complete",
                "content": [{"type": "text", "text": "completed"}],
                "isError": False,
            },
        }

    class TasksExtension(Extension):
        identifier = "io.modelcontextprotocol/tasks"

        def methods(self) -> tuple[MethodBinding, ...]:
            versions = frozenset({"2026-07-28"})
            return (
                MethodBinding("tasks/get", GetTaskParams, self.get_task, versions),
                MethodBinding("tasks/update", UpdateTaskParams, self.update_task, versions),
                MethodBinding("tasks/cancel", GetTaskParams, self.cancel_task, versions),
            )

        @staticmethod
        def record(context: ServerRequestContext[Any, Any]) -> None:
            seen_headers[context.method] = {
                "mcp-method": context.request.headers.get("mcp-method"),
                "mcp-name": context.request.headers.get("mcp-name"),
            }

        async def get_task(self, context: ServerRequestContext[Any, Any], params: GetTaskParams) -> HandlerResult:
            self.record(context)
            return completed(params.task_id)

        async def update_task(self, context: ServerRequestContext[Any, Any], params: UpdateTaskParams) -> HandlerResult:
            self.record(context)
            assert params.input_responses == {"request-1": {"action": "decline"}}
            return {"resultType": "complete"}

        async def cancel_task(self, context: ServerRequestContext[Any, Any], params: GetTaskParams) -> HandlerResult:
            self.record(context)
            return {"resultType": "complete"}

        async def intercept_tool_call(
            self,
            params: CallToolRequestParams,
            context: ServerRequestContext[Any, Any],
            call_next: CallNext,
        ) -> HandlerResult:
            _ = (context, call_next)
            if params.name == "direct-runtime":
                return {
                    "resultType": "complete",
                    "content": [{"type": "text", "text": "direct"}],
                    "isError": False,
                }
            return {
                **TASK_BASE,
                "resultType": "task",
                "taskId": "task-runtime",
                "status": "working",
            }

    server = MCPServer("sep2663-test", extensions=[TasksExtension()])
    app = server.streamable_http_app(json_response=True, stateless_http=True)

    @asynccontextmanager
    async def transport() -> Any:
        async with app.router.lifespan_context(app):
            async with httpx2.AsyncClient(
                transport=httpx2.ASGITransport(app=app),
                base_url="http://127.0.0.1:8000",
            ) as http_client:
                async with streamable_http_client(
                    url="http://127.0.0.1:8000/mcp",
                    http_client=http_client,
                ) as streams:
                    yield streams

    client = MCPClient(transport, tasks_config={"poll_interval": timedelta(milliseconds=1)})
    with client:
        task = client.submit_tool_sync("task-runtime")
        assert isinstance(task, MCPCreateTaskResult)
        assert client.get_task_sync(task.task_id).status == "completed"
        assert isinstance(
            client.update_task_sync(task.task_id, {"request-1": {"action": "decline"}}),
            MCPUpdateTaskResult,
        )
        assert isinstance(client.cancel_task_sync(task.task_id), MCPCancelTaskResult)

        async def exercise_async_lifecycle() -> None:
            async_task = await client.submit_tool_async("task-runtime")
            assert isinstance(async_task, MCPCreateTaskResult)
            state = await client.get_task_async(async_task.task_id)
            assert state.status == "completed"
            assert isinstance(
                await client.update_task_async(async_task.task_id, {"request-1": {"action": "decline"}}),
                MCPUpdateTaskResult,
            )
            assert isinstance(await client.cancel_task_async(async_task.task_id), MCPCancelTaskResult)

        asyncio.run(exercise_async_lifecycle())

        auto = client.call_tool_sync(tool_use_id="auto", name="auto-runtime", arguments={})
        direct = client.call_tool_sync(tool_use_id="direct", name="direct-runtime", arguments={})

    assert auto["content"][0]["text"] == "completed"
    assert direct["content"][0]["text"] == "direct"
    assert seen_headers == {
        method: {"mcp-method": method, "mcp-name": "task-runtime"}
        for method in ("tasks/get", "tasks/update", "tasks/cancel")
    }


@pytest.mark.parametrize(
    "model,value",
    [
        (
            MCPGetTaskResult,
            {**TASK_BASE, "resultType": "complete", "status": "completed"},
        ),
        (
            MCPCreateTaskResult,
            {
                **TASK_BASE,
                "resultType": "task",
                "status": "working",
                "lastUpdatedAt": "2025-09-01T00:00:00Z",
            },
        ),
        (
            MCPUpdateTaskResult,
            {"resultType": "complete", "taskId": "unexpected"},
        ),
        (
            MCPCreateTaskResult,
            {**TASK_BASE, "status": "working"},
        ),
        (
            MCPGetTaskResult,
            {**TASK_BASE, "status": "working"},
        ),
        (
            MCPGetTaskResult,
            {**TASK_BASE, "resultType": "complete", "status": "working", "result": None},
        ),
        (
            MCPGetTaskResult,
            {
                **TASK_BASE,
                "resultType": "complete",
                "status": "input_required",
                "inputRequests": {"request-1": {"method": "invalid/request"}},
            },
        ),
        (
            MCPUpdateTaskResult,
            {},
        ),
        (
            MCPCreateTaskResult,
            {**TASK_BASE, "resultType": "task", "status": "working", "createdAt": "2026-09-01T00:00:00"},
        ),
        (
            MCPGetTaskResult,
            "not-a-mapping",
        ),
    ],
)
def test_task_models_reject_malformed_status_shapes(model: type[Any], value: Any) -> None:
    """Test task models reject invalid payloads, chronology, and acknowledgements."""
    with pytest.raises(ValidationError):
        model.model_validate(value)


@pytest.mark.asyncio
async def test_task_lifecycle_rejects_invalid_responses() -> None:
    """Test lifecycle operations reject mismatched task IDs and invalid input."""
    session = FakeTaskSession(
        {
            "tasks/get": [{**TASK_BASE, "taskId": "different-task", "resultType": "complete", "status": "working"}],
        }
    )
    client = task_client(session)

    with pytest.raises(ValueError, match="different taskId"):
        await client._get_task_async("task-1")
    with pytest.raises(ValidationError):
        await client._update_task_async("task-1", {"request-1": "invalid"})  # type: ignore[dict-item]


@pytest.mark.asyncio
async def test_task_aware_call_retries_request_state_with_fresh_call() -> None:
    """Test core input requests are dispatched and echoed before returning a task."""
    from mcp.types import InputRequiredResult

    task = create_task()
    input_request = {
        "method": "elicitation/create",
        "params": {
            "mode": "form",
            "message": "Approve?",
            "requestedSchema": {"type": "object"},
        },
    }
    session = FakeTaskSession(
        {
            "tools/call": [
                InputRequiredResult.model_validate(
                    {
                        "inputRequests": {"request-1": input_request},
                        "requestState": "opaque-state",
                    }
                ),
                task,
            ]
        }
    )
    client = task_client(session)

    result = await client._call_tool_with_task_once_async("slow-tool", {"value": 1}, timedelta(seconds=2), None, None)

    assert result == task
    assert len(session.tool_calls) == 2
    assert session.tool_calls[0]["request_state"] is None
    assert session.tool_calls[1]["request_state"] == "opaque-state"
    assert session.tool_calls[1]["input_responses"]["request-1"].action == "accept"
    assert len(session.input_requests) == 1


@pytest.mark.asyncio
async def test_task_completion_handles_input_and_returns_nested_tool_result() -> None:
    """Test input-required task state is updated before completion."""
    input_request = {
        "method": "elicitation/create",
        "params": {
            "mode": "form",
            "message": "Approve?",
            "requestedSchema": {"type": "object"},
        },
    }
    completed_result = CallToolResult(content=[TextContent(type="text", text="done")], is_error=False)
    session = FakeTaskSession(
        {
            "tasks/get": [
                {
                    **TASK_BASE,
                    "resultType": "complete",
                    "status": "input_required",
                    "inputRequests": {"request-1": input_request},
                },
                {
                    **TASK_BASE,
                    "resultType": "complete",
                    "status": "completed",
                    "result": completed_result.model_dump(by_alias=True, mode="json"),
                },
            ],
            "tasks/update": [{"resultType": "complete"}],
        }
    )
    client = task_client(session)

    result = await client._complete_v2_task(
        create_task("input_required"),
        cancellation_state={},
    )

    assert result == completed_result
    assert len(session.input_requests) == 1
    update = next(request for request in session.requests if request["method"] == "tasks/update")
    assert update["params"]["inputResponses"]["request-1"] == {
        "action": "accept",
        "content": {"approved": True},
    }


@pytest.mark.asyncio
async def test_task_completion_answers_each_input_request_key_once() -> None:
    """Test a re-reported input request key is deduplicated, not re-dispatched."""
    input_request = {
        "method": "elicitation/create",
        "params": {
            "mode": "form",
            "message": "Approve?",
            "requestedSchema": {"type": "object"},
        },
    }
    input_required = {
        **TASK_BASE,
        "resultType": "complete",
        "status": "input_required",
        "inputRequests": {"request-1": input_request},
    }
    session = FakeTaskSession(
        {
            "tasks/get": [
                input_required,
                {**input_required, "lastUpdatedAt": "2026-09-01T00:00:02Z"},
                completed_state(lastUpdatedAt="2026-09-01T00:00:03Z"),
            ],
            "tasks/update": [{"resultType": "complete"}],
        }
    )
    client = task_client(session)

    result = await client._complete_v2_task(create_task("input_required"), None)

    assert result.content[0].text == "done"
    assert len(session.input_requests) == 1
    assert sum(1 for request in session.requests if request["method"] == "tasks/update") == 1


@pytest.mark.asyncio
async def test_task_completion_ignores_stale_detailed_state() -> None:
    """Test polling does not regress after observing a newer detailed state."""
    completed_result = CallToolResult(content=[TextContent(type="text", text="done")], is_error=False)
    session = FakeTaskSession(
        {
            "tasks/get": [
                {
                    **TASK_BASE,
                    "resultType": "complete",
                    "status": "working",
                    "lastUpdatedAt": "2026-09-01T00:00:10Z",
                },
                {
                    **TASK_BASE,
                    "resultType": "complete",
                    "status": "completed",
                    "lastUpdatedAt": "2026-09-01T00:00:05Z",
                    "result": completed_result.model_dump(by_alias=True, mode="json"),
                },
                {
                    **TASK_BASE,
                    "resultType": "complete",
                    "status": "completed",
                    "lastUpdatedAt": "2026-09-01T00:00:11Z",
                    "result": completed_result.model_dump(by_alias=True, mode="json"),
                },
            ]
        }
    )
    client = task_client(session)

    result = await client._complete_v2_task(create_task(), cancellation_state={})

    assert result == completed_result
    assert [request["method"] for request in session.requests] == ["tasks/get", "tasks/get", "tasks/get"]


@pytest.mark.parametrize(
    "state,message",
    [
        ({"status": "failed", "error": {"code": -32000, "message": "boom"}}, "boom"),
        ({"status": "cancelled", "statusMessage": "stopped"}, "stopped"),
    ],
)
@pytest.mark.asyncio
async def test_task_completion_maps_terminal_errors(state: dict[str, Any], message: str) -> None:
    """Test failed and cancelled tasks become tool errors."""
    session = FakeTaskSession({"tasks/get": [{**TASK_BASE, "resultType": "complete", **state}]})
    client = task_client(session)

    result = await client._complete_v2_task(create_task(), None)

    assert result.is_error is True
    assert result.content[0].text == message


@pytest.mark.asyncio
async def test_input_request_error_response_fails_the_task_call() -> None:
    """Test an ErrorData answer to an input request surfaces as an MCP error."""
    from mcp.types import ErrorData

    input_request = {
        "method": "elicitation/create",
        "params": {
            "mode": "form",
            "message": "Approve?",
            "requestedSchema": {"type": "object"},
        },
    }
    session = FakeTaskSession(
        {
            "tasks/get": [
                {
                    **TASK_BASE,
                    "resultType": "complete",
                    "status": "input_required",
                    "inputRequests": {"request-1": input_request},
                }
            ]
        }
    )

    async def dispatch_error(context: Any, request: Any) -> Any:
        _ = (context, request)
        return ErrorData(code=-32000, message="denied")

    session.dispatch_input_request = dispatch_error  # type: ignore[method-assign]
    client = task_client(session)

    with pytest.raises(MCPError, match="denied"):
        await client._complete_v2_task(create_task("input_required"), None)


@pytest.mark.asyncio
async def test_task_timeout_requests_remote_cancellation() -> None:
    """Test an overall task timeout best-effort cancels the server task."""
    task = create_task()
    session = FakeTaskSession(
        {
            "tools/call": [task],
            "tasks/get": [{**TASK_BASE, "resultType": "complete", "status": "working"}],
            "tasks/cancel": [{"resultType": "complete"}],
        }
    )
    client = task_client(session)
    cancellation_state: dict[str, Any] = {}

    result = await client._call_tool_with_task_and_poll_async(
        "slow-tool",
        poll_timeout=timedelta(milliseconds=1),
        cancellation_state=cancellation_state,
    )

    assert result.is_error is True
    assert "timed out" in result.content[0].text
    assert any(request["method"] == "tasks/cancel" for request in session.requests)


def completed_state(**overrides: Any) -> dict[str, Any]:
    """Build a completed tasks/get payload."""
    result = CallToolResult(content=[TextContent(type="text", text="done")], is_error=False)
    return {
        **TASK_BASE,
        "resultType": "complete",
        "status": "completed",
        "result": result.model_dump(by_alias=True, mode="json"),
        **overrides,
    }


@pytest.mark.asyncio
async def test_task_completion_accepts_equivalent_timestamp_spellings() -> None:
    """Test reconciliation treats the same instant spelled differently as unchanged."""
    session = FakeTaskSession(
        {
            "tasks/get": [
                completed_state(
                    createdAt="2026-09-01T00:00:00+00:00",
                    lastUpdatedAt="2026-09-01T00:00:01.000+00:00",
                )
            ]
        }
    )
    client = task_client(session)

    result = await client._complete_v2_task(create_task(), None)

    assert result.is_error is False
    assert result.content[0].text == "done"


@pytest.mark.asyncio
async def test_task_completion_rejects_changed_created_at() -> None:
    """Test a poll response reporting a different creation instant is contradictory."""
    session = FakeTaskSession(
        {"tasks/get": [completed_state(createdAt="2026-09-01T00:00:59Z", lastUpdatedAt="2026-09-01T00:01:00Z")]}
    )
    client = task_client(session)

    with pytest.raises(ValueError, match="changed createdAt"):
        await client._complete_v2_task(create_task(), None)


@pytest.mark.asyncio
async def test_task_completion_retries_stale_first_read() -> None:
    """Test a first read older than the task handle is re-polled, not fatal."""
    session = FakeTaskSession(
        {
            "tasks/get": [
                {
                    **TASK_BASE,
                    "resultType": "complete",
                    "status": "working",
                    "lastUpdatedAt": "2026-09-01T00:00:00.500Z",
                },
                completed_state(lastUpdatedAt="2026-09-01T00:00:02Z"),
            ]
        }
    )
    client = task_client(session)

    result = await client._complete_v2_task(create_task(), None)

    assert result.content[0].text == "done"
    assert [request["method"] for request in session.requests] == ["tasks/get", "tasks/get"]


@pytest.mark.asyncio
async def test_reconciliation_failure_cancels_server_task() -> None:
    """Test a poll-loop exit other than a timeout still cancels the created task."""
    session = FakeTaskSession(
        {
            "tools/call": [create_task()],
            "tasks/get": [completed_state(createdAt="2026-09-01T00:00:59Z", lastUpdatedAt="2026-09-01T00:01:00Z")],
            "tasks/cancel": [{"resultType": "complete"}],
        }
    )
    client = task_client(session)

    with pytest.raises(ValueError, match="changed createdAt"):
        await client._call_tool_with_task_and_poll_async("slow-tool", cancellation_state={})

    assert any(request["method"] == "tasks/cancel" for request in session.requests)


@pytest.mark.asyncio
async def test_external_cancellation_cancels_server_task() -> None:
    """Test cancelling the poll mid-flight sends tasks/cancel for the live task."""
    session = FakeTaskSession(
        {
            "tools/call": [create_task()],
            "tasks/get": [{**TASK_BASE, "resultType": "complete", "status": "working"} for _ in range(50)],
            "tasks/cancel": [{"resultType": "complete"}],
        }
    )
    client = task_client(session)

    poll_task = asyncio.create_task(client._call_tool_with_task_and_poll_async("slow-tool", cancellation_state={}))
    while not any(request["method"] == "tasks/get" for request in session.requests):
        await asyncio.sleep(0.001)
    poll_task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await poll_task
    assert any(request["method"] == "tasks/cancel" for request in session.requests)


@pytest.mark.asyncio
async def test_cancellation_during_create_round_cancels_late_task_handle() -> None:
    """Test a task handle arriving after cancellation is still cancelled."""
    release_create = asyncio.Event()
    session = FakeTaskSession({"tasks/cancel": [{"resultType": "complete"}]})

    async def slow_call_tool(name: str, arguments: Any, timeout: Any, **kwargs: Any) -> Any:
        await release_create.wait()
        return create_task()

    session.call_tool = slow_call_tool  # type: ignore[method-assign]
    client = task_client(session)

    poll_task = asyncio.create_task(client._call_tool_with_task_and_poll_async("slow-tool", cancellation_state={}))
    await asyncio.sleep(0.01)
    poll_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await poll_task

    release_create.set()
    for _ in range(100):
        if any(request["method"] == "tasks/cancel" for request in session.requests):
            break
        await asyncio.sleep(0.01)
    assert any(request["method"] == "tasks/cancel" for request in session.requests)


@pytest.mark.asyncio
async def test_cancellation_grace_period_cancels_task_handle_from_finished_create_round() -> None:
    """Test a create round finishing within the cancellation grace period is cancelled inline."""
    release_create = asyncio.Event()
    create_started = asyncio.Event()
    session = FakeTaskSession({"tasks/cancel": [{"resultType": "complete"}]})

    async def slow_call_tool(name: str, arguments: Any, timeout: Any, **kwargs: Any) -> Any:
        create_started.set()
        await release_create.wait()
        return create_task()

    session.call_tool = slow_call_tool  # type: ignore[method-assign]
    client = task_client(session)
    task_state: dict[str, Any] = {"session": session}

    create_round = asyncio.create_task(client._create_v2_task("slow-tool", None, None, None, task_state))
    await create_started.wait()
    release_create.set()
    create_round.cancel()

    with pytest.raises(asyncio.CancelledError):
        await create_round
    assert task_state["task_id"] == "task-1"
    assert any(request["method"] == "tasks/cancel" for request in session.requests)


@pytest.mark.asyncio
async def test_cancellation_grace_period_skips_cancel_for_direct_tool_result() -> None:
    """Test a create round finishing with a direct result leaves nothing to cancel."""
    release_create = asyncio.Event()
    create_started = asyncio.Event()
    session = FakeTaskSession({})

    async def slow_call_tool(name: str, arguments: Any, timeout: Any, **kwargs: Any) -> Any:
        create_started.set()
        await release_create.wait()
        return CallToolResult(content=[TextContent(type="text", text="direct")], is_error=False)

    session.call_tool = slow_call_tool  # type: ignore[method-assign]
    client = task_client(session)
    task_state: dict[str, Any] = {"session": session}

    create_round = asyncio.create_task(client._create_v2_task("fast-tool", None, None, None, task_state))
    await create_started.wait()
    release_create.set()
    create_round.cancel()

    with pytest.raises(asyncio.CancelledError):
        await create_round
    assert task_state.get("task_id") is None
    assert session.requests == []


@pytest.mark.asyncio
async def test_record_task_handle_ignores_failed_create_round() -> None:
    """Test a create round that errored records no task id to cancel."""

    async def failing_create() -> Any:
        raise RuntimeError("create failed")

    create_round = asyncio.create_task(failing_create())
    with pytest.raises(RuntimeError, match="create failed"):
        await create_round
    task_state: dict[str, Any] = {}

    MCPClient._record_v2_task_handle(create_round, task_state)

    assert task_state == {}


@pytest.mark.asyncio
async def test_session_task_claim_resolver_is_unreachable() -> None:
    """Test the low-level session claim resolver rejects resolution by design."""
    from strands.tools.mcp import _compat

    session_kwargs = _compat.task_session_kwargs(True)
    (claim,) = session_kwargs["result_claims"]["io.modelcontextprotocol/tasks"]

    with pytest.raises(RuntimeError, match="resolved by MCPClient"):
        await claim.resolve(create_task(), None)


@pytest.mark.asyncio
async def test_late_direct_result_after_cancellation_needs_no_cleanup() -> None:
    """Test a direct result arriving after cancellation triggers no tasks/cancel."""
    release_create = asyncio.Event()
    session = FakeTaskSession({})

    async def slow_call_tool(name: str, arguments: Any, timeout: Any, **kwargs: Any) -> Any:
        await release_create.wait()
        return CallToolResult(content=[TextContent(type="text", text="direct")], is_error=False)

    session.call_tool = slow_call_tool  # type: ignore[method-assign]
    client = task_client(session)

    poll_task = asyncio.create_task(client._call_tool_with_task_and_poll_async("fast-tool", cancellation_state={}))
    await asyncio.sleep(0.01)
    poll_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await poll_task

    release_create.set()
    await client._drain_background_cleanup_tasks()
    assert session.requests == []


@pytest.mark.asyncio
async def test_poll_validates_lifecycle_before_sending_the_create_request() -> None:
    """Test a protocol mismatch is rejected before any request reaches the server."""
    session = FakeTaskSession({})
    session.protocol_version = "2025-11-25"
    client = task_client(session)

    with pytest.raises(RuntimeError, match="negotiated MCP protocol"):
        await client._call_tool_with_task_and_poll_async("slow-tool", cancellation_state={})

    assert session.tool_calls == []
    assert session.requests == []


def active_task_client(session: FakeTaskSession, tasks_config: Any = None) -> MCPClient:
    """Create a client that passes the session-active guard without a background thread."""
    client = MCPClient(lambda: None, tasks_config=tasks_config)
    client._background_thread_session = session
    client._background_thread = MagicMock(is_alive=MagicMock(return_value=True))
    return client


class TestPublicTaskMethodGuards:
    """The documented Raises contract of the public task lifecycle methods."""

    def test_methods_require_active_session(self) -> None:
        client = MCPClient(lambda: None, tasks_config={})
        with pytest.raises(MCPClientInitializationError):
            client.submit_tool_sync("tool")
        with pytest.raises(MCPClientInitializationError):
            client.get_task_sync("task-1")
        with pytest.raises(MCPClientInitializationError):
            client.update_task_sync("task-1", {})
        with pytest.raises(MCPClientInitializationError):
            client.cancel_task_sync("task-1")

    @pytest.mark.asyncio
    async def test_async_methods_require_active_session(self) -> None:
        client = MCPClient(lambda: None, tasks_config={})
        with pytest.raises(MCPClientInitializationError):
            await client.submit_tool_async("tool")
        with pytest.raises(MCPClientInitializationError):
            await client.get_task_async("task-1")
        with pytest.raises(MCPClientInitializationError):
            await client.update_task_async("task-1", {})
        with pytest.raises(MCPClientInitializationError):
            await client.cancel_task_async("task-1")

    def test_call_tool_with_task_requires_tasks_config(self) -> None:
        client = active_task_client(FakeTaskSession({}), tasks_config=None)
        with pytest.raises(RuntimeError, match="tasks_config"):
            client.submit_tool_sync("tool")

    def test_call_tool_with_task_requires_advertised_extension(self) -> None:
        client = active_task_client(FakeTaskSession({}), tasks_config={})
        client._server_task_capable = False
        with pytest.raises(RuntimeError, match="did not advertise"):
            client.submit_tool_sync("tool")

    @pytest.mark.asyncio
    async def test_task_id_must_not_be_empty(self) -> None:
        client = active_task_client(FakeTaskSession({}), tasks_config={})
        with pytest.raises(ValueError, match="task_id"):
            client.get_task_sync("")
        with pytest.raises(ValueError, match="task_id"):
            client.update_task_sync("", {})
        with pytest.raises(ValueError, match="task_id"):
            client.cancel_task_sync("")
        with pytest.raises(ValueError, match="task_id"):
            await client.get_task_async("")
        with pytest.raises(ValueError, match="task_id"):
            await client.update_task_async("", {})
        with pytest.raises(ValueError, match="task_id"):
            await client.cancel_task_async("")

    @pytest.mark.asyncio
    async def test_input_responses_must_be_a_dictionary(self) -> None:
        client = active_task_client(FakeTaskSession({}), tasks_config={})
        with pytest.raises(TypeError, match="dictionary"):
            client.update_task_sync("task-1", [("request-1", "yes")])  # type: ignore[arg-type]
        with pytest.raises(TypeError, match="dictionary"):
            await client.update_task_async("task-1", [("request-1", "yes")])  # type: ignore[arg-type]

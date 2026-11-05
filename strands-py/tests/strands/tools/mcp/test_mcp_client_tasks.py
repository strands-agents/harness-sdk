"""Tests for MCP task-augmented execution support in MCPClient."""

import asyncio
from datetime import timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest
from mcp import ListToolsResult
from mcp.types import CallToolResult as MCPCallToolResult
from mcp.types import TextContent as MCPTextContent
from mcp.types import Tool as MCPTool
from mcp.types import ToolExecution

from strands.tools.mcp import MCPClient, TasksConfig
from strands.tools.mcp._compat import MCP_V2
from strands.tools.mcp.mcp_tasks import DEFAULT_TASK_POLL_TIMEOUT, DEFAULT_TASK_TTL

from .conftest import create_server_capabilities

pytestmark = pytest.mark.skipif(MCP_V2, reason="the legacy 2025-11-25 task workflow requires mcp 1.x")


class TestTasksOptIn:
    """Tests for task opt-in behavior via tasks config."""

    @pytest.mark.parametrize(
        "tasks_config,expected_enabled",
        [
            (None, False),
            ({}, True),
        ],
    )
    def test_tasks_enabled_state(self, mock_transport, mock_session, tasks_config, expected_enabled):
        """Test _is_tasks_enabled based on tasks config."""
        with MCPClient(mock_transport["transport_callable"], tasks_config=tasks_config) as client:
            assert client._is_tasks_enabled() is expected_enabled

    def test_should_use_task_requires_opt_in(self, mock_transport, mock_session):
        """Test that _should_use_task returns False without opt-in even with server/tool support."""
        with MCPClient(mock_transport["transport_callable"]) as client:
            client._server_task_capable = True
            assert client._should_use_task("test_tool") is False

        with MCPClient(mock_transport["transport_callable"], tasks_config={}) as client:
            client._server_task_capable = True
            client._tool_task_support_cache["test_tool"] = "required"
            assert client._should_use_task("test_tool") is True


class TestTaskConfiguration:
    """Tests for task-related configuration options."""

    @pytest.mark.parametrize(
        "config,expected_ttl,expected_timeout",
        [
            ({}, DEFAULT_TASK_TTL, DEFAULT_TASK_POLL_TIMEOUT),
            ({"ttl": timedelta(seconds=120)}, timedelta(seconds=120), DEFAULT_TASK_POLL_TIMEOUT),
            ({"poll_timeout": timedelta(seconds=60)}, DEFAULT_TASK_TTL, timedelta(seconds=60)),
            (
                {"ttl": timedelta(seconds=120), "poll_timeout": timedelta(seconds=60)},
                timedelta(seconds=120),
                timedelta(seconds=60),
            ),
        ],
    )
    def test_task_config_values(self, mock_transport, mock_session, config, expected_ttl, expected_timeout):
        """Test task configuration values with various configs."""
        with MCPClient(mock_transport["transport_callable"], tasks_config=config) as client:
            config_actual = client._get_task_config()
            assert config_actual.get("ttl") == expected_ttl
            assert config_actual.get("poll_timeout") == expected_timeout

    def test_stop_resets_task_caches(self, mock_transport, mock_session):
        """Test that stop() resets the task support caches."""
        with MCPClient(mock_transport["transport_callable"], tasks_config={}) as client:
            client._server_task_capable = True
            client._tool_task_support_cache["tool1"] = "required"
        assert client._server_task_capable is None
        assert client._tool_task_support_cache == {}


class TestTaskExecution:
    """Tests for task execution and error handling."""

    def _setup_task_tool(self, mock_session, tool_name: str) -> None:
        """Helper to set up a mock task-enabled tool."""
        mock_session.get_server_capabilities = MagicMock(return_value=create_server_capabilities(True))
        mock_tool = MCPTool(
            name=tool_name,
            description="A test tool",
            inputSchema={"type": "object"},
            execution=ToolExecution(taskSupport="optional"),
        )
        mock_session.list_tools = AsyncMock(return_value=ListToolsResult(tools=[mock_tool], nextCursor=None))
        mock_create_result = MagicMock()
        mock_create_result.task.taskId = "test-task-id"
        mock_session.experimental = MagicMock()
        mock_session.experimental.call_tool_as_task = AsyncMock(return_value=mock_create_result)

    @pytest.mark.parametrize(
        "status,status_message,expected_text",
        [
            ("failed", "Something went wrong", "Something went wrong"),
            ("cancelled", None, "cancelled"),
            ("unknown_status", None, "unexpected task status"),
        ],
    )
    def test_terminal_status_handling(self, mock_transport, mock_session, status, status_message, expected_text):
        """Test handling of terminal task statuses."""
        mock_create_result = MagicMock()
        mock_create_result.task.taskId = f"task-{status}"
        mock_session.experimental.call_tool_as_task = AsyncMock(return_value=mock_create_result)

        async def mock_poll_task(task_id):
            yield MagicMock(status=status, statusMessage=status_message)

        mock_session.experimental.poll_task = mock_poll_task

        with MCPClient(mock_transport["transport_callable"], tasks_config=TasksConfig()) as client:
            client._server_task_capable = True
            client._tool_task_support_cache["test_tool"] = "required"
            result = client.call_tool_sync(tool_use_id="test-id", name="test_tool", arguments={})
            assert result["status"] == "error"
            assert expected_text.lower() in result["content"][0].get("text", "").lower()

    @pytest.mark.asyncio
    async def test_polling_timeout(self, mock_transport, mock_session):
        """Test that task polling times out properly."""
        self._setup_task_tool(mock_session, "slow_tool")

        async def infinite_poll(task_id):
            while True:
                await asyncio.sleep(1)
                yield MagicMock(status="running")

        mock_session.experimental.poll_task = infinite_poll

        with MCPClient(
            mock_transport["transport_callable"], tasks_config=TasksConfig(poll_timeout=timedelta(seconds=0.1))
        ) as client:
            client.list_tools_sync()
            result = await client.call_tool_async(tool_use_id="t", name="slow_tool", arguments={})
            assert result["status"] == "error"
            assert "timed out" in result["content"][0].get("text", "").lower()

    @pytest.mark.asyncio
    async def test_explicit_timeout_overrides_default(self, mock_transport, mock_session):
        """Test that read_timeout_seconds overrides the default poll timeout."""
        self._setup_task_tool(mock_session, "timeout_tool")

        async def infinite_poll(task_id):
            while True:
                await asyncio.sleep(1)
                yield MagicMock(status="running")

        mock_session.experimental.poll_task = infinite_poll

        with MCPClient(
            mock_transport["transport_callable"], tasks_config=TasksConfig(poll_timeout=timedelta(minutes=5))
        ) as client:
            client.list_tools_sync()
            result = await client.call_tool_async(
                tool_use_id="t", name="timeout_tool", arguments={}, read_timeout_seconds=timedelta(seconds=0.1)
            )
            assert result["status"] == "error"
            assert "timed out" in result["content"][0].get("text", "").lower()

    @pytest.mark.asyncio
    async def test_result_retrieval_failure(self, mock_transport, mock_session):
        """Test that get_task_result failures are handled gracefully."""
        self._setup_task_tool(mock_session, "failing_tool")

        async def successful_poll(task_id):
            yield MagicMock(status="completed", statusMessage=None)

        mock_session.experimental.poll_task = successful_poll
        mock_session.experimental.get_task_result = AsyncMock(side_effect=Exception("Network error"))

        with MCPClient(mock_transport["transport_callable"], tasks_config=TasksConfig()) as client:
            client.list_tools_sync()
            result = await client.call_tool_async(tool_use_id="t", name="failing_tool", arguments={})
            assert result["status"] == "error"
            assert "result retrieval failed" in result["content"][0].get("text", "").lower()

    @pytest.mark.asyncio
    async def test_empty_poll_result(self, mock_transport, mock_session):
        """Test handling when poll_task yields nothing."""
        self._setup_task_tool(mock_session, "empty_poll_tool")

        async def empty_poll(task_id):
            return
            yield  # noqa: B901

        mock_session.experimental.poll_task = empty_poll

        with MCPClient(mock_transport["transport_callable"], tasks_config=TasksConfig()) as client:
            client.list_tools_sync()
            result = await client.call_tool_async(tool_use_id="t", name="empty_poll_tool", arguments={})
            assert result["status"] == "error"
            assert "without status" in result["content"][0].get("text", "").lower()

    @pytest.mark.asyncio
    async def test_successful_completion(self, mock_transport, mock_session):
        """Test successful task completion."""
        self._setup_task_tool(mock_session, "success_tool")

        async def poll(task_id):
            yield MagicMock(status="completed", statusMessage=None)

        mock_session.experimental.poll_task = poll
        mock_session.experimental.get_task_result = AsyncMock(
            return_value=MCPCallToolResult(content=[MCPTextContent(type="text", text="Done")], isError=False)
        )

        with MCPClient(mock_transport["transport_callable"], tasks_config=TasksConfig()) as client:
            client.list_tools_sync()
            result = await client.call_tool_async(tool_use_id="t", name="success_tool", arguments={})
            assert result["status"] == "success"
            assert "Done" in result["content"][0].get("text", "")

    @pytest.mark.asyncio
    async def test_cancellation_cancels_remote_task_and_preserves_session(self, mock_transport, mock_session):
        """Test per-call cancellation stops the remote task without closing the session."""
        import threading

        self._setup_task_tool(mock_session, "slow_tool")
        poll_started = asyncio.Event()
        cancel_signal = threading.Event()

        async def infinite_poll(task_id):
            poll_started.set()
            while True:
                await asyncio.sleep(1)
                yield MagicMock(status="running")

        mock_session.experimental.poll_task = infinite_poll
        mock_session.experimental.cancel_task = AsyncMock()

        with MCPClient(mock_transport["transport_callable"], tasks_config=TasksConfig()) as client:
            client.list_tools_sync()
            cancelled_call = asyncio.create_task(
                client.call_tool_async(
                    tool_use_id="cancelled", name="slow_tool", arguments={}, cancel_signal=cancel_signal
                )
            )
            await asyncio.wait_for(poll_started.wait(), timeout=1)
            cancel_signal.set()
            cancelled_result = await asyncio.wait_for(cancelled_call, timeout=1)

            client._tool_task_support_cache["fast_tool"] = None
            mock_session.call_tool.return_value = MCPCallToolResult(
                isError=False, content=[MCPTextContent(type="text", text="done")]
            )
            second_result = await client.call_tool_async(tool_use_id="completed", name="fast_tool", arguments={})

        assert cancelled_result["status"] == "error"
        assert cancelled_result["content"] == [
            {"text": "Tool execution cancelled locally; remote execution may have continued"}
        ]
        assert cancelled_result["cancelled"] is True
        mock_session.experimental.cancel_task.assert_awaited_once_with("test-task-id")
        assert second_result["status"] == "success"

    @pytest.mark.asyncio
    async def test_cancellation_reconciles_delayed_task_creation_response(self, mock_transport, mock_session):
        """Test cancellation discovers and stops a task whose creation response is delayed."""
        import threading

        self._setup_task_tool(mock_session, "slow_tool")
        creation_started = threading.Event()
        release_response = threading.Event()
        cancel_signal = threading.Event()
        create_result = MagicMock()
        create_result.task.taskId = "delayed-task-id"

        async def delayed_creation(**kwargs):
            creation_started.set()
            while not release_response.is_set():
                await asyncio.sleep(0.01)
            return create_result

        mock_session.experimental.call_tool_as_task = delayed_creation
        mock_session.experimental.cancel_task = AsyncMock()

        with MCPClient(mock_transport["transport_callable"], tasks_config=TasksConfig()) as client:
            client.list_tools_sync()
            call = asyncio.create_task(
                client.call_tool_async(
                    tool_use_id="cancelled", name="slow_tool", arguments={}, cancel_signal=cancel_signal
                )
            )
            assert await asyncio.to_thread(creation_started.wait, 1)
            cancel_signal.set()
            await asyncio.sleep(0.1)
            release_response.set()
            result = await asyncio.wait_for(call, timeout=2)

        assert result["status"] == "error"
        mock_session.experimental.cancel_task.assert_awaited_once_with("delayed-task-id")

    @pytest.mark.asyncio
    async def test_cancellation_detaches_resistant_task_creation_and_cancels_late_task(
        self, mock_transport, mock_session
    ):
        """Test a cancellation-resistant creation call cannot block the local result."""
        import threading

        self._setup_task_tool(mock_session, "slow_tool")
        creation_started = threading.Event()
        release_response = threading.Event()
        cancellation_started = threading.Event()
        release_cancellation = threading.Event()
        cancel_signal = threading.Event()
        create_result = MagicMock()
        create_result.task.taskId = "late-task-id"

        async def resistant_creation(**kwargs):
            creation_started.set()
            try:
                while not release_response.is_set():
                    await asyncio.sleep(0.01)
            except asyncio.CancelledError:
                while not release_response.is_set():
                    await asyncio.sleep(0.01)
            return create_result

        async def resistant_cancellation(task_id):
            cancellation_started.set()
            while not release_cancellation.is_set():
                await asyncio.sleep(0.01)

        mock_session.experimental.call_tool_as_task = resistant_creation
        mock_session.experimental.cancel_task = resistant_cancellation

        with MCPClient(mock_transport["transport_callable"], tasks_config=TasksConfig()) as client:
            client.list_tools_sync()
            call = asyncio.create_task(
                client.call_tool_async(
                    tool_use_id="cancelled", name="slow_tool", arguments={}, cancel_signal=cancel_signal
                )
            )
            assert await asyncio.to_thread(creation_started.wait, 1)
            cancel_signal.set()
            result = await asyncio.wait_for(call, timeout=2)
            release_response.set()
            assert await asyncio.to_thread(cancellation_started.wait, 1)
            assert len(client._background_cleanup_tasks) >= 1
            release_cancellation.set()
            await asyncio.sleep(0.1)
            assert not client._background_cleanup_tasks

        assert result["status"] == "error"

    @pytest.mark.asyncio
    async def test_context_exit_drains_delayed_task_cancellation(self, mock_transport, mock_session):
        """Test session shutdown waits for delayed task creation and remote cancellation."""
        import threading

        self._setup_task_tool(mock_session, "slow_tool")
        creation_started = threading.Event()
        release_response = threading.Event()
        cancel_signal = threading.Event()
        create_result = MagicMock()
        create_result.task.taskId = "shutdown-task-id"

        async def resistant_creation(**kwargs):
            creation_started.set()
            try:
                while not release_response.is_set():
                    await asyncio.sleep(0.01)
            except asyncio.CancelledError:
                while not release_response.is_set():
                    await asyncio.sleep(0.01)
            return create_result

        mock_session.experimental.call_tool_as_task = resistant_creation
        mock_session.experimental.cancel_task = AsyncMock()

        with MCPClient(mock_transport["transport_callable"], tasks_config=TasksConfig()) as client:
            client.list_tools_sync()
            call = asyncio.create_task(
                client.call_tool_async(
                    tool_use_id="cancelled", name="slow_tool", arguments={}, cancel_signal=cancel_signal
                )
            )
            assert await asyncio.to_thread(creation_started.wait, 1)
            cancel_signal.set()
            result = await asyncio.wait_for(call, timeout=2)
            release_timer = threading.Timer(0.1, release_response.set)
            release_timer.start()

        release_timer.join(timeout=1)
        assert result["status"] == "error"
        mock_session.experimental.cancel_task.assert_awaited_once_with("shutdown-task-id")
        assert not client._background_cleanup_tasks

    @pytest.mark.asyncio
    async def test_task_creation_cancellation_does_not_guess_shared_request_id(self, mock_transport, mock_session):
        """Test task creation cancellation waits for the task ID instead of guessing a request ID."""
        import threading

        self._setup_task_tool(mock_session, "slow_tool")
        creation_started = threading.Event()
        cancel_signal = threading.Event()

        async def blocked_creation(**kwargs):
            creation_started.set()
            await asyncio.Event().wait()

        mock_session.experimental.call_tool_as_task = blocked_creation
        mock_session.experimental.cancel_task = AsyncMock()
        mock_session._request_id = 42

        with MCPClient(mock_transport["transport_callable"], tasks_config=TasksConfig()) as client:
            client.list_tools_sync()
            call = asyncio.create_task(
                client.call_tool_async(
                    tool_use_id="cancelled", name="slow_tool", arguments={}, cancel_signal=cancel_signal
                )
            )
            assert await asyncio.to_thread(creation_started.wait, 1)
            cancel_signal.set()
            result = await asyncio.wait_for(call, timeout=2)

        assert result["status"] == "error"
        mock_session.send_notification.assert_not_awaited()
        mock_session.experimental.cancel_task.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_remote_task_cancellation_timeout_does_not_block_local_result(self, mock_transport, mock_session):
        """Test an unresponsive tasks/cancel request cannot hang local cancellation."""
        import threading

        self._setup_task_tool(mock_session, "slow_tool")
        poll_started = asyncio.Event()
        cancel_signal = threading.Event()

        async def infinite_poll(task_id):
            poll_started.set()
            while True:
                await asyncio.sleep(1)
                yield MagicMock(status="running")

        async def hanging_cancel(task_id):
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                await asyncio.Event().wait()

        mock_session.experimental.poll_task = infinite_poll
        mock_session.experimental.cancel_task = hanging_cancel

        with MCPClient(mock_transport["transport_callable"], tasks_config=TasksConfig()) as client:
            client.list_tools_sync()
            call = asyncio.create_task(
                client.call_tool_async(
                    tool_use_id="cancelled", name="slow_tool", arguments={}, cancel_signal=cancel_signal
                )
            )
            await asyncio.wait_for(poll_started.wait(), timeout=1)
            cancel_signal.set()
            result = await asyncio.wait_for(call, timeout=2)

        assert result["status"] == "error"
        assert result["content"] == [{"text": "Tool execution cancelled locally; remote execution may have continued"}]
        assert result["cancelled"] is True

    def test_logs_warning_when_task_execution_ignores_progress_callback(self, mock_transport, mock_session, caplog):
        """Test warning is logged when task execution ignores progress callbacks."""
        self._setup_task_tool(mock_session, "task_tool")

        def callback(progress: float, total: float | None, message: str | None) -> None:
            _ = (progress, total, message)

        with MCPClient(mock_transport["transport_callable"], tasks_config=TasksConfig()) as client:
            client.list_tools_sync()
            with caplog.at_level("WARNING", logger="strands.tools.mcp.mcp_client"):
                client.call_tool_sync(
                    tool_use_id="test-id",
                    name="task_tool",
                    arguments={},
                    progress_callback=callback,
                )

        assert "progress callbacks are ignored when task-augmented execution is enabled" in caplog.text


class TestTaskMetaForwarding:
    """Tests for meta parameter forwarding in task-augmented execution."""

    def _setup_task_tool_with_meta(self, mock_session, tool_name: str) -> MagicMock:
        """Helper to set up a mock task-enabled tool and return the experimental mock."""
        mock_session.get_server_capabilities = MagicMock(return_value=create_server_capabilities(True))
        mock_tool = MCPTool(
            name=tool_name,
            description="A test tool",
            inputSchema={"type": "object"},
            execution=ToolExecution(taskSupport="optional"),
        )
        mock_session.list_tools = AsyncMock(return_value=ListToolsResult(tools=[mock_tool], nextCursor=None))
        mock_create_result = MagicMock()
        mock_create_result.task.taskId = "test-task-id"
        mock_session.experimental = MagicMock()
        mock_session.experimental.call_tool_as_task = AsyncMock(return_value=mock_create_result)

        async def successful_poll(task_id):
            yield MagicMock(status="completed", statusMessage=None)

        mock_session.experimental.poll_task = successful_poll
        mock_session.experimental.get_task_result = AsyncMock(
            return_value=MCPCallToolResult(content=[MCPTextContent(type="text", text="Done")], isError=False)
        )

        return mock_session.experimental

    def test_call_tool_sync_forwards_meta_to_task(self, mock_transport, mock_session):
        """Test that call_tool_sync forwards meta to call_tool_as_task."""
        experimental = self._setup_task_tool_with_meta(mock_session, "meta_tool")
        meta = {"com.example/request_id": "abc-123"}

        with MCPClient(mock_transport["transport_callable"], tasks_config=TasksConfig()) as client:
            client.list_tools_sync()
            client.call_tool_sync(tool_use_id="test-id", name="meta_tool", arguments={"param": "value"}, meta=meta)

            experimental.call_tool_as_task.assert_called_once()
            call_kwargs = experimental.call_tool_as_task.call_args
            assert call_kwargs.kwargs.get("meta") == meta

    @pytest.mark.asyncio
    async def test_call_tool_async_forwards_meta_to_task(self, mock_transport, mock_session):
        """Test that call_tool_async forwards meta to call_tool_as_task."""
        experimental = self._setup_task_tool_with_meta(mock_session, "meta_tool")
        meta = {"com.example/trace_id": "xyz-456"}

        with MCPClient(mock_transport["transport_callable"], tasks_config=TasksConfig()) as client:
            client.list_tools_sync()
            await client.call_tool_async(
                tool_use_id="test-id", name="meta_tool", arguments={"param": "value"}, meta=meta
            )

            experimental.call_tool_as_task.assert_called_once()
            call_kwargs = experimental.call_tool_as_task.call_args
            assert call_kwargs.kwargs.get("meta") == meta

    def test_call_tool_sync_forwards_none_meta_to_task(self, mock_transport, mock_session):
        """Test that call_tool_sync forwards None meta to call_tool_as_task when not provided."""
        experimental = self._setup_task_tool_with_meta(mock_session, "no_meta_tool")

        with MCPClient(mock_transport["transport_callable"], tasks_config=TasksConfig()) as client:
            client.list_tools_sync()
            client.call_tool_sync(tool_use_id="test-id", name="no_meta_tool", arguments={"param": "value"})

            experimental.call_tool_as_task.assert_called_once()
            call_kwargs = experimental.call_tool_as_task.call_args
            assert call_kwargs.kwargs.get("meta") is None


@pytest.mark.skipif(MCP_V2, reason="requires mcp 1.x")
class TestFinalizedTaskLifecycleUnavailableOnV1:
    """The finalized SEP-2663 lifecycle refuses to run against the mcp 1.x line."""

    def test_submit_tool_sync_requires_mcp_v2(self, mock_transport, mock_session):
        """Test the public task lifecycle rejects mcp 1.x before sending anything."""
        with MCPClient(mock_transport["transport_callable"], tasks_config={}) as client:
            with pytest.raises(RuntimeError, match="mcp 2.x"):
                client.submit_tool_sync("tool")

    @pytest.mark.asyncio
    async def test_submit_tool_async_requires_mcp_v2(self, mock_transport, mock_session):
        """Test the async task lifecycle rejects mcp 1.x before sending anything."""
        with MCPClient(mock_transport["transport_callable"], tasks_config={}) as client:
            with pytest.raises(RuntimeError, match="mcp 2.x"):
                await client.submit_tool_async("tool")

    @pytest.mark.asyncio
    async def test_task_aware_call_requires_mcp_v2(self, mock_transport, mock_session):
        """Test the task-aware tools/call round rejects mcp 1.x."""
        with MCPClient(mock_transport["transport_callable"], tasks_config={}) as client:
            with pytest.raises(RuntimeError, match="mcp 2.x"):
                await client._call_tool_with_task_once_async("tool", None, timedelta(seconds=1), None, None)

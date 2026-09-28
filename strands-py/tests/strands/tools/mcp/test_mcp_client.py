import asyncio
import base64
import threading
import time
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from mcp import ListToolsResult
from mcp.types import CallToolResult as MCPCallToolResult
from mcp.types import (
    GetPromptResult,
    ListPromptsResult,
    ListResourcesResult,
    ListResourceTemplatesResult,
    PaginatedRequestParams,
    Prompt,
    PromptMessage,
    ReadResourceResult,
    Resource,
    ResourceTemplate,
    TextResourceContents,
    ToolListChangedNotification,
)
from mcp.types import ImageContent as MCPImageContent
from mcp.types import TextContent as MCPTextContent
from mcp.types import Tool as MCPTool
from pydantic import AnyUrl

import strands.tools.mcp.mcp_client as mcp_client_module
from strands.tools.mcp import MCPClient
from strands.tools.mcp._compat import MCP_V2, next_cursor, resource_templates
from strands.tools.mcp.mcp_types import MCPToolResult
from strands.types.exceptions import MCPClientInitializationError

from .conftest import assert_session_call_tool_once_with, make_mcp_error

# Fixtures mock_transport and mock_session are imported from conftest.py


@pytest.fixture
def mcp_client(mock_transport, mock_session):
    with MCPClient(mock_transport["transport_callable"]) as client:
        yield client


def test_mcp_client_context_manager(mock_transport, mock_session):
    """Test that the MCPClient context manager properly initializes and cleans up."""
    with MCPClient(mock_transport["transport_callable"]) as client:
        assert client._background_thread is not None
        assert client._background_thread.is_alive()
        assert client._init_future.done()

        mock_transport["transport_cm"].__aenter__.assert_called_once()
        mock_session.initialize.assert_called_once()

    # After exiting the context manager, verify that the thread was cleaned up
    # Give a small delay for the thread to fully terminate
    time.sleep(0.1)
    assert client._background_thread is None


def test_server_instructions_default(mock_transport, mock_session):
    """Test that server_instructions defaults to None when server returns None."""
    mock_session.initialize.return_value.instructions = None
    mock_session.instructions = None
    with MCPClient(mock_transport["transport_callable"]) as client:
        assert client.server_instructions is None


def test_server_instructions_from_server(mock_transport, mock_session):
    """Test that server_instructions is populated from the negotiated session."""
    mock_session.initialize.return_value.instructions = "Use tool A before tool B."
    mock_session.instructions = "Use tool A before tool B."
    with MCPClient(mock_transport["transport_callable"]) as client:
        assert client.server_instructions == "Use tool A before tool B."


def test_list_tools_sync(mock_transport, mock_session):
    """Test that list_tools_sync correctly retrieves and adapts tools."""
    mock_tool = MCPTool(name="test_tool", description="A test tool", inputSchema={"type": "object", "properties": {}})
    mock_session.list_tools.return_value = ListToolsResult(tools=[mock_tool])

    with MCPClient(mock_transport["transport_callable"]) as client:
        tools = client.list_tools_sync()

        mock_session.list_tools.assert_called_once_with(params=None)

        assert len(tools) == 1
        assert tools[0].tool_name == "test_tool"
        assert tools.pagination_token is None


def test_list_tools_sync_session_not_active():
    """Test that list_tools_sync raises an error when session is not active."""
    client = MCPClient(MagicMock())

    with pytest.raises(MCPClientInitializationError, match="client.session is not running"):
        client.list_tools_sync()


def test_list_tools_sync_with_pagination_token(mock_transport, mock_session):
    """Test that list_tools_sync correctly passes pagination token and returns next cursor."""
    mock_tool = MCPTool(name="test_tool", description="A test tool", inputSchema={"type": "object", "properties": {}})
    mock_session.list_tools.return_value = ListToolsResult(tools=[mock_tool], nextCursor="next_page_token")

    with MCPClient(mock_transport["transport_callable"]) as client:
        tools = client.list_tools_sync(pagination_token="current_page_token")

        mock_session.list_tools.assert_called_once_with(params=PaginatedRequestParams(cursor="current_page_token"))
        assert len(tools) == 1
        assert tools[0].tool_name == "test_tool"
        assert tools.pagination_token == "next_page_token"


def test_list_tools_sync_without_pagination_token(mock_transport, mock_session):
    """Test that list_tools_sync works without pagination token and handles missing next cursor."""
    mock_tool = MCPTool(name="test_tool", description="A test tool", inputSchema={"type": "object", "properties": {}})
    mock_session.list_tools.return_value = ListToolsResult(tools=[mock_tool])  # No nextCursor

    with MCPClient(mock_transport["transport_callable"]) as client:
        tools = client.list_tools_sync()

        mock_session.list_tools.assert_called_once_with(params=None)
        assert len(tools) == 1
        assert tools[0].tool_name == "test_tool"
        assert tools.pagination_token is None


@pytest.mark.parametrize("is_error,expected_status", [(False, "success"), (True, "error")])
def test_call_tool_sync_status(mock_transport, mock_session, is_error, expected_status):
    """Test that call_tool_sync correctly handles success and error results."""
    mock_content = MCPTextContent(type="text", text="Test message")
    mock_session.call_tool.return_value = MCPCallToolResult(isError=is_error, content=[mock_content])

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.call_tool_sync(tool_use_id="test-123", name="test_tool", arguments={"param": "value"})

        assert_session_call_tool_once_with(mock_session, "test_tool", {"param": "value"})

        assert result["status"] == expected_status
        assert result["toolUseId"] == "test-123"
        assert len(result["content"]) == 1
        assert result["content"][0]["text"] == "Test message"
        # No structured content should be present when not provided by MCP
        assert result.get("structuredContent") is None
        # isError mirrors the MCP server's explicit value; absent only for protocol/client exceptions
        assert result.get("isError") is is_error


def test_call_tool_sync_without_error_flag(mock_transport, mock_session):
    """A result whose error flag is unset maps to success without an isError key.

    mcp 2.x models the flag as `bool | None` defaulting to None; the 1.x model
    validates it to a bool, so the unset shape is built with `model_construct`.
    """
    mock_content = MCPTextContent(type="text", text="Test message")
    mock_session.call_tool.return_value = MCPCallToolResult.model_construct(isError=None, content=[mock_content])

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.call_tool_sync(tool_use_id="test-123", name="test_tool", arguments={"param": "value"})

        assert result == {
            "status": "success",
            "toolUseId": "test-123",
            "content": [{"text": "Test message"}],
        }


def test_call_tool_sync_with_falsy_structured_content(mock_transport, mock_session):
    """Test that an empty structured payload is forwarded, not dropped as falsy.

    The 2026-07-28 spec allows any JSON value in `structuredContent`, so `0`,
    `False`, `""`, `[]`, and `{}` are all valid payloads.
    """
    mock_content = MCPTextContent(type="text", text="Test message")
    mock_session.call_tool.return_value = MCPCallToolResult(isError=False, content=[mock_content], structuredContent={})

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.call_tool_sync(tool_use_id="test-123", name="test_tool", arguments={"param": "value"})

        assert result == {
            "status": "success",
            "toolUseId": "test-123",
            "content": [{"text": "Test message"}],
            "structuredContent": {},
            "isError": False,
        }


def test_call_tool_sync_calls_the_tool_through_the_compat_shim(mock_transport, mock_session):
    """Test that the direct tool-call path calls the tool through the version shim."""
    mock_content = MCPTextContent(type="text", text="Test message")
    shim = AsyncMock(return_value=MCPCallToolResult(isError=False, content=[mock_content]))

    with patch("strands.tools.mcp.mcp_client.compat_call_tool", shim):
        with MCPClient(mock_transport["transport_callable"]) as client:
            client.call_tool_sync(tool_use_id="test-123", name="test_tool", arguments={"param": "value"})

    shim.assert_awaited_once_with(mock_session, "test_tool", {"param": "value"}, None, None, None)


def test_call_tool_sync_session_not_active():
    """Test that call_tool_sync raises an error when session is not active."""
    client = MCPClient(MagicMock())

    with pytest.raises(MCPClientInitializationError, match="client.session is not running"):
        client.call_tool_sync(tool_use_id="test-123", name="test_tool", arguments={"param": "value"})


def test_call_tool_sync_with_structured_content(mock_transport, mock_session):
    """Test that call_tool_sync correctly handles structured content."""
    mock_content = MCPTextContent(type="text", text="Test message")
    structured_content = {"result": 42, "status": "completed"}
    mock_session.call_tool.return_value = MCPCallToolResult(
        isError=False, content=[mock_content], structuredContent=structured_content
    )

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.call_tool_sync(tool_use_id="test-123", name="test_tool", arguments={"param": "value"})

        assert_session_call_tool_once_with(mock_session, "test_tool", {"param": "value"})

        assert result["status"] == "success"
        assert result["toolUseId"] == "test-123"
        # Content should only contain the text content, not the structured content
        assert len(result["content"]) == 1
        assert result["content"][0]["text"] == "Test message"
        # Structured content should be in its own field
        assert "structuredContent" in result
        assert result["structuredContent"] == structured_content
        assert result["structuredContent"]["result"] == 42
        assert result["structuredContent"]["status"] == "completed"


def test_call_tool_sync_exception(mock_transport, mock_session):
    """Test that call_tool_sync correctly handles exceptions."""
    mock_session.call_tool.side_effect = Exception("Test exception")

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.call_tool_sync(tool_use_id="test-123", name="test_tool", arguments={"param": "value"})

        assert result["status"] == "error"
        assert result["toolUseId"] == "test-123"
        assert len(result["content"]) == 1
        assert "Test exception" in result["content"][0]["text"]


def test_call_tool_sync_forwards_meta(mock_transport, mock_session):
    """Test that call_tool_sync forwards meta to ClientSession.call_tool."""
    mock_content = MCPTextContent(type="text", text="Test message")
    mock_session.call_tool.return_value = MCPCallToolResult(isError=False, content=[mock_content])
    meta = {"com.example/request_id": "abc-123"}

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.call_tool_sync(
            tool_use_id="test-123", name="test_tool", arguments={"param": "value"}, meta=meta
        )

        assert_session_call_tool_once_with(mock_session, "test_tool", {"param": "value"}, meta=meta)
        assert result["status"] == "success"


def test_call_tool_sync_forwards_instance_progress_callback(mock_transport, mock_session):
    """Test that call_tool_sync uses the instance-level progress callback when no per-call callback is given."""
    mock_content = MCPTextContent(type="text", text="done")
    mock_session.call_tool.return_value = MCPCallToolResult(isError=False, content=[mock_content])
    cb = AsyncMock()

    with MCPClient(mock_transport["transport_callable"], progress_callback=cb) as client:
        result = client.call_tool_sync(tool_use_id="test-123", name="test_tool", arguments={})

        assert_session_call_tool_once_with(mock_session, "test_tool", {}, progress_callback=cb)
        assert result["status"] == "success"


def test_call_tool_sync_per_call_progress_callback_overrides_instance(mock_transport, mock_session):
    """Test that a per-call progress callback overrides the instance-level one."""
    mock_content = MCPTextContent(type="text", text="done")
    mock_session.call_tool.return_value = MCPCallToolResult(isError=False, content=[mock_content])
    instance_cb = AsyncMock()
    per_call_cb = AsyncMock()

    with MCPClient(mock_transport["transport_callable"], progress_callback=instance_cb) as client:
        result = client.call_tool_sync(
            tool_use_id="test-123", name="test_tool", arguments={}, progress_callback=per_call_cb
        )

        assert_session_call_tool_once_with(mock_session, "test_tool", {}, progress_callback=per_call_cb)
        assert result["status"] == "success"


def test_call_tool_sync_no_progress_callback_by_default(mock_transport, mock_session):
    """Test that progress_callback defaults to None when not set on instance or per-call."""
    mock_content = MCPTextContent(type="text", text="done")
    mock_session.call_tool.return_value = MCPCallToolResult(isError=False, content=[mock_content])

    with MCPClient(mock_transport["transport_callable"]) as client:
        client.call_tool_sync(tool_use_id="test-123", name="test_tool", arguments={})

        assert_session_call_tool_once_with(mock_session, "test_tool", {})


def test_call_tool_sync_pre_set_cancel_signal_skips_request(mock_transport, mock_session):
    """Test a pre-set cancellation signal short-circuits before sending a request."""
    cancel_signal = threading.Event()
    cancel_signal.set()

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.call_tool_sync(
            tool_use_id="cancelled", name="slow_tool", arguments={}, cancel_signal=cancel_signal
        )

    assert result == {
        "status": "error",
        "toolUseId": "cancelled",
        "content": [{"text": "Tool execution cancelled locally; remote execution may have continued"}],
        "cancelled": True,
    }
    mock_session.call_tool.assert_not_awaited()
    mock_session.send_notification.assert_not_awaited()


def test_call_tool_sync_cancel_signal_cancels_only_in_flight_call(mock_transport, mock_session):
    """Test cancellation stops one call without closing the MCP session."""
    first_call_started = threading.Event()
    first_call_cancelled = threading.Event()
    cancel_signal = threading.Event()
    mock_content = MCPTextContent(type="text", text="done")

    async def call_tool(name, arguments, read_timeout_seconds, progress_callback=None, meta=None, **kwargs):
        if name == "slow_tool":
            first_call_started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                first_call_cancelled.set()
                raise
        return MCPCallToolResult(isError=False, content=[mock_content])

    mock_session.call_tool.side_effect = call_tool
    mock_session._request_id = 0

    with MCPClient(mock_transport["transport_callable"]) as client:
        cancellation_thread = threading.Thread(target=lambda: (first_call_started.wait(timeout=1), cancel_signal.set()))
        cancellation_thread.start()
        cancelled_result = client.call_tool_sync(
            tool_use_id="cancelled", name="slow_tool", arguments={}, cancel_signal=cancel_signal
        )
        cancellation_thread.join(timeout=1)

        second_result = client.call_tool_sync(tool_use_id="completed", name="fast_tool", arguments={})

    assert cancelled_result == {
        "status": "error",
        "toolUseId": "cancelled",
        "content": [{"text": "Tool execution cancelled locally; remote execution may have continued"}],
        "cancelled": True,
    }
    assert first_call_cancelled.wait(timeout=1)
    if MCP_V2:
        # The 2.x dispatcher sends the cancel itself when the awaiting task is
        # cancelled; the client hand-sends nothing.
        mock_session.send_notification.assert_not_awaited()
    else:
        mock_session.send_notification.assert_awaited_once()
        notification = mock_session.send_notification.await_args.args[0].root
        assert notification.method == "notifications/cancelled"
        assert notification.params.requestId == 0
    assert second_result["status"] == "success"
    assert mock_session.call_tool.call_count == 2


def test_call_tool_sync_cancel_on_v2_sends_no_hand_built_notification(mock_transport, mock_session):
    """Test that cancelling on the 2.x path hand-sends nothing: cancelling the awaiting task is the mechanism."""
    call_started = threading.Event()
    call_cancelled = threading.Event()
    cancel_signal = threading.Event()

    async def call_tool(name, arguments, read_timeout_seconds, progress_callback=None, meta=None, **kwargs):
        call_started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            call_cancelled.set()
            raise

    mock_session.call_tool.side_effect = call_tool
    mock_session._request_id = 0

    with (
        patch("strands.tools.mcp.mcp_client.MCP_V2", True),
        MCPClient(mock_transport["transport_callable"]) as client,
    ):
        cancellation_thread = threading.Thread(target=lambda: (call_started.wait(timeout=1), cancel_signal.set()))
        cancellation_thread.start()
        cancelled_result = client.call_tool_sync(
            tool_use_id="cancelled", name="slow_tool", arguments={}, cancel_signal=cancel_signal
        )
        cancellation_thread.join(timeout=1)

    assert cancelled_result["cancelled"] is True
    assert call_cancelled.wait(timeout=1)
    mock_session.send_notification.assert_not_awaited()


@pytest.mark.asyncio
async def test_call_tool_async_cancel_signal_cancels_only_matching_call(mock_transport, mock_session):
    """Test each concurrent call observes only its own cancellation signal."""
    first_call_started = asyncio.Event()
    slow_call_started = asyncio.Event()
    slow_call_cancelled = asyncio.Event()
    cancel_signal = threading.Event()
    other_signal = threading.Event()
    mock_content = MCPTextContent(type="text", text="done")

    assigned_request_ids = {}

    async def call_tool(name, arguments, read_timeout_seconds, progress_callback=None, meta=None, **kwargs):
        request_id = mock_session._request_id
        mock_session._request_id += 1
        assigned_request_ids[name] = request_id
        if name == "first_tool":
            first_call_started.set()
            await asyncio.Event().wait()
        if name == "slow_tool":
            slow_call_started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                slow_call_cancelled.set()
                raise
        return MCPCallToolResult(isError=False, content=[mock_content])

    mock_session.call_tool.side_effect = call_tool
    mock_session._request_id = 41

    with MCPClient(mock_transport["transport_callable"]) as client:
        first_call = asyncio.create_task(
            client.call_tool_async(tool_use_id="first", name="first_tool", arguments={}, cancel_signal=other_signal)
        )
        await asyncio.wait_for(first_call_started.wait(), timeout=1)
        cancelled_call = asyncio.create_task(
            client.call_tool_async(tool_use_id="cancelled", name="slow_tool", arguments={}, cancel_signal=cancel_signal)
        )
        completed_call = asyncio.create_task(
            client.call_tool_async(tool_use_id="completed", name="fast_tool", arguments={}, cancel_signal=other_signal)
        )

        await asyncio.wait_for(slow_call_started.wait(), timeout=1)
        cancel_signal.set()
        cancelled_result, completed_result = await asyncio.wait_for(
            asyncio.gather(cancelled_call, completed_call), timeout=1
        )
        first_call.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first_call

    assert cancelled_result["status"] == "error"
    assert cancelled_result["content"] == [
        {"text": "Tool execution cancelled locally; remote execution may have continued"}
    ]
    assert cancelled_result["cancelled"] is True
    assert slow_call_cancelled.is_set()
    if MCP_V2:
        # The 2.x dispatcher sends the cancel itself when the awaiting task is
        # cancelled; the client hand-sends nothing.
        mock_session.send_notification.assert_not_awaited()
    else:
        notifications = [call.args[0].root for call in mock_session.send_notification.await_args_list]
        assert all(notification.method == "notifications/cancelled" for notification in notifications)
        cancelled_request_ids = {notification.params.requestId for notification in notifications}
        assert assigned_request_ids["slow_tool"] in cancelled_request_ids
    assert assigned_request_ids["slow_tool"] > assigned_request_ids["first_tool"]
    assert assigned_request_ids["slow_tool"] != assigned_request_ids["fast_tool"]
    assert completed_result["status"] == "success"
    assert not other_signal.is_set()


@pytest.mark.asyncio
async def test_call_tool_async_cancel_without_sdk_request_id_still_cancels_locally(mock_transport, mock_session):
    """Test an MCP SDK private-field change degrades to local-only cancellation."""
    call_started = asyncio.Event()
    cancel_signal = threading.Event()
    del mock_session._request_id

    async def call_tool(name, arguments, read_timeout_seconds, progress_callback=None, meta=None, **kwargs):
        call_started.set()
        await asyncio.Event().wait()

    mock_session.call_tool.side_effect = call_tool

    with MCPClient(mock_transport["transport_callable"]) as client:
        call = asyncio.create_task(
            client.call_tool_async(tool_use_id="cancelled", name="slow_tool", arguments={}, cancel_signal=cancel_signal)
        )
        await asyncio.wait_for(call_started.wait(), timeout=1)
        cancel_signal.set()
        result = await asyncio.wait_for(call, timeout=1)

    assert result["cancelled"] is True
    mock_session.send_notification.assert_not_awaited()


@pytest.mark.skipif(MCP_V2, reason="hand-sent cancellation is 1.x-only; the 2.x dispatcher sends the cancel itself")
@pytest.mark.asyncio
async def test_call_tool_async_logs_remote_cancellation_failure(mock_transport, mock_session, caplog):
    """Test an immediate remote notification failure is observed and logged."""
    call_started = asyncio.Event()
    cancel_signal = threading.Event()
    mock_session._request_id = 7
    mock_session.send_notification.side_effect = RuntimeError("notification failed")

    async def call_tool(name, arguments, read_timeout_seconds, progress_callback=None, meta=None, **kwargs):
        call_started.set()
        await asyncio.Event().wait()

    mock_session.call_tool.side_effect = call_tool

    with MCPClient(mock_transport["transport_callable"]) as client:
        call = asyncio.create_task(
            client.call_tool_async(tool_use_id="cancelled", name="slow_tool", arguments={}, cancel_signal=cancel_signal)
        )
        await asyncio.wait_for(call_started.wait(), timeout=1)
        cancel_signal.set()
        with caplog.at_level("DEBUG", logger="strands.tools.mcp.mcp_client"):
            result = await asyncio.wait_for(call, timeout=1)

    assert result["cancelled"] is True
    assert "failed to notify MCP server of cancellation" in caplog.text


@pytest.mark.asyncio
async def test_call_tool_async_cancel_wins_when_result_and_signal_are_ready(mock_transport, mock_session):
    """Test a set cancellation signal takes precedence over a concurrently ready result."""
    cancel_signal = threading.Event()
    mock_content = MCPTextContent(type="text", text="late result")

    async def call_tool(name, arguments, read_timeout_seconds, progress_callback=None, meta=None, **kwargs):
        cancel_signal.set()
        return MCPCallToolResult(isError=False, content=[mock_content])

    mock_session.call_tool.side_effect = call_tool

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = await client.call_tool_async(
            tool_use_id="cancelled", name="racing_tool", arguments={}, cancel_signal=cancel_signal
        )

    assert result["status"] == "error"
    assert result["content"] == [{"text": "Tool execution cancelled locally; remote execution may have continued"}]
    assert result["cancelled"] is True


@pytest.mark.asyncio
async def test_call_tool_async_tracks_cancellation_resistant_invocation(mock_transport, mock_session):
    """Test a resistant invocation remains owned until bounded session shutdown."""
    call_started = asyncio.Event()
    release_call = threading.Event()
    cancel_signal = threading.Event()
    mock_session._request_id = 0

    async def call_tool(name, arguments, read_timeout_seconds, progress_callback=None, meta=None, **kwargs):
        call_started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            while not release_call.is_set():
                await asyncio.sleep(0.01)
        return MCPCallToolResult(isError=False, content=[MCPTextContent(type="text", text="late")])

    mock_session.call_tool.side_effect = call_tool

    with MCPClient(mock_transport["transport_callable"]) as client:
        call = asyncio.create_task(
            client.call_tool_async(tool_use_id="cancelled", name="slow_tool", arguments={}, cancel_signal=cancel_signal)
        )
        await asyncio.wait_for(call_started.wait(), timeout=1)
        cancel_signal.set()
        result = await asyncio.wait_for(call, timeout=2)
        assert client._background_cleanup_tasks
        release_timer = threading.Timer(0.1, release_call.set)
        release_timer.start()

    release_timer.join(timeout=1)
    assert result["cancelled"] is True
    assert not client._background_cleanup_tasks


@pytest.mark.asyncio
async def test_call_tool_async_caller_cancellation_cleans_up_background_call(mock_transport, mock_session):
    """Test cancelling the caller also cancels the background invocation."""
    call_started = asyncio.Event()
    call_cancelled = asyncio.Event()
    mock_session._request_id = 0

    async def call_tool(name, arguments, read_timeout_seconds, progress_callback=None, meta=None, **kwargs):
        call_started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            call_cancelled.set()
            raise

    mock_session.call_tool.side_effect = call_tool

    with MCPClient(mock_transport["transport_callable"]) as client:
        caller = asyncio.create_task(client.call_tool_async(tool_use_id="cancelled", name="slow_tool", arguments={}))
        await asyncio.wait_for(call_started.wait(), timeout=1)
        caller.cancel()
        with pytest.raises(asyncio.CancelledError):
            await caller

        mock_session.call_tool.side_effect = None
        mock_session.call_tool.return_value = MCPCallToolResult(
            isError=False, content=[MCPTextContent(type="text", text="done")]
        )
        second_result = await client.call_tool_async(tool_use_id="completed", name="fast_tool", arguments={})

    assert call_cancelled.is_set()
    if MCP_V2:
        # The 2.x dispatcher sends the cancel itself when the awaiting task is
        # cancelled; the client hand-sends nothing.
        mock_session.send_notification.assert_not_awaited()
    else:
        mock_session.send_notification.assert_awaited_once()
    assert second_result["status"] == "success"


@pytest.mark.asyncio
async def test_call_tool_async_caller_cancellation_timeout_preserves_cancelled_error(
    mock_transport, mock_session, caplog
):
    """Test bounded cleanup retains resistant work without replacing caller cancellation."""
    call_started = threading.Event()
    call_cancelled = threading.Event()
    release_call = threading.Event()
    mock_session._request_id = 0

    async def resistant_call(name, arguments, read_timeout_seconds, progress_callback=None, meta=None, **kwargs):
        call_started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            call_cancelled.set()
            while not release_call.is_set():
                await asyncio.sleep(0.01)
        return MCPCallToolResult(isError=False, content=[MCPTextContent(type="text", text="late")])

    mock_session.call_tool.side_effect = resistant_call

    try:
        with MCPClient(mock_transport["transport_callable"]) as client:
            caller = asyncio.create_task(
                client.call_tool_async(tool_use_id="cancelled", name="slow_tool", arguments={})
            )
            assert await asyncio.to_thread(call_started.wait, 1)
            caller.cancel()
            with caplog.at_level("DEBUG", logger="strands.tools.mcp.mcp_client"):
                with pytest.raises(asyncio.CancelledError):
                    await caller
                assert await asyncio.to_thread(call_cancelled.wait, 1)
                # The client logs the expired window, then sends the cancellation notification, and
                # only then retains the unfinished invocation. Waiting on the log alone would
                # observe the client mid-sequence, so wait for the retained task itself. The
                # client runs on its own thread, so nothing else orders these two observations.
                for _ in range(150):
                    if client._background_cleanup_tasks:
                        break
                    await asyncio.sleep(0.01)

            assert "did not finish within bounded cancellation cleanup" in caplog.text
            assert client._background_cleanup_tasks
            release_call.set()
            for _ in range(100):
                if not client._background_cleanup_tasks:
                    break
                await asyncio.sleep(0.01)
            assert not client._background_cleanup_tasks
    finally:
        release_call.set()


@pytest.mark.asyncio
async def test_call_tool_async_forwards_meta(mock_transport, mock_session):
    """Test that call_tool_async forwards meta to ClientSession.call_tool."""
    mock_content = MCPTextContent(type="text", text="Test message")
    mock_result = MCPCallToolResult(isError=False, content=[mock_content])
    mock_session.call_tool.return_value = mock_result
    meta = {"com.example/request_id": "abc-123"}

    with MCPClient(mock_transport["transport_callable"]) as client:
        with (
            patch("asyncio.run_coroutine_threadsafe") as mock_run_coroutine_threadsafe,
            patch("asyncio.wrap_future") as mock_wrap_future,
        ):
            mock_future = MagicMock()
            mock_run_coroutine_threadsafe.return_value = mock_future

            async def mock_awaitable():
                return mock_result

            mock_wrap_future.return_value = mock_awaitable()

            result = await client.call_tool_async(
                tool_use_id="test-123", name="test_tool", arguments={"param": "value"}, meta=meta
            )

            mock_run_coroutine_threadsafe.assert_called_once()

        assert result["status"] == "success"


@pytest.mark.asyncio
@pytest.mark.parametrize("is_error,expected_status", [(False, "success"), (True, "error")])
async def test_call_tool_async_status(mock_transport, mock_session, is_error, expected_status):
    """Test that call_tool_async correctly handles success and error results."""
    mock_content = MCPTextContent(type="text", text="Test message")
    mock_result = MCPCallToolResult(isError=is_error, content=[mock_content])
    mock_session.call_tool.return_value = mock_result

    with MCPClient(mock_transport["transport_callable"]) as client:
        # Mock asyncio.run_coroutine_threadsafe and asyncio.wrap_future
        with (
            patch("asyncio.run_coroutine_threadsafe") as mock_run_coroutine_threadsafe,
            patch("asyncio.wrap_future") as mock_wrap_future,
        ):
            # Create a mock future that returns the mock result
            mock_future = MagicMock()
            mock_run_coroutine_threadsafe.return_value = mock_future

            # Create an async mock that resolves to the mock result
            async def mock_awaitable():
                return mock_result

            mock_wrap_future.return_value = mock_awaitable()

            result = await client.call_tool_async(
                tool_use_id="test-123", name="test_tool", arguments={"param": "value"}
            )

            # Verify the asyncio functions were called correctly
            mock_run_coroutine_threadsafe.assert_called_once()
            mock_wrap_future.assert_called_once_with(mock_future)

        assert result["status"] == expected_status
        assert result["toolUseId"] == "test-123"
        assert len(result["content"]) == 1
        assert result["content"][0]["text"] == "Test message"
        # isError mirrors the MCP server's explicit value; absent only for protocol/client exceptions
        assert result.get("isError") is is_error


@pytest.mark.asyncio
async def test_call_tool_async_session_not_active():
    """Test that call_tool_async raises an error when session is not active."""
    client = MCPClient(MagicMock())

    with pytest.raises(MCPClientInitializationError, match="client.session is not running"):
        await client.call_tool_async(tool_use_id="test-123", name="test_tool", arguments={"param": "value"})


@pytest.mark.asyncio
async def test_call_tool_async_exception(mock_transport, mock_session):
    """Test that call_tool_async correctly handles exceptions."""
    with MCPClient(mock_transport["transport_callable"]) as client:
        # Mock asyncio.run_coroutine_threadsafe to raise an exception
        with patch("asyncio.run_coroutine_threadsafe") as mock_run_coroutine_threadsafe:
            mock_run_coroutine_threadsafe.side_effect = Exception("Test exception")

            result = await client.call_tool_async(
                tool_use_id="test-123", name="test_tool", arguments={"param": "value"}
            )

        assert result["status"] == "error"
        assert result["toolUseId"] == "test-123"
        assert len(result["content"]) == 1
        assert "Test exception" in result["content"][0]["text"]


@pytest.mark.asyncio
async def test_call_tool_async_with_timeout(mock_transport, mock_session):
    """Test that call_tool_async correctly passes timeout parameter."""
    from datetime import timedelta

    mock_content = MCPTextContent(type="text", text="Test message")
    mock_result = MCPCallToolResult(isError=False, content=[mock_content])
    mock_session.call_tool.return_value = mock_result

    with MCPClient(mock_transport["transport_callable"]) as client:
        timeout = timedelta(seconds=30)

        with (
            patch("asyncio.run_coroutine_threadsafe") as mock_run_coroutine_threadsafe,
            patch("asyncio.wrap_future") as mock_wrap_future,
        ):
            mock_future = MagicMock()
            mock_run_coroutine_threadsafe.return_value = mock_future

            # Create an async mock that resolves to the mock result
            async def mock_awaitable():
                return mock_result

            mock_wrap_future.return_value = mock_awaitable()

            result = await client.call_tool_async(
                tool_use_id="test-123", name="test_tool", arguments={"param": "value"}, read_timeout_seconds=timeout
            )

            # Verify the timeout was passed to the session call_tool method
            # We need to check that the coroutine passed to run_coroutine_threadsafe
            # would call session.call_tool with the timeout
            mock_run_coroutine_threadsafe.assert_called_once()
            mock_wrap_future.assert_called_once_with(mock_future)

        assert result["status"] == "success"
        assert result["toolUseId"] == "test-123"


@pytest.mark.asyncio
async def test_call_tool_async_initialization_not_complete():
    """Test that call_tool_async returns error result when background thread is not initialized."""
    client = MCPClient(MagicMock())

    # Manually set the client state to simulate a partially initialized state
    client._background_thread = MagicMock()
    client._background_thread.is_alive.return_value = True
    client._background_thread_session = None  # Not initialized

    result = await client.call_tool_async(tool_use_id="test-123", name="test_tool", arguments={"param": "value"})

    assert result["status"] == "error"
    assert result["toolUseId"] == "test-123"
    assert len(result["content"]) == 1
    assert "client session was not initialized" in result["content"][0]["text"]


@pytest.mark.asyncio
async def test_call_tool_async_wrap_future_exception(mock_transport, mock_session):
    """Test that call_tool_async correctly handles exceptions from wrap_future."""
    with MCPClient(mock_transport["transport_callable"]) as client:
        with (
            patch("asyncio.run_coroutine_threadsafe") as mock_run_coroutine_threadsafe,
            patch("asyncio.wrap_future") as mock_wrap_future,
        ):
            mock_future = MagicMock()
            mock_run_coroutine_threadsafe.return_value = mock_future

            # Create an async mock that raises an exception
            async def mock_awaitable():
                raise Exception("Wrap future exception")

            mock_wrap_future.return_value = mock_awaitable()

            result = await client.call_tool_async(
                tool_use_id="test-123", name="test_tool", arguments={"param": "value"}
            )

        assert result["status"] == "error"
        assert result["toolUseId"] == "test-123"
        assert len(result["content"]) == 1
        assert "Wrap future exception" in result["content"][0]["text"]


def test_enter_with_initialization_exception(mock_transport):
    """Test that __enter__ handles exceptions during initialization properly."""
    # Make the transport callable throw an exception
    mock_transport["transport_cm"].__aenter__.side_effect = Exception("Transport initialization failed")

    client = MCPClient(mock_transport["transport_callable"])

    with patch.object(client, "stop") as mock_stop:
        with pytest.raises(
            MCPClientInitializationError,
            match="the client initialization failed: Transport initialization failed",
        ):
            client.start()

        # Verify stop() was called for cleanup
        mock_stop.assert_called_once_with(None, None, None)


def test_mcp_tool_result_type():
    """Test that MCPToolResult extends ToolResult correctly."""
    # Test basic ToolResult functionality
    result = MCPToolResult(status="success", toolUseId="test-123", content=[{"text": "Test message"}])

    assert result["status"] == "success"
    assert result["toolUseId"] == "test-123"
    assert result["content"][0]["text"] == "Test message"

    # Test that structuredContent is optional
    assert "structuredContent" not in result or result.get("structuredContent") is None

    # Test with structuredContent
    result_with_structured = MCPToolResult(
        status="success", toolUseId="test-456", content=[{"text": "Test message"}], structuredContent={"key": "value"}
    )

    assert result_with_structured["structuredContent"] == {"key": "value"}

    # isError is optional — absent by default
    assert "isError" not in result

    # isError can be set to flag tool-reported application errors
    result_with_is_error = MCPToolResult(
        status="error", toolUseId="test-789", content=[{"text": "Tool failed"}], isError=True
    )
    assert result_with_is_error["isError"] is True

    result_with_cancelled = MCPToolResult(
        status="error", toolUseId="test-789", content=[{"text": "cancelled"}], cancelled=True
    )
    assert result_with_cancelled["cancelled"] is True


def test_call_tool_sync_without_structured_content(mock_transport, mock_session):
    """Test that call_tool_sync works correctly when no structured content is provided."""
    mock_content = MCPTextContent(type="text", text="Test message")
    mock_session.call_tool.return_value = MCPCallToolResult(
        isError=False,
        content=[mock_content],  # No structuredContent
    )

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.call_tool_sync(tool_use_id="test-123", name="test_tool", arguments={"param": "value"})

        assert result["status"] == "success"
        assert result["toolUseId"] == "test-123"
        assert len(result["content"]) == 1
        assert result["content"][0]["text"] == "Test message"
        # structuredContent should be None when not provided by MCP
        assert result.get("structuredContent") is None


def test_exception_when_future_not_running():
    """Test exception handling when the future is not running."""
    # Create a client.with a mock transport
    mock_transport_callable = MagicMock()
    client = MCPClient(mock_transport_callable)

    # Create a mock future that is not running
    mock_future = MagicMock()
    mock_future.running.return_value = False
    client._init_future = mock_future

    # Create a mock event loop
    mock_event_loop = MagicMock()
    mock_event_loop.run_until_complete.side_effect = Exception("Test exception")

    # Patch the event loop creation
    with patch("asyncio.new_event_loop", return_value=mock_event_loop):
        # Run the background task which should trigger the exception
        try:
            client._background_task()
        except Exception:
            pass  # We expect an exception to be raised

        # Verify that set_exception was not called since the future was not running
        mock_future.set_exception.assert_not_called()


# Prompt Tests - Sync Methods


def test_list_prompts_sync(mock_transport, mock_session):
    """Test that list_prompts_sync correctly retrieves prompts."""
    mock_prompt = Prompt(name="test_prompt", description="A test prompt", id="prompt_1")
    mock_session.list_prompts.return_value = ListPromptsResult(prompts=[mock_prompt])

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.list_prompts_sync()

        mock_session.list_prompts.assert_called_once_with(params=None)
        assert len(result.prompts) == 1
        assert result.prompts[0].name == "test_prompt"
        assert next_cursor(result) is None


def test_list_prompts_sync_with_pagination_token(mock_transport, mock_session):
    """Test that list_prompts_sync correctly passes pagination token and returns next cursor."""
    mock_prompt = Prompt(name="test_prompt", description="A test prompt", id="prompt_1")
    mock_session.list_prompts.return_value = ListPromptsResult(prompts=[mock_prompt], nextCursor="next_page_token")

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.list_prompts_sync(pagination_token="current_page_token")

        mock_session.list_prompts.assert_called_once_with(params=PaginatedRequestParams(cursor="current_page_token"))
        assert len(result.prompts) == 1
        assert result.prompts[0].name == "test_prompt"
        assert next_cursor(result) == "next_page_token"


def test_list_prompts_sync_session_not_active():
    """Test that list_prompts_sync raises an error when session is not active."""
    client = MCPClient(MagicMock())

    with pytest.raises(MCPClientInitializationError, match="client session is not running"):
        client.list_prompts_sync()


def test_get_prompt_sync(mock_transport, mock_session):
    """Test that get_prompt_sync correctly retrieves a prompt."""
    mock_message = PromptMessage(role="user", content=MCPTextContent(type="text", text="This is a test prompt"))
    mock_session.get_prompt.return_value = GetPromptResult(messages=[mock_message])

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.get_prompt_sync("test_prompt_id", {"key": "value"})

        if MCP_V2:
            mock_session.get_prompt.assert_called_once_with(
                "test_prompt_id",
                arguments={"key": "value"},
                input_responses=None,
                request_state=None,
                allow_input_required=True,
            )
        else:
            mock_session.get_prompt.assert_called_once_with("test_prompt_id", arguments={"key": "value"})
        assert len(result.messages) == 1
        assert result.messages[0].role == "user"
        assert result.messages[0].content.text == "This is a test prompt"


def test_get_prompt_sync_session_not_active():
    """Test that get_prompt_sync raises an error when session is not active."""
    client = MCPClient(MagicMock())

    with pytest.raises(MCPClientInitializationError, match="client session is not running"):
        client.get_prompt_sync("test_prompt_id", {})


def test_timeout_initialization_cleanup():
    """Test that timeout during initialization properly cleans up."""

    def slow_transport():
        time.sleep(5)
        return MagicMock()

    client = MCPClient(slow_transport, startup_timeout=1)

    with patch.object(client, "stop") as mock_stop:
        with pytest.raises(MCPClientInitializationError, match="background thread did not start in 1 seconds"):
            client.start()
        mock_stop.assert_called_once_with(None, None, None)


def test_stop_with_no_background_thread():
    """Test that stop() handles the case when no background thread exists."""
    client = MCPClient(MagicMock())

    # Ensure no background thread exists
    assert client._background_thread is None

    # Mock join to verify it's not called
    with patch("threading.Thread.join") as mock_join:
        client.stop(None, None, None)
        mock_join.assert_not_called()

    # Verify cleanup occurred
    assert client._background_thread is None


def test_stop_with_background_thread_but_no_event_loop():
    """Test that stop() handles the case when background thread exists but event loop is None."""
    client = MCPClient(MagicMock())

    # Mock a background thread without event loop
    mock_thread = MagicMock()
    mock_thread.join = MagicMock()
    client._background_thread = mock_thread
    client._background_thread_event_loop = None

    # Should not raise any exceptions and should join the thread
    client.stop(None, None, None)

    # Verify thread was joined
    mock_thread.join.assert_called_once()

    # Verify cleanup occurred
    assert client._background_thread is None


def test_stop_closes_event_loop():
    """Test that stop() properly closes the event loop when it exists."""
    client = MCPClient(MagicMock())

    # Mock a background thread with event loop
    mock_thread = MagicMock()
    mock_thread.join = MagicMock()
    mock_event_loop = MagicMock()
    mock_event_loop.close = MagicMock()

    client._background_thread = mock_thread
    client._background_thread_event_loop = mock_event_loop

    # Should close the event loop and join the thread
    client.stop(None, None, None)

    # Verify thread was joined
    mock_thread.join.assert_called_once()

    # Verify event loop was closed
    mock_event_loop.close.assert_called_once()

    # Verify cleanup occurred
    assert client._background_thread is None
    assert client._background_thread_event_loop is None


def test_stop_skips_cleanup_during_interpreter_finalization():
    """Test that stop() is a no-op when the interpreter is finalizing.

    On Python 3.14+, threading.Thread.join() raises PythonFinalizationError at
    shutdown. The background thread is a daemon and is reclaimed automatically,
    so stop() should skip join() and event loop cleanup to avoid noisy
    tracebacks surfaced via Agent.__del__ during GC. See issue #2143.
    """
    client = MCPClient(MagicMock())

    mock_thread = MagicMock()
    mock_event_loop = MagicMock()
    client._background_thread = mock_thread
    client._background_thread_event_loop = mock_event_loop

    with patch("strands.tools.mcp.mcp_client.sys.is_finalizing", return_value=True):
        # Must not raise, and must not touch the thread or event loop.
        client.stop(None, None, None)

    mock_thread.join.assert_not_called()
    mock_event_loop.close.assert_not_called()
    # State is intentionally left alone during finalization — the interpreter
    # is going away and cleanup is unnecessary.
    assert client._background_thread is mock_thread
    assert client._background_thread_event_loop is mock_event_loop


def test_mcp_client_state_reset_after_timeout():
    """Test that all client state is properly reset after timeout."""

    def slow_transport():
        time.sleep(4)  # Longer than timeout
        return MagicMock()

    client = MCPClient(slow_transport, startup_timeout=2)

    # First attempt should timeout
    with pytest.raises(MCPClientInitializationError, match="background thread did not start in 2 seconds"):
        client.start()

    # Verify all state is reset
    assert client._background_thread is None
    assert client._background_thread_session is None
    assert client._background_thread_event_loop is None
    assert not client._init_future.done()  # New future created


def test_call_tool_sync_image_content(mock_transport, mock_session):
    """A top-level ImageContent block should map to image content with decoded bytes."""
    with open("tests_integ/resources/yellow.png", "rb") as image_file:
        png_data = image_file.read()

    image_content = MCPImageContent(type="image", data=base64.b64encode(png_data).decode(), mimeType="image/png")
    mock_session.call_tool.return_value = MCPCallToolResult(isError=False, content=[image_content])

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.call_tool_sync(tool_use_id="img-1", name="get_image", arguments={})

        assert result == {
            "status": "success",
            "toolUseId": "img-1",
            "content": [{"image": {"format": "png", "source": {"bytes": png_data}}}],
            "isError": False,
        }


def test_call_tool_sync_embedded_nested_text(mock_transport, mock_session):
    """EmbeddedResource.resource (uri + text) should map to plain text content."""
    embedded_resource = {
        "type": "resource",  # required literal
        "resource": {
            "uri": "mcp://resource/embedded-text-1",
            "text": "inner text",
            "mimeType": "text/plain",
        },
    }
    mock_session.call_tool.return_value = MCPCallToolResult(isError=False, content=[embedded_resource])

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.call_tool_sync(tool_use_id="er-text", name="get_file_contents", arguments={})

        assert_session_call_tool_once_with(mock_session, "get_file_contents", {})
        assert result["status"] == "success"
        assert len(result["content"]) == 1
        assert result["content"][0]["text"] == "inner text"


def test_call_tool_sync_embedded_nested_base64_textual_mime(mock_transport, mock_session):
    """EmbeddedResource.resource (uri + blob with textual MIME) should decode to text."""

    payload = base64.b64encode(b'{"k":"v"}').decode()

    embedded_resource = {
        "type": "resource",
        "resource": {
            "uri": "mcp://resource/embedded-blob-1",
            # NOTE: blob is a STRING, mimeType is sibling
            "blob": payload,
            "mimeType": "application/json",
        },
    }
    mock_session.call_tool.return_value = MCPCallToolResult(isError=False, content=[embedded_resource])

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.call_tool_sync(tool_use_id="er-blob", name="get_file_contents", arguments={})

        assert_session_call_tool_once_with(mock_session, "get_file_contents", {})
        assert result["status"] == "success"
        assert len(result["content"]) == 1
        assert result["content"][0]["text"] == '{"k":"v"}'


def test_call_tool_sync_embedded_image_blob(mock_transport, mock_session):
    """EmbeddedResource.resource (blob with image MIME) should map to image content."""
    # Read yellow.png file
    with open("tests_integ/resources/yellow.png", "rb") as image_file:
        png_data = image_file.read()
    payload = base64.b64encode(png_data).decode()

    embedded_resource = {
        "type": "resource",
        "resource": {
            "uri": "mcp://resource/embedded-image",
            "blob": payload,
            "mimeType": "image/png",
        },
    }
    mock_session.call_tool.return_value = MCPCallToolResult(isError=False, content=[embedded_resource])

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.call_tool_sync(tool_use_id="er-image", name="get_file_contents", arguments={})

        assert_session_call_tool_once_with(mock_session, "get_file_contents", {})
        assert result["status"] == "success"
        assert len(result["content"]) == 1
        assert "image" in result["content"][0]
        assert result["content"][0]["image"]["format"] == "png"
        assert "bytes" in result["content"][0]["image"]["source"]


def test_call_tool_sync_embedded_non_textual_blob_dropped(mock_transport, mock_session):
    """EmbeddedResource.resource (blob with non-textual/unknown MIME) should be dropped."""
    payload = base64.b64encode(b"\x00\x01\x02\x03").decode()

    embedded_resource = {
        "type": "resource",
        "resource": {
            "uri": "mcp://resource/embedded-binary",
            "blob": payload,
            "mimeType": "application/octet-stream",
        },
    }
    mock_session.call_tool.return_value = MCPCallToolResult(isError=False, content=[embedded_resource])

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.call_tool_sync(tool_use_id="er-binary", name="get_file_contents", arguments={})

        assert_session_call_tool_once_with(mock_session, "get_file_contents", {})
        assert result["status"] == "success"
        assert len(result["content"]) == 0  # Content should be dropped


def test_call_tool_sync_embedded_multiple_textual_mimes(mock_transport, mock_session):
    """EmbeddedResource with different textual MIME types should decode to text."""

    # Test YAML content
    yaml_content = base64.b64encode(b"key: value\nlist:\n  - item1\n  - item2").decode()
    embedded_resource = {
        "type": "resource",
        "resource": {
            "uri": "mcp://resource/embedded-yaml",
            "blob": yaml_content,
            "mimeType": "application/yaml",
        },
    }
    mock_session.call_tool.return_value = MCPCallToolResult(isError=False, content=[embedded_resource])

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.call_tool_sync(tool_use_id="er-yaml", name="get_file_contents", arguments={})

        assert_session_call_tool_once_with(mock_session, "get_file_contents", {})
        assert result["status"] == "success"
        assert len(result["content"]) == 1
        assert "key: value" in result["content"][0]["text"]


def test_call_tool_sync_embedded_unknown_resource_type_dropped(mock_transport, mock_session):
    """EmbeddedResource with unknown resource type should be dropped for forward compatibility."""

    # Mock an unknown resource type that's neither TextResourceContents nor BlobResourceContents
    class UnknownResourceContents:
        def __init__(self):
            self.uri = "mcp://resource/unknown-type"
            self.mimeType = "application/unknown"
            self.data = "some unknown data"

    # Create a mock embedded resource with unknown resource type
    mock_embedded_resource = MagicMock()
    mock_embedded_resource.resource = UnknownResourceContents()

    # A loose mock stands in for the result model, so both lines' attribute
    # spellings need explicit values.
    mock_session.call_tool.return_value = MagicMock(
        isError=False,
        is_error=False,
        content=[mock_embedded_resource],
        structuredContent=None,
        structured_content=None,
        meta=None,
    )

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.call_tool_sync(tool_use_id="er-unknown", name="get_file_contents", arguments={})

        assert_session_call_tool_once_with(mock_session, "get_file_contents", {})
        assert result["status"] == "success"
        assert len(result["content"]) == 0  # Unknown resource type should be dropped


@pytest.mark.asyncio
async def test_handle_session_message_non_fatal_error():
    """Test that _handle_session_message ignores non-fatal errors and logs them."""
    client = MCPClient(MagicMock())

    # Test the message handler directly with a non-fatal error
    with patch.object(client, "_log_debug_with_thread") as mock_log:
        # This should not raise an exception
        await client._handle_session_message(Exception("unknown request id: abc123"))

        # Verify the non-fatal error was logged as ignored
        assert mock_log.called
        call_args = mock_log.call_args[0]
        assert "ignoring non-fatal MCP session error" in call_args[0]


@pytest.mark.asyncio
async def test_handle_session_message_fatal_error():
    """Test that _handle_session_message raises fatal errors."""
    client = MCPClient(MagicMock())

    # This should raise the exception
    with pytest.raises(Exception, match="connection timeout"):
        await client._handle_session_message(Exception("connection timeout"))


@pytest.mark.asyncio
async def test_handle_session_message_non_exception():
    """Test that _handle_session_message handles non-exception messages."""
    client = MCPClient(MagicMock())

    # This should not raise an exception
    await client._handle_session_message("normal message")


@pytest.mark.asyncio
async def test_handle_session_message_tools_changed_schedules_a_refresh():
    """Test that a tools list-changed notification schedules a refresh when the callback is set."""
    client = MCPClient(MagicMock(), on_tools_changed=MagicMock())
    notification = ToolListChangedNotification(method="notifications/tools/list_changed")

    with patch.object(client, "_handle_tools_changed", new=AsyncMock()) as mock_refresh:
        await client._handle_session_message(notification)
        assert client._tools_refresh_tasks
        await asyncio.gather(*client._tools_refresh_tasks)
        # One more loop tick so the done-callback that discards the task runs.
        await asyncio.sleep(0)

    mock_refresh.assert_awaited_once()
    assert not client._tools_refresh_tasks


@pytest.mark.asyncio
async def test_handle_session_message_tools_changed_ignored_without_callback():
    """Test that a tools list-changed notification is a no-op when no callback is registered."""
    client = MCPClient(MagicMock())
    notification = ToolListChangedNotification(method="notifications/tools/list_changed")

    await client._handle_session_message(notification)

    assert not client._tools_refresh_tasks


@pytest.mark.asyncio
async def test_handle_tools_changed_coalesces_overlapping_notifications(monkeypatch):
    """Test that a notification arriving mid-refresh folds into one trailing rerun."""
    monkeypatch.setattr(mcp_client_module, "_TOOLS_CHANGED_DEBOUNCE_SECONDS", 0)
    client = MCPClient(MagicMock(), on_tools_changed=MagicMock())
    refresh_calls = []
    first_refresh_started = threading.Event()
    release_first_refresh = threading.Event()

    def blocking_refresh():
        refresh_calls.append(len(refresh_calls))
        if len(refresh_calls) == 1:
            first_refresh_started.set()
            release_first_refresh.wait(timeout=5)

    monkeypatch.setattr(client, "_refresh_loaded_tools", blocking_refresh)

    first_notification = asyncio.create_task(client._handle_tools_changed())
    deadline = time.time() + 5
    while not first_refresh_started.is_set():
        assert time.time() < deadline, "first refresh never started"
        await asyncio.sleep(0.01)

    await client._handle_tools_changed()
    assert client._tools_refresh_pending

    release_first_refresh.set()
    await first_notification

    assert refresh_calls == [0, 1]
    assert not client._tools_refresh_in_progress


@pytest.mark.asyncio
async def test_handle_tools_changed_logs_and_recovers_when_the_refresh_raises(monkeypatch, caplog):
    """Test that a failing refresh is logged as a warning and leaves the client ready for the next one."""
    monkeypatch.setattr(mcp_client_module, "_TOOLS_CHANGED_DEBOUNCE_SECONDS", 0)
    client = MCPClient(MagicMock(), on_tools_changed=MagicMock())
    monkeypatch.setattr(client, "_refresh_loaded_tools", MagicMock(side_effect=RuntimeError("listing failed")))

    await client._handle_tools_changed()

    assert "failed to refresh tools after list-changed notification" in caplog.text
    assert not client._tools_refresh_in_progress


@pytest.mark.asyncio
async def test_handle_tools_changed_failed_round_keeps_the_queued_rerun(monkeypatch, caplog):
    """Test that a round that raises does not discard a rerun queued by a mid-refresh notification."""
    monkeypatch.setattr(mcp_client_module, "_TOOLS_CHANGED_DEBOUNCE_SECONDS", 0)
    client = MCPClient(MagicMock(), on_tools_changed=MagicMock())
    refresh_calls = []

    def failing_first_refresh():
        refresh_calls.append(len(refresh_calls))
        if len(refresh_calls) == 1:
            # A notification landing mid-refresh queues the trailing rerun.
            client._tools_refresh_pending = True
            raise RuntimeError("listing failed")

    monkeypatch.setattr(client, "_refresh_loaded_tools", failing_first_refresh)

    await client._handle_tools_changed()

    assert refresh_calls == [0, 1]
    assert "failed to refresh tools after list-changed notification" in caplog.text
    assert not client._tools_refresh_in_progress
    assert not client._tools_refresh_pending


def test_refresh_loaded_tools_updates_the_cache_and_invokes_the_callback():
    """Test that a refresh replaces the cached tools and reports the change to the callback."""
    on_tools_changed = MagicMock()
    client = MCPClient(MagicMock(), on_tools_changed=on_tools_changed)
    previous_tool = MagicMock()
    previous_tool.tool_name = "previous_tool"
    client._loaded_tools = [previous_tool]
    refreshed_tools = [MagicMock()]

    with patch.object(client, "_list_all_tools_sync", return_value=refreshed_tools):
        client._refresh_loaded_tools()

    assert client._loaded_tools is refreshed_tools
    on_tools_changed.assert_called_once_with(["previous_tool"], refreshed_tools)


def test_refresh_loaded_tools_raising_callback_keeps_the_refreshed_cache(caplog):
    """Test that a raising callback is logged with its own message and the cache stays refreshed."""
    on_tools_changed = MagicMock(side_effect=RuntimeError("consumer broke"))
    client = MCPClient(MagicMock(), on_tools_changed=on_tools_changed)
    refreshed_tools = [MagicMock()]

    with patch.object(client, "_list_all_tools_sync", return_value=refreshed_tools):
        client._refresh_loaded_tools()

    assert client._loaded_tools is refreshed_tools
    assert "on_tools_changed callback raised" in caplog.text
    assert "failed to refresh tools" not in caplog.text


def test_on_tools_changed_is_settable_after_construction():
    """Test that the callback can be registered and removed through the property."""
    client = MCPClient(MagicMock())
    assert client.on_tools_changed is None

    callback = MagicMock()
    client.on_tools_changed = callback

    assert client.on_tools_changed is callback


def test_subscription_entered_before_ready_and_exited_on_stop(mock_transport, mock_session):
    """Test that the tools list-changed subscription wraps the session lifetime when a callback is set."""
    lifecycle_events = []

    @asynccontextmanager
    async def recording_subscription(session):
        lifecycle_events.append("enter")
        try:
            yield None
        finally:
            lifecycle_events.append("exit")

    with patch("strands.tools.mcp.mcp_client.tools_changed_subscription", new=recording_subscription):
        client = MCPClient(mock_transport["transport_callable"], on_tools_changed=MagicMock())
        with client:
            assert lifecycle_events == ["enter"]
        assert lifecycle_events == ["enter", "exit"]


def test_subscription_not_entered_without_callback(mock_transport, mock_session):
    """Test that no subscription is held when no callback is registered."""
    lifecycle_events = []

    @asynccontextmanager
    async def recording_subscription(session):
        lifecycle_events.append("enter")
        yield None

    with patch("strands.tools.mcp.mcp_client.tools_changed_subscription", new=recording_subscription):
        with MCPClient(mock_transport["transport_callable"]):
            pass

    assert lifecycle_events == []


def test_start_raises_when_the_subscription_never_acknowledges(mock_transport, mock_session):
    """Test that a subscription the server never acknowledges bounds start() instead of hanging it."""

    @asynccontextmanager
    async def never_acknowledging_subscription(session):
        await asyncio.Event().wait()
        yield None

    with patch("strands.tools.mcp.mcp_client.tools_changed_subscription", new=never_acknowledging_subscription):
        client = MCPClient(mock_transport["transport_callable"], on_tools_changed=MagicMock(), startup_timeout=1)
        started = time.time()
        with pytest.raises(MCPClientInitializationError):
            client.start()

    assert time.time() - started < 10


def test_stop_resets_tools_refresh_state_for_restart(mock_transport, mock_session):
    """Test that a restarted client refreshes again after a stop that interrupted a refresh.

    A refresh task destroyed with its event loop never runs the finally block
    that clears the in-progress flag, so stop() must reset the refresh state
    itself for the next start() to work.
    """
    client = MCPClient(mock_transport["transport_callable"], on_tools_changed=MagicMock())
    with client:
        client._tools_refresh_in_progress = True
        client._tools_refresh_pending = True

        # The stale entry must be a real future: stop() drains this set with
        # asyncio.wait, which on Python 3.10 rejects a non-awaitable stand-in.
        async def _seed_stale_refresh_task() -> None:
            stale_refresh_task: asyncio.Future[None] = asyncio.get_running_loop().create_future()
            stale_refresh_task.set_result(None)
            client._tools_refresh_tasks.add(stale_refresh_task)

        asyncio.run_coroutine_threadsafe(_seed_stale_refresh_task(), client._background_thread_event_loop).result(
            timeout=5
        )

    with client:
        assert not client._tools_refresh_in_progress
        assert not client._tools_refresh_pending
        assert not client._tools_refresh_tasks


def test_tools_changed_notification_end_to_end_refreshes_and_notifies(mock_transport, mock_session, monkeypatch):
    """Test the composed chain: notification, refresh off the loop thread, callback with real tools."""
    monkeypatch.setattr(mcp_client_module, "_TOOLS_CHANGED_DEBOUNCE_SECONDS", 0)
    callback_called = threading.Event()
    callback_args = {}

    def on_tools_changed(previous_names, refreshed_tools):
        callback_args["previous_names"] = previous_names
        callback_args["refreshed_tools"] = refreshed_tools
        callback_called.set()

    refreshed_tool = MCPTool(name="echo", description="test tool", inputSchema={"type": "object", "properties": {}})
    mock_session.list_tools.return_value = ListToolsResult(tools=[refreshed_tool])
    notification = ToolListChangedNotification(method="notifications/tools/list_changed")

    client = MCPClient(mock_transport["transport_callable"], on_tools_changed=on_tools_changed)
    with client:
        asyncio.run_coroutine_threadsafe(
            client._handle_session_message(notification), client._background_thread_event_loop
        ).result(timeout=5)
        assert callback_called.wait(timeout=5)

        assert callback_args["previous_names"] == []
        assert [tool.tool_name for tool in callback_args["refreshed_tools"]] == ["echo"]
        assert client._loaded_tools == callback_args["refreshed_tools"]


def test_stop_with_refresh_in_flight_unwinds_the_worker(mock_transport, mock_session, monkeypatch):
    """Test that stop() lets an in-flight refresh unwind instead of stranding its worker thread."""
    monkeypatch.setattr(mcp_client_module, "_TOOLS_CHANGED_DEBOUNCE_SECONDS", 0)
    refresh_started = threading.Event()

    async def hanging_list_tools(*args, **kwargs):
        refresh_started.set()
        await asyncio.Event().wait()

    mock_session.list_tools.side_effect = hanging_list_tools
    notification = ToolListChangedNotification(method="notifications/tools/list_changed")

    client = MCPClient(mock_transport["transport_callable"], on_tools_changed=MagicMock())
    with client:
        asyncio.run_coroutine_threadsafe(
            client._handle_session_message(notification), client._background_thread_event_loop
        ).result(timeout=5)
        assert refresh_started.wait(timeout=5)

    # Exiting the block proves stop() drained the refresh; a restart proves nothing leaked.
    mock_session.list_tools.side_effect = None
    with client:
        assert not client._tools_refresh_tasks


def test_call_tool_sync_with_meta_and_structured_content(mock_transport, mock_session):
    """Test that call_tool_sync correctly handles both meta and structuredContent fields."""
    mock_content = MCPTextContent(type="text", text="Test message")
    metadata = {"tokenUsage": {"inputTokens": 100, "outputTokens": 50}}
    structured_content = {"result": 42, "status": "completed"}
    mock_session.call_tool.return_value = MCPCallToolResult(
        isError=False, content=[mock_content], _meta=metadata, structuredContent=structured_content
    )

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.call_tool_sync(tool_use_id="test-123", name="test_tool", arguments={"param": "value"})

        assert_session_call_tool_once_with(mock_session, "test_tool", {"param": "value"})

        assert result["status"] == "success"
        assert result["toolUseId"] == "test-123"
        assert "metadata" in result
        assert result["metadata"] == metadata
        assert "structuredContent" in result
        assert result["structuredContent"] == structured_content


# Resource Tests - Sync Methods


def test_list_resources_sync(mock_transport, mock_session):
    """Test that list_resources_sync correctly retrieves resources."""
    mock_resource = Resource(
        uri="file://documents/test.txt", name="test.txt", description="A test document", mimeType="text/plain"
    )
    mock_session.list_resources.return_value = ListResourcesResult(resources=[mock_resource])

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.list_resources_sync()

        mock_session.list_resources.assert_called_once_with(params=None)
        assert len(result.resources) == 1
        assert result.resources[0].name == "test.txt"
        assert str(result.resources[0].uri) == "file://documents/test.txt"
        assert next_cursor(result) is None


def test_list_resources_sync_with_pagination_token(mock_transport, mock_session):
    """Test that list_resources_sync correctly passes pagination token and returns next cursor."""
    mock_resource = Resource(
        uri="file://documents/test.txt", name="test.txt", description="A test document", mimeType="text/plain"
    )
    mock_session.list_resources.return_value = ListResourcesResult(resources=[mock_resource], nextCursor="next_page")

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.list_resources_sync(pagination_token="current_page")

        mock_session.list_resources.assert_called_once_with(params=PaginatedRequestParams(cursor="current_page"))
        assert len(result.resources) == 1
        assert result.resources[0].name == "test.txt"
        assert next_cursor(result) == "next_page"


def test_list_resources_sync_session_not_active():
    """Test that list_resources_sync raises an error when session is not active."""
    client = MCPClient(MagicMock())

    with pytest.raises(MCPClientInitializationError, match="client session is not running"):
        client.list_resources_sync()


def test_read_resource_sync(mock_transport, mock_session):
    """Test that read_resource_sync correctly reads a resource."""
    mock_content = TextResourceContents(uri="file://documents/test.txt", text="Resource content", mimeType="text/plain")
    mock_session.read_resource.return_value = ReadResourceResult(contents=[mock_content])

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.read_resource_sync("file://documents/test.txt")

        # Verify the session method was called
        mock_session.read_resource.assert_called_once()
        # Check the URI argument (it will be wrapped as AnyUrl)
        call_args = mock_session.read_resource.call_args[0]
        assert str(call_args[0]) == "file://documents/test.txt"

        assert len(result.contents) == 1
        assert result.contents[0].text == "Resource content"


def test_read_resource_sync_with_anyurl(mock_transport, mock_session):
    """Test that read_resource_sync correctly handles AnyUrl input."""
    mock_content = TextResourceContents(uri="file://documents/test.txt", text="Resource content", mimeType="text/plain")
    mock_session.read_resource.return_value = ReadResourceResult(contents=[mock_content])

    with MCPClient(mock_transport["transport_callable"]) as client:
        uri = AnyUrl("file://documents/test.txt")
        result = client.read_resource_sync(uri)

        mock_session.read_resource.assert_called_once()
        call_args = mock_session.read_resource.call_args[0]
        assert str(call_args[0]) == "file://documents/test.txt"

        assert len(result.contents) == 1
        assert result.contents[0].text == "Resource content"


def test_read_resource_sync_session_not_active():
    """Test that read_resource_sync raises an error when session is not active."""
    client = MCPClient(MagicMock())

    with pytest.raises(MCPClientInitializationError, match="client session is not running"):
        client.read_resource_sync("file://documents/test.txt")


def test_list_resource_templates_sync(mock_transport, mock_session):
    """Test that list_resource_templates_sync correctly retrieves resource templates."""
    mock_template = ResourceTemplate(
        uriTemplate="file://documents/{name}",
        name="document_template",
        description="Template for documents",
        mimeType="text/plain",
    )
    mock_session.list_resource_templates.return_value = ListResourceTemplatesResult(resourceTemplates=[mock_template])

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.list_resource_templates_sync()

        mock_session.list_resource_templates.assert_called_once_with(params=None)
        templates = resource_templates(result)
        assert len(templates) == 1
        assert templates[0].name == "document_template"
        assert (templates[0].uri_template if MCP_V2 else templates[0].uriTemplate) == "file://documents/{name}"
        assert next_cursor(result) is None


def test_list_resource_templates_sync_with_pagination_token(mock_transport, mock_session):
    """Test that list_resource_templates_sync correctly passes pagination token and returns next cursor."""
    mock_template = ResourceTemplate(
        uriTemplate="file://documents/{name}",
        name="document_template",
        description="Template for documents",
        mimeType="text/plain",
    )
    mock_session.list_resource_templates.return_value = ListResourceTemplatesResult(
        resourceTemplates=[mock_template], nextCursor="next_page"
    )

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.list_resource_templates_sync(pagination_token="current_page")

        mock_session.list_resource_templates.assert_called_once_with(
            params=PaginatedRequestParams(cursor="current_page")
        )
        templates = resource_templates(result)
        assert len(templates) == 1
        assert templates[0].name == "document_template"
        assert next_cursor(result) == "next_page"


def test_list_resource_templates_sync_session_not_active():
    """Test that list_resource_templates_sync raises an error when session is not active."""
    client = MCPClient(MagicMock())

    with pytest.raises(MCPClientInitializationError, match="client session is not running"):
        client.list_resource_templates_sync()


@pytest.mark.asyncio
async def test_handle_session_message_with_percent_in_message():
    """Test that _handle_session_message handles messages containing % characters without string formatting errors.

    This is a regression test for issue #1244 where MCP error messages containing '%' characters
    (e.g., from URLs like "https://example.com/path?param=value%20encoded") would cause a
    TypeError: not all arguments converted during string formatting.
    """
    client = MCPClient(MagicMock())

    # Test with a message that contains % characters (like URL-encoded strings)
    # This simulates the error that occurs when MCP servers return messages with % in them
    error_with_percent = Exception("unknown request id: abc%20123%30def")

    # This should not raise TypeError and should not raise the exception (since it's non-fatal)
    await client._handle_session_message(error_with_percent)


def test_call_tool_sync_elicitation_error(mock_transport, mock_session):
    """Test that call_tool_sync correctly handles elicitation required errors."""
    from mcp.types import ElicitationRequiredErrorData, ElicitRequestURLParams

    elicitation_data = ElicitationRequiredErrorData(
        elicitations=[
            ElicitRequestURLParams(
                url="https://example.com/auth", message="Please authorize the application", elicitationId="elicit-123"
            )
        ]
    )

    error = make_mcp_error(code=-32042, data=elicitation_data.model_dump())
    mock_session.call_tool.side_effect = error

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.call_tool_sync(tool_use_id="test-123", name="test_tool", arguments={"param": "value"})

        assert result["status"] == "error"
        assert result["toolUseId"] == "test-123"
        assert len(result["content"]) == 1
        assert "MCP Elicitation required" in result["content"][0]["text"]
        assert "https://example.com/auth" in result["content"][0]["text"]
        assert "Please authorize the application" in result["content"][0]["text"]
        assert "elicit-123" in result["content"][0]["text"]


def test_call_tool_sync_elicitation_error_multiple_urls(mock_transport, mock_session):
    """Test that call_tool_sync correctly handles elicitation errors with multiple elicitations."""
    from mcp.types import ElicitationRequiredErrorData, ElicitRequestURLParams

    elicitation_data = ElicitationRequiredErrorData(
        elicitations=[
            ElicitRequestURLParams(
                url="https://example.com/auth1", message="First authorization", elicitationId="elicit-1"
            ),
            ElicitRequestURLParams(
                url="https://example.com/auth2", message="Second authorization", elicitationId="elicit-2"
            ),
        ]
    )

    error = make_mcp_error(code=-32042, data=elicitation_data.model_dump())
    mock_session.call_tool.side_effect = error

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.call_tool_sync(tool_use_id="test-123", name="test_tool", arguments={"param": "value"})

        assert result["status"] == "error"
        assert result["toolUseId"] == "test-123"
        assert len(result["content"]) == 1
        assert "MCP Elicitation required" in result["content"][0]["text"]
        assert "https://example.com/auth1" in result["content"][0]["text"]
        assert "https://example.com/auth2" in result["content"][0]["text"]
        assert "First authorization" in result["content"][0]["text"]
        assert "Second authorization" in result["content"][0]["text"]
        assert "elicit-1" in result["content"][0]["text"]
        assert "elicit-2" in result["content"][0]["text"]


def test_call_tool_sync_elicitation_error_no_urls(mock_transport, mock_session):
    """Test that -32042 error with empty URL still returns generic elicitation result."""
    from mcp.types import ElicitationRequiredErrorData, ElicitRequestURLParams

    elicitation_data = ElicitationRequiredErrorData(
        elicitations=[ElicitRequestURLParams(url="", message="No URL provided", elicitationId="elicit-1")]
    )
    error = make_mcp_error(code=-32042, data=elicitation_data.model_dump())
    mock_session.call_tool.side_effect = error

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.call_tool_sync(tool_use_id="test-123", name="test_tool", arguments={})
        assert result["status"] == "error"
        assert "MCP Elicitation required" in result["content"][0]["text"]
        assert "elicit-1" in result["content"][0]["text"]
        assert "No URL provided" in result["content"][0]["text"]


def test_call_tool_sync_other_mcp_error_code(mock_transport, mock_session):
    """Test that non-32042 MCPError falls through to generic error."""
    error = make_mcp_error(code=-32600, message="Invalid request")
    mock_session.call_tool.side_effect = error

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.call_tool_sync(tool_use_id="test-123", name="test_tool", arguments={})
        assert result["status"] == "error"
        assert "Tool execution failed" in result["content"][0]["text"]


def test_call_tool_sync_elicitation_error_malformed_data(mock_transport, mock_session):
    """Test that -32042 with unparseable data falls through to generic error."""
    error = make_mcp_error(code=-32042, data={"garbage": True})
    mock_session.call_tool.side_effect = error

    with MCPClient(mock_transport["transport_callable"]) as client:
        result = client.call_tool_sync(tool_use_id="test-123", name="test_tool", arguments={})
        assert result["status"] == "error"
        assert "Tool execution failed" in result["content"][0]["text"]


@pytest.mark.asyncio
async def test_call_tool_async_elicitation_error(mock_transport, mock_session):
    """Test that call_tool_async correctly handles elicitation required errors."""
    from mcp.types import ElicitationRequiredErrorData, ElicitRequestURLParams

    elicitation_data = ElicitationRequiredErrorData(
        elicitations=[
            ElicitRequestURLParams(
                url="https://example.com/auth", message="Please authorize the application", elicitationId="elicit-123"
            )
        ]
    )

    error = make_mcp_error(code=-32042, data=elicitation_data.model_dump())

    with MCPClient(mock_transport["transport_callable"]) as client:
        with (
            patch("asyncio.run_coroutine_threadsafe") as mock_run_coroutine_threadsafe,
            patch("asyncio.wrap_future") as mock_wrap_future,
        ):
            mock_future = MagicMock()
            mock_run_coroutine_threadsafe.return_value = mock_future

            async def mock_awaitable():
                raise error

            mock_wrap_future.return_value = mock_awaitable()

            result = await client.call_tool_async(
                tool_use_id="test-123", name="test_tool", arguments={"param": "value"}
            )

        assert result["status"] == "error"
        assert result["toolUseId"] == "test-123"
        assert len(result["content"]) == 1
        assert "MCP Elicitation required" in result["content"][0]["text"]
        assert "https://example.com/auth" in result["content"][0]["text"]
        assert "Please authorize the application" in result["content"][0]["text"]
        assert "elicit-123" in result["content"][0]["text"]


def test_map_mcp_content_subclass_override(mock_transport, mock_session):
    """Subclass override of map_mcp_content_to_tool_result_content is invoked by the call site."""

    class CustomMCPClient(MCPClient):
        def map_mcp_content_to_tool_result_content(self, content):
            result = super().map_mcp_content_to_tool_result_content(content)
            if result and "text" in result:
                result = {"text": "[intercepted]"}
            return result

    embedded_resource = {
        "type": "resource",
        "resource": {
            "uri": "mcp://resource/test",
            "text": "original text",
            "mimeType": "text/plain",
        },
    }
    mock_session.call_tool.return_value = MCPCallToolResult(isError=False, content=[embedded_resource])

    with CustomMCPClient(mock_transport["transport_callable"]) as client:
        result = client.call_tool_sync(tool_use_id="override-test", name="test_tool", arguments={})

    assert result["content"][0]["text"] == "[intercepted]"


@pytest.mark.parametrize(
    "application_name,application_version,expected_name,expected_version_check",
    [
        ("my-fraud-agent", None, "my-fraud-agent", lambda v: v and v != "0.1.0"),
        ("my-agent/v2.1.0 (prod)", None, "my-agent/v2.1.0 (prod)", lambda v: v and v != "0.1.0"),
        ("my-agent", "2.3.1", "my-agent", lambda v: v == "2.3.1"),
    ],
    ids=["name-only-uses-sdk-version", "special-characters", "explicit-version"],
)
def test_mcp_client_client_info_passed(
    mock_transport, mock_session, application_name, application_version, expected_name, expected_version_check
):
    """Test that application_name and application_version are passed through to ClientSession as client_info."""
    with patch("strands.tools.mcp.mcp_client.ClientSession") as mock_client_session:
        mock_session_cm = AsyncMock()
        mock_session_instance = AsyncMock()
        mock_session_instance.initialize = AsyncMock(return_value=MagicMock(instructions=None))
        mock_session_instance.get_server_capabilities = MagicMock(return_value=None)
        mock_session_cm.__aenter__.return_value = mock_session_instance
        mock_client_session.return_value = mock_session_cm

        kwargs = {"application_name": application_name}
        if application_version is not None:
            kwargs["application_version"] = application_version

        with MCPClient(mock_transport["transport_callable"], **kwargs) as _client:
            call_kwargs = mock_client_session.call_args[1]
            assert call_kwargs["client_info"].name == expected_name
            assert expected_version_check(call_kwargs["client_info"].version)


def test_mcp_client_client_name_property(mock_transport):
    """Test that client_name exposes the configured application_name."""
    assert MCPClient(mock_transport["transport_callable"]).client_name is None
    assert MCPClient(mock_transport["transport_callable"], application_name="my-agent").client_name == "my-agent"


@pytest.mark.parametrize(
    "application_name",
    [None, ""],
    ids=["none", "empty-string"],
)
def test_mcp_client_client_info_none_when_no_name(mock_transport, mock_session, application_name):
    """Test that client_info is None when application_name is not provided or empty."""
    with patch("strands.tools.mcp.mcp_client.ClientSession") as mock_client_session:
        mock_session_cm = AsyncMock()
        mock_session_instance = AsyncMock()
        mock_session_instance.initialize = AsyncMock(return_value=MagicMock(instructions=None))
        mock_session_instance.get_server_capabilities = MagicMock(return_value=None)
        mock_session_cm.__aenter__.return_value = mock_session_instance
        mock_client_session.return_value = mock_session_cm

        kwargs = {"application_name": application_name} if application_name is not None else {}

        with MCPClient(mock_transport["transport_callable"], **kwargs) as _client:
            call_kwargs = mock_client_session.call_args[1]
            assert call_kwargs["client_info"] is None

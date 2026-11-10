"""Integration tests for MCP task-augmented tool execution."""

import os
import socket
import threading
import time
from typing import Any

import pytest
from mcp.client.streamable_http import streamablehttp_client

from strands.tools.mcp import MCPClient, MCPTransport, TasksConfig


def _find_available_port() -> int:
    """Find an available port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        s.listen(1)
        return s.getsockname()[1]


def start_task_server(port: int) -> None:
    """Start the task echo server in a thread."""
    import uvicorn

    from tests_integ.mcp.task_echo_server import create_starlette_app

    starlette_app, _ = create_starlette_app(port)
    uvicorn.run(starlette_app, host="127.0.0.1", port=port, log_level="warning")


@pytest.fixture(scope="module")
def task_server_port() -> int:
    return _find_available_port()


@pytest.fixture(scope="module")
def task_server(task_server_port: int) -> Any:
    """Start the task server for the test module."""
    server_thread = threading.Thread(target=start_task_server, kwargs={"port": task_server_port}, daemon=True)
    server_thread.start()
    time.sleep(2)
    yield


@pytest.fixture
def task_mcp_client(task_server: Any, task_server_port: int) -> MCPClient:
    """Create an MCP client with tasks enabled."""

    def transport_callback() -> MCPTransport:
        return streamablehttp_client(url=f"http://127.0.0.1:{task_server_port}/mcp")

    return MCPClient(transport_callback, tasks_config=TasksConfig())


@pytest.fixture
def task_mcp_client_disabled(task_server: Any, task_server_port: int) -> MCPClient:
    """Create an MCP client with tasks disabled (default)."""

    def transport_callback() -> MCPTransport:
        return streamablehttp_client(url=f"http://127.0.0.1:{task_server_port}/mcp")

    return MCPClient(transport_callback)


@pytest.mark.skipif(os.environ.get("GITHUB_ACTIONS") == "true", reason="streamable transport failing in CI")
class TestMCPTaskSupport:
    """Integration tests for MCP task-augmented execution."""

    def test_direct_call_tools(self, task_mcp_client: MCPClient) -> None:
        """Test tools that use direct call_tool (forbidden or no taskSupport)."""
        with task_mcp_client:
            task_mcp_client.list_tools_sync()

            # Tool with taskSupport='forbidden'
            r1 = task_mcp_client.call_tool_sync(
                tool_use_id="t1", name="task_forbidden_echo", arguments={"message": "Hello!"}
            )
            assert r1["status"] == "success"
            assert "Forbidden echo: Hello!" in r1["content"][0].get("text", "")

            # Tool without taskSupport
            r2 = task_mcp_client.call_tool_sync(tool_use_id="t2", name="echo", arguments={"message": "Simple!"})
            assert r2["status"] == "success"
            assert "Simple echo: Simple!" in r2["content"][0].get("text", "")

    def test_task_augmented_tools(self, task_mcp_client: MCPClient) -> None:
        """Test tools that use task-augmented execution (required or optional)."""
        with task_mcp_client:
            task_mcp_client.list_tools_sync()

            # Tool with taskSupport='required'
            r1 = task_mcp_client.call_tool_sync(
                tool_use_id="t1", name="task_required_echo", arguments={"message": "Required!"}
            )
            assert r1["status"] == "success"
            assert "Task echo: Required!" in r1["content"][0].get("text", "")

            # Tool with taskSupport='optional'
            r2 = task_mcp_client.call_tool_sync(
                tool_use_id="t2", name="task_optional_echo", arguments={"message": "Optional!"}
            )
            assert r2["status"] == "success"
            assert "Task optional echo: Optional!" in r2["content"][0].get("text", "")

    def test_task_support_tool_detection(self, task_mcp_client: MCPClient) -> None:
        """Test tool-level task support detection."""
        with task_mcp_client:
            task_mcp_client.list_tools_sync()

            # Verify decision logic
            assert task_mcp_client._should_use_task("task_required_echo") is True
            assert task_mcp_client._should_use_task("task_optional_echo") is True
            assert task_mcp_client._should_use_task("task_forbidden_echo") is False
            assert task_mcp_client._should_use_task("echo") is False

    def test_server_capabilities(self, task_mcp_client: MCPClient) -> None:
        """Test server task capability detection."""
        with task_mcp_client:
            task_mcp_client.list_tools_sync()
            assert task_mcp_client._has_server_task_support() is True

    def test_tasks_disabled_by_default(self, task_mcp_client_disabled: MCPClient) -> None:
        """Test that tasks are disabled when experimental.tasks is not configured."""
        with task_mcp_client_disabled:
            task_mcp_client_disabled.list_tools_sync()

            assert task_mcp_client_disabled._is_tasks_enabled() is False
            assert task_mcp_client_disabled._should_use_task("task_required_echo") is False

            # Direct call_tool still works for tools that support it
            result = task_mcp_client_disabled.call_tool_sync(
                tool_use_id="t", name="task_optional_echo", arguments={"message": "Direct!"}
            )
            assert result["status"] == "success"

            # Task-required tools fail gracefully via direct call
            result2 = task_mcp_client_disabled.call_tool_sync(
                tool_use_id="t2", name="task_required_echo", arguments={"message": "Direct!"}
            )
            assert result2["status"] == "error"

    @pytest.mark.asyncio
    async def test_async_tool_call(self, task_mcp_client: MCPClient) -> None:
        """Test async tool calls."""
        with task_mcp_client:
            task_mcp_client.list_tools_sync()
            result = await task_mcp_client.call_tool_async(
                tool_use_id="t", name="task_forbidden_echo", arguments={"message": "Async!"}
            )
            assert result["status"] == "success"
            assert "Forbidden echo: Async!" in result["content"][0].get("text", "")

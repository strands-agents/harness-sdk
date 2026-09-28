"""Shared fixtures and helpers for MCP client tests."""

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from mcp.types import ErrorData

from strands.tools.mcp import _compat
from strands.tools.mcp._compat import MCPError


def make_mcp_error(code: int, message: str = "", data: Any = None) -> Exception:
    """Construct the installed line's MCP error: 2.x takes (code, message, data), 1.x takes ErrorData."""
    if _compat.MCP_V2:
        return MCPError(code, message, data=data)
    return MCPError(error=ErrorData(code=code, message=message, data=data))


def assert_session_call_tool_once_with(
    mock_session: Any,
    name: str,
    arguments: dict[str, Any] | None,
    read_timeout_seconds: Any = None,
    progress_callback: Any = None,
    meta: Any = None,
) -> None:
    """Assert the exact `session.call_tool` invocation a direct tool call makes on the installed line.

    The 2.x compat shim converts the timeout to float seconds and carries the
    SEP-2322 multi round-trip keywords on every call; 1.x sends the plain form.
    """
    if _compat.MCP_V2:
        mock_session.call_tool.assert_called_once_with(
            name,
            arguments,
            _compat.read_timeout(read_timeout_seconds),
            progress_callback=progress_callback,
            meta=meta,
            input_responses=None,
            request_state=None,
            allow_input_required=True,
        )
        return
    mock_session.call_tool.assert_called_once_with(
        name, arguments, read_timeout_seconds, progress_callback=progress_callback, meta=meta
    )


@pytest.fixture
def mock_transport():
    """Create a mock MCP transport."""
    mock_read_stream = AsyncMock()
    mock_write_stream = AsyncMock()
    mock_transport_cm = AsyncMock()
    mock_transport_cm.__aenter__.return_value = (mock_read_stream, mock_write_stream)
    mock_transport_callable = MagicMock(return_value=mock_transport_cm)

    return {
        "read_stream": mock_read_stream,
        "write_stream": mock_write_stream,
        "transport_cm": mock_transport_cm,
        "transport_callable": mock_transport_callable,
    }


@pytest.fixture
def mock_session():
    """Create a mock MCP session."""
    mock_session = AsyncMock()
    mock_init_result = MagicMock()
    mock_init_result.instructions = None
    mock_session.initialize = AsyncMock(return_value=mock_init_result)
    # The 2.x negotiation reads instructions from the session itself; without an
    # explicit default the AsyncMock would hand back an auto-created attribute.
    mock_session.instructions = None
    # Default: no task support (get_server_capabilities is sync, not async!)
    mock_session.get_server_capabilities = MagicMock(return_value=None)

    # Create a mock context manager for ClientSession
    mock_session_cm = AsyncMock()
    mock_session_cm.__aenter__.return_value = mock_session

    # Patch ClientSession to return our mock session
    with patch("strands.tools.mcp.mcp_client.ClientSession", return_value=mock_session_cm):
        yield mock_session


def create_server_capabilities(has_task_support: bool) -> MagicMock:
    """Create mock server capabilities.

    Args:
        has_task_support: Whether the server should advertise task support.

    Returns:
        MagicMock representing server capabilities.
    """
    caps = MagicMock()
    if has_task_support:
        caps.tasks = MagicMock()
        caps.tasks.requests = MagicMock()
        caps.tasks.requests.tools = MagicMock()
        caps.tasks.requests.tools.call = MagicMock()
    else:
        caps.tasks = None
    return caps

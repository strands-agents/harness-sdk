"""Unit tests for MCPClient ``auto_reconnect``: rebuilding a dropped session around a tool call."""

import asyncio
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from mcp import ListToolsResult
from mcp.types import CallToolResult as MCPCallToolResult
from mcp.types import TextContent as MCPTextContent
from mcp.types import Tool as MCPTool

from strands.tools.mcp import MCPClient, mcp_client
from strands.types.exceptions import MCPClientInitializationError

from .conftest import make_mcp_error

# Fixtures mock_transport and mock_session are imported from conftest.py


def _ok_result(text: str = "ok") -> MCPCallToolResult:
    return MCPCallToolResult(isError=False, content=[MCPTextContent(type="text", text=text)])


def _drop_session(client: MCPClient, error: Exception | None = None) -> None:
    """End the background session the way a dropped transport does, leaving the client un-stopped."""

    async def drop() -> None:
        if error is None:
            client._close_future.set_result(None)
        else:
            client._close_future.set_exception(error)

    asyncio.run_coroutine_threadsafe(drop(), client._background_thread_event_loop).result(timeout=5)
    client._background_thread.join(timeout=5)
    assert not client._is_session_active()


def _call(client: MCPClient, tool_use_id: str = "tu-1"):
    return client.call_tool_sync(tool_use_id=tool_use_id, name="echo", arguments={"to_echo": "hi"})


@pytest.fixture
def backoff_sleeps(monkeypatch) -> list[float]:
    """Record the reconnect backoff delays instead of sleeping through them."""
    sleeps: list[float] = []
    monkeypatch.setattr(mcp_client, "time", SimpleNamespace(sleep=sleeps.append, monotonic=time.monotonic))
    return sleeps


def test_dropped_session_raises_without_auto_reconnect(mock_transport, mock_session):
    """Default behaviour: a call on a dropped session raises and nothing reconnects."""
    client = MCPClient(mock_transport["transport_callable"])
    client.start()
    _drop_session(client, RuntimeError("connection dropped"))

    with pytest.raises(MCPClientInitializationError, match="client session is not running"):
        _call(client)

    assert mock_transport["transport_callable"].call_count == 1
    with pytest.raises(RuntimeError, match="Connection to the MCP server was closed"):
        client.stop(None, None, None)


def test_never_started_client_raises_even_with_auto_reconnect(mock_transport, mock_session):
    """auto_reconnect only rebuilds sessions the caller opened; it does not start a client implicitly."""
    client = MCPClient(mock_transport["transport_callable"], auto_reconnect=True)

    with pytest.raises(MCPClientInitializationError, match="client session is not running"):
        _call(client)

    mock_transport["transport_callable"].assert_not_called()


def test_call_tool_sync_reconnects_when_session_dropped_between_calls(mock_transport, mock_session):
    mock_session.call_tool.return_value = _ok_result()
    client = MCPClient(mock_transport["transport_callable"], auto_reconnect=True)
    client.start()
    _drop_session(client, RuntimeError("connection dropped"))

    result = _call(client)

    assert result["status"] == "success"
    assert client._is_session_active()
    assert mock_transport["transport_callable"].call_count == 2
    mock_session.call_tool.assert_called_once()
    client.stop(None, None, None)


@pytest.mark.asyncio
async def test_call_tool_async_retries_once_after_mid_call_drop(mock_transport, mock_session):
    """A call interrupted by the connection dropping is retried once on the new session."""
    client = MCPClient(mock_transport["transport_callable"], auto_reconnect=True)
    client.start()

    async def drop_then_succeed(*args, **kwargs):
        if mock_session.call_tool.call_count == 1:
            client._close_future.set_exception(RuntimeError("connection dropped"))
            raise RuntimeError("connection dropped")
        return _ok_result("retried")

    mock_session.call_tool.side_effect = drop_then_succeed

    result = await client.call_tool_async(tool_use_id="tu-1", name="echo", arguments={"to_echo": "hi"})

    assert result["status"] == "success"
    assert result["content"] == [{"text": "retried"}]
    assert mock_session.call_tool.call_count == 2
    assert mock_transport["transport_callable"].call_count == 2
    client.stop(None, None, None)


def test_session_terminated_error_triggers_reconnect(mock_transport, mock_session):
    """A live transport whose server forgot the session (404 -> 'Session terminated') is rebuilt."""
    mock_session.call_tool.side_effect = [make_mcp_error(-32600, "Session terminated"), _ok_result("retried")]

    with MCPClient(mock_transport["transport_callable"], auto_reconnect=True) as client:
        result = _call(client)

    assert result["status"] == "success"
    assert mock_session.call_tool.call_count == 2
    assert mock_transport["transport_callable"].call_count == 2


def test_retries_at_most_once(mock_transport, mock_session):
    mock_session.call_tool.side_effect = make_mcp_error(-32600, "Session terminated")

    with MCPClient(mock_transport["transport_callable"], auto_reconnect=True) as client:
        result = _call(client)

    assert result["status"] == "error"
    assert "Session terminated" in result["content"][0]["text"]
    assert mock_session.call_tool.call_count == 2
    assert mock_transport["transport_callable"].call_count == 2


def test_tool_errors_are_not_retried(mock_transport, mock_session):
    """Failures that leave the session healthy surface as before, without a reconnect."""
    mock_session.call_tool.side_effect = Exception("tool blew up")

    with MCPClient(mock_transport["transport_callable"], auto_reconnect=True) as client:
        result = _call(client)

    assert result["status"] == "error"
    assert "tool blew up" in result["content"][0]["text"]
    mock_session.call_tool.assert_called_once()
    assert mock_transport["transport_callable"].call_count == 1


@pytest.mark.asyncio
async def test_failed_reconnect_returns_error_result_and_next_call_tries_again(
    mock_transport, mock_session, backoff_sleeps
):
    mock_session.list_tools.return_value = ListToolsResult(
        tools=[MCPTool(name="echo", description="echo", inputSchema={"type": "object"})]
    )
    mock_session.call_tool.return_value = _ok_result()
    client = MCPClient(mock_transport["transport_callable"], auto_reconnect=True)
    client.add_consumer("agent-1")
    tools = await client.load_tools()
    _drop_session(client)

    transport_cm = mock_transport["transport_cm"]
    transport_cm.__aenter__.side_effect = ConnectionError("server down")
    result = _call(client, "tu-down")

    assert result["status"] == "error"
    assert "server down" in result["content"][0]["text"]
    assert not client._is_session_active()
    mock_session.call_tool.assert_not_called()

    transport_cm.__aenter__.side_effect = None
    result = _call(client, "tu-up")

    assert result["status"] == "success"
    assert client._is_session_active()
    assert mock_transport["transport_callable"].call_count == 1 + mcp_client._RECONNECT_MAX_ATTEMPTS + 1

    # Provider bookkeeping survives the failed attempt, so the last consumer still tears the client down.
    assert client._consumers == {"agent-1"}
    assert await client.load_tools() is tools
    client.remove_consumer("agent-1")
    assert client._background_thread is None


def test_reconnect_backs_off_while_server_is_still_restarting(mock_transport, mock_session, backoff_sleeps):
    """Connection attempts that fail are retried with a doubling delay until the server is back."""
    mock_session.call_tool.return_value = _ok_result()
    client = MCPClient(mock_transport["transport_callable"], auto_reconnect=True)
    client.start()
    _drop_session(client)
    mock_transport["transport_cm"].__aenter__.side_effect = [
        ConnectionError("still restarting"),
        ConnectionError("still restarting"),
        (mock_transport["read_stream"], mock_transport["write_stream"]),
    ]

    result = _call(client)

    assert result["status"] == "success"
    assert backoff_sleeps == [0.5, 1.0]
    assert mock_transport["transport_callable"].call_count == 4
    mock_session.call_tool.assert_called_once()
    client.stop(None, None, None)


def test_reconnect_gives_up_after_max_attempts(mock_transport, mock_session, backoff_sleeps):
    mock_session.call_tool.return_value = _ok_result()
    client = MCPClient(mock_transport["transport_callable"], auto_reconnect=True)
    client.start()
    _drop_session(client)
    mock_transport["transport_cm"].__aenter__.side_effect = ConnectionError("server down")

    result = _call(client)

    assert result["status"] == "error"
    assert "server down" in result["content"][0]["text"]
    assert backoff_sleeps == [0.5, 1.0, 2.0]
    assert mock_transport["transport_callable"].call_count == 1 + mcp_client._RECONNECT_MAX_ATTEMPTS
    assert not client._is_session_active()
    mock_session.call_tool.assert_not_called()


def test_reconnect_does_not_retry_after_startup_timeout(mock_transport, mock_session, backoff_sleeps):
    """An attempt that already waited out startup_timeout is not followed by more attempts."""
    client = MCPClient(mock_transport["transport_callable"], auto_reconnect=True, startup_timeout=0.1)
    client.start()
    _drop_session(client)

    async def hang_then_fail(*args, **kwargs):
        await asyncio.sleep(0.5)
        raise ConnectionError("too late")

    mock_transport["transport_cm"].__aenter__.side_effect = hang_then_fail

    result = _call(client)

    assert result["status"] == "error"
    assert "did not start in 0.1 seconds" in result["content"][0]["text"]
    assert backoff_sleeps == []
    assert mock_transport["transport_callable"].call_count == 2


def test_reconnect_stops_when_startup_timeout_budget_is_spent(mock_transport, mock_session, backoff_sleeps):
    """A slow failure that is not our own timeout still ends the cycle once the next delay would overrun the budget."""
    client = MCPClient(mock_transport["transport_callable"], auto_reconnect=True, startup_timeout=0.4)
    client.start()
    _drop_session(client)

    async def slow_refusal(*args, **kwargs):
        await asyncio.sleep(0.2)
        raise ConnectionError("slow refusal")

    mock_transport["transport_cm"].__aenter__.side_effect = slow_refusal

    result = _call(client)

    assert result["status"] == "error"
    assert "slow refusal" in result["content"][0]["text"]
    assert backoff_sleeps == []
    assert mock_transport["transport_callable"].call_count == 2


def test_callers_queued_behind_a_failed_reconnect_fail_fast(mock_transport, mock_session, backoff_sleeps):
    """Only the first caller sits out the backoff; the rest make a single attempt while the failure is fresh."""
    client = MCPClient(mock_transport["transport_callable"], auto_reconnect=True)
    client.start()
    _drop_session(client)
    mock_transport["transport_cm"].__aenter__.side_effect = ConnectionError("server down")

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda index: _call(client, f"tu-{index}"), range(4)))

    assert all(result["status"] == "error" for result in results)
    assert backoff_sleeps == [0.5, 1.0, 2.0]
    assert mock_transport["transport_callable"].call_count == 1 + mcp_client._RECONNECT_MAX_ATTEMPTS + 3

    # Once the cooldown has passed the next call backs off again.
    client._reconnect_failed_at -= mcp_client._RECONNECT_FAILURE_COOLDOWN_SECONDS
    _call(client, "tu-later")
    assert backoff_sleeps == [0.5, 1.0, 2.0] * 2

    # A successful start (here a manual one) disarms the cooldown.
    mock_transport["transport_cm"].__aenter__.side_effect = None
    client.start()
    assert client._reconnect_failed_at is None
    client.stop(None, None, None)


def test_concurrent_calls_share_one_reconnect(mock_transport, mock_session):
    mock_session.call_tool.return_value = _ok_result()
    client = MCPClient(mock_transport["transport_callable"], auto_reconnect=True)
    client.start()
    _drop_session(client)

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda index: _call(client, f"tu-{index}"), range(8)))

    assert all(result["status"] == "success" for result in results)
    assert mock_transport["transport_callable"].call_count == 2
    assert mock_session.call_tool.call_count == 8
    client.stop(None, None, None)


@pytest.mark.asyncio
async def test_reconnect_preserves_tool_provider_state(mock_transport, mock_session):
    """Consumers and loaded tools survive a reconnect so the provider still cleans up on last removal."""
    mock_session.list_tools.return_value = ListToolsResult(
        tools=[MCPTool(name="echo", description="echo", inputSchema={"type": "object"})]
    )
    mock_session.call_tool.return_value = _ok_result()
    client = MCPClient(mock_transport["transport_callable"], auto_reconnect=True)
    client.add_consumer("agent-1")
    tools = await client.load_tools()
    assert len(tools) == 1

    _drop_session(client, RuntimeError("connection dropped"))
    result = await client.call_tool_async(tool_use_id="tu-1", name="echo", arguments={})

    assert result["status"] == "success"
    assert client._consumers == {"agent-1"}
    assert client._tool_provider_started is True
    assert await client.load_tools() is tools

    client.remove_consumer("agent-1")
    assert client._background_thread is None


def test_stop_during_reconnect_leaves_client_stopped(mock_transport, mock_session):
    """A user stop() that lands while a reconnect is in flight waits for it and tears the new session down."""
    client = MCPClient(mock_transport["transport_callable"], auto_reconnect=True)
    client.start()
    _drop_session(client)
    reconnect_started = threading.Event()
    original_start = client._start

    def slow_start():
        reconnect_started.set()
        time.sleep(0.3)
        return original_start()

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(client, "_start", slow_start)
        reconnect = threading.Thread(target=client._reconnect, args=(None,))
        reconnect.start()
        reconnect_started.wait(timeout=5)
        client.stop(None, None, None)
        reconnect.join(timeout=5)

    assert client._background_thread is None
    assert mock_transport["transport_callable"].call_count == 2


def test_user_stop_is_not_undone_by_reconnect(mock_transport, mock_session):
    """A client stopped on purpose stays stopped: a stale reconnect request raises instead of restarting."""
    client = MCPClient(mock_transport["transport_callable"], auto_reconnect=True)
    client.start()
    session_id = client._session_id
    client.stop(None, None, None)

    with pytest.raises(MCPClientInitializationError):
        client._reconnect(session_id)

    assert mock_transport["transport_callable"].call_count == 1
    assert client._background_thread is None


def test_stop_on_dead_thread_does_not_schedule_close(mock_transport, mock_session):
    client = MCPClient(mock_transport["transport_callable"])
    client.start()
    _drop_session(client)
    loop = client._background_thread_event_loop
    run_threadsafe = MagicMock()

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(asyncio, "run_coroutine_threadsafe", run_threadsafe)
        client.stop(None, None, None)

    run_threadsafe.assert_not_called()
    assert loop.is_closed()


def test_concurrent_session_terminated_failures_share_one_reconnect(mock_transport, mock_session):
    """Calls that all fail on the same live-but-terminated session replace it once, then retry on the new one."""
    first_session_id = None
    barrier = threading.Barrier(4)

    async def terminated_on_first_session(*args, **kwargs):
        if client._session_id == first_session_id:
            await asyncio.to_thread(barrier.wait)
            raise make_mcp_error(-32600, "Session terminated")
        return _ok_result()

    mock_session.call_tool.side_effect = terminated_on_first_session
    client = MCPClient(mock_transport["transport_callable"], auto_reconnect=True)
    client.start()
    first_session_id = client._session_id

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda index: _call(client, f"tu-{index}"), range(4)))

    assert all(result["status"] == "success" for result in results)
    assert mock_transport["transport_callable"].call_count == 2
    assert mock_session.call_tool.call_count == 8
    client.stop(None, None, None)


def test_tool_error_mentioning_session_is_not_treated_as_lost_session(mock_transport, mock_session):
    """Only INVALID_REQUEST carries the transport's session-lost message; a tool's own wording is a tool error."""
    mock_session.call_tool.side_effect = make_mcp_error(-32603, "browser session not found")

    with MCPClient(mock_transport["transport_callable"], auto_reconnect=True) as client:
        result = _call(client)

    assert result["status"] == "error"
    mock_session.call_tool.assert_called_once()
    assert mock_transport["transport_callable"].call_count == 1

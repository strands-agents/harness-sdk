"""Per-call cancellation while an MCP session is reconnecting."""

import asyncio
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from mcp.types import CallToolResult as MCPCallToolResult
from mcp.types import TextContent as MCPTextContent

from strands.tools.mcp import MCPClient, mcp_client

from .conftest import make_mcp_error


@pytest.fixture(params=[False, True], ids=["sync", "async"])
def call_tool(request):
    def call(client, tool_use_id="cancelled", cancel_signal=None):
        kwargs = {"tool_use_id": tool_use_id, "name": "echo", "cancel_signal": cancel_signal}
        if request.param:
            return asyncio.run(client.call_tool_async(**kwargs))
        return client.call_tool_sync(**kwargs)

    return call


@pytest.fixture
def client(mock_transport, mock_session):
    mock_session.call_tool.return_value = MCPCallToolResult(
        isError=False, content=[MCPTextContent(type="text", text="ok")]
    )
    with MCPClient(mock_transport["transport_callable"], auto_reconnect=True) as client:
        yield client


def _drop_session(client):
    async def drop():
        client._close_future.set_result(None)

    asyncio.run_coroutine_threadsafe(drop(), client._background_thread_event_loop).result(timeout=5)
    client._background_thread.join(timeout=5)
    assert not client._is_session_active()


def _cancelled():
    return {
        "status": "error",
        "toolUseId": "cancelled",
        "content": [{"text": "Tool execution cancelled locally; remote execution may have continued"}],
        "cancelled": True,
    }


def _success(tool_use_id):
    return {
        "status": "success",
        "toolUseId": tool_use_id,
        "content": [{"text": "ok"}],
        "isError": False,
    }


def test_call_tool_presignalled_cancellation_skips_reconnect(
    client, call_tool, mock_transport, mock_session, monkeypatch
):
    """A cancelled call never dials a dropped session, and a later caller can recover (#5297)."""
    _drop_session(client)
    cancel_signal = threading.Event()
    cancel_signal.set()
    mock_transport["transport_cm"].__aenter__.side_effect = ConnectionError("server down")
    monkeypatch.setattr(mcp_client, "time", SimpleNamespace(sleep=lambda _: None, monotonic=time.monotonic))

    tru_result = call_tool(client, cancel_signal=cancel_signal)

    exp_result = _cancelled()
    assert tru_result == exp_result
    assert mock_transport["transport_callable"].call_count == 1
    mock_session.call_tool.assert_not_called()

    mock_transport["transport_cm"].__aenter__.side_effect = None
    cancel_signal.clear()
    tru_result = call_tool(client, "later", cancel_signal)
    exp_result = _success("later")
    assert tru_result == exp_result
    assert mock_transport["transport_callable"].call_count == 2


@pytest.mark.parametrize("session_dropped", [False, True], ids=["retry", "initial-reconnect"])
def test_call_tool_cancellation_during_failed_reconnect(
    client, call_tool, mock_transport, mock_session, monkeypatch, session_dropped
):
    """A connect failure cannot mask cancellation or limit the next caller's retries (#5297)."""
    cancel_signal = threading.Event()
    if session_dropped:
        _drop_session(client)
    else:
        mock_session.call_tool.side_effect = make_mcp_error(-32600, "Session terminated")

    async def cancel_during_connect():
        cancel_signal.set()
        raise ConnectionError("server down")

    mock_transport["transport_cm"].__aenter__.side_effect = cancel_during_connect
    delays = []
    monkeypatch.setattr(mcp_client, "time", SimpleNamespace(sleep=delays.append, monotonic=time.monotonic))

    tru_result = call_tool(client, cancel_signal=cancel_signal)

    exp_result = _cancelled()
    assert tru_result == exp_result
    assert mock_transport["transport_callable"].call_count == 2
    assert client._reconnect_failed_at is None
    assert delays == []

    mock_session.call_tool.side_effect = None
    mock_transport["transport_cm"].__aenter__.side_effect = [
        ConnectionError("still restarting"),
        (mock_transport["read_stream"], mock_transport["write_stream"]),
    ]
    tru_result = call_tool(client, "later")
    exp_result = _success("later")
    assert tru_result == exp_result
    assert mock_transport["transport_callable"].call_count == 4
    assert delays == [0.5]


def test_call_tool_cancellation_interrupts_reconnect_backoff(
    client, call_tool, mock_transport, mock_session, monkeypatch
):
    """A caller exits a retry delay as soon as it cancels, leaving later recovery available (#5297)."""
    _drop_session(client)
    cancel_signal = threading.Event()
    backoff_started = threading.Event()
    original_wait = cancel_signal.wait

    def wait_for_cancel(timeout):
        backoff_started.set()
        return original_wait(timeout)

    monkeypatch.setattr(cancel_signal, "wait", wait_for_cancel)
    monkeypatch.setattr(mcp_client, "time", SimpleNamespace(sleep=wait_for_cancel, monotonic=time.monotonic))
    monkeypatch.setattr(mcp_client, "_RECONNECT_INITIAL_DELAY_SECONDS", 10)
    mock_transport["transport_cm"].__aenter__.side_effect = ConnectionError("server down")

    with ThreadPoolExecutor(max_workers=1) as pool:
        cancelled_call = pool.submit(call_tool, client, "cancelled", cancel_signal)
        try:
            assert backoff_started.wait(timeout=5)
            cancel_signal.set()
            tru_result = cancelled_call.result(timeout=1)
        finally:
            cancel_signal.set()

    exp_result = _cancelled()
    assert tru_result == exp_result
    assert mock_transport["transport_callable"].call_count == 2
    assert client._reconnect_failed_at is None
    mock_session.call_tool.assert_not_called()

    mock_transport["transport_cm"].__aenter__.side_effect = None
    tru_result = call_tool(client, "later")
    exp_result = _success("later")
    assert tru_result == exp_result
    assert mock_transport["transport_callable"].call_count == 3


@pytest.mark.parametrize("session_dropped", [False, True], ids=["retry", "initial-reconnect"])
def test_call_tool_cancellation_during_successful_reconnect_preserves_session(
    client, call_tool, mock_transport, mock_session, session_dropped
):
    """A connection completed during cancellation remains reusable without replaying the call (#5297)."""
    cancel_signal = threading.Event()
    if session_dropped:
        _drop_session(client)
    else:
        mock_session.call_tool.side_effect = make_mcp_error(-32600, "Session terminated")

    async def cancel_during_connect():
        cancel_signal.set()
        return mock_transport["read_stream"], mock_transport["write_stream"]

    mock_transport["transport_cm"].__aenter__.side_effect = cancel_during_connect

    tru_result = call_tool(client, cancel_signal=cancel_signal)

    exp_result = _cancelled()
    assert tru_result == exp_result
    assert client._is_session_ready()
    assert not client._session_lost
    assert client._reconnect_failed_at is None
    assert mock_session.call_tool.call_count == (0 if session_dropped else 1)

    mock_session.call_tool.side_effect = None
    tru_result = call_tool(client, "later")
    exp_result = _success("later")
    assert tru_result == exp_result
    assert mock_transport["transport_callable"].call_count == 2


def test_call_tool_cancellation_while_waiting_preserves_other_callers_reconnect(
    client, call_tool, mock_transport, mock_session, monkeypatch
):
    """A cancelled waiter exits while another caller continues its shared reconnect (#5297)."""
    _drop_session(client)
    reconnect_started = threading.Event()
    release_reconnect = threading.Event()
    waiter_started = threading.Event()
    cancel_signal = threading.Event()
    original_reconnect = client._reconnect
    reconnect_calls = 0

    async def wait_during_connect():
        reconnect_started.set()
        while not release_reconnect.is_set():
            await asyncio.sleep(0.01)
        return mock_transport["read_stream"], mock_transport["write_stream"]

    def observe_reconnect(*args, **kwargs):
        nonlocal reconnect_calls
        reconnect_calls += 1
        if reconnect_calls == 2:
            waiter_started.set()
        return original_reconnect(*args, **kwargs)

    mock_transport["transport_cm"].__aenter__.side_effect = wait_during_connect
    monkeypatch.setattr(client, "_reconnect", observe_reconnect)

    with ThreadPoolExecutor(max_workers=2) as pool:
        reconnecting_call = pool.submit(call_tool, client, "other")
        try:
            assert reconnect_started.wait(timeout=5)
            cancelled_call = pool.submit(call_tool, client, "cancelled", cancel_signal)
            assert waiter_started.wait(timeout=5)
            cancel_signal.set()
            tru_result = cancelled_call.result(timeout=1)
            exp_result = _cancelled()
            assert tru_result == exp_result
            assert not reconnecting_call.done()
        finally:
            release_reconnect.set()
        tru_result = reconnecting_call.result(timeout=5)

    exp_result = _success("other")
    assert tru_result == exp_result
    assert mock_transport["transport_callable"].call_count == 2
    mock_session.call_tool.assert_called_once()

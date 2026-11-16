"""Unit tests for MCPClient ``auto_reconnect``: rebuilding a dropped session around a tool call."""

import asyncio
import gc
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


def _success(tool_use_id: str = "tu-1", text: str = "ok") -> dict:
    return {"status": "success", "toolUseId": tool_use_id, "content": [{"text": text}], "isError": False}


def _failure(message: str, tool_use_id: str = "tu-1") -> dict:
    return {"status": "error", "toolUseId": tool_use_id, "content": [{"text": f"Tool execution failed: {message}"}]}


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

    assert result == _success()
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
            raise make_mcp_error(-32000, "Connection closed")
        return _ok_result("retried")

    mock_session.call_tool.side_effect = drop_then_succeed

    result = await client.call_tool_async(tool_use_id="tu-1", name="echo", arguments={"to_echo": "hi"})

    assert result == _success(text="retried")
    assert mock_session.call_tool.call_count == 2
    assert mock_transport["transport_callable"].call_count == 2
    client.stop(None, None, None)


def test_session_terminated_error_triggers_reconnect(mock_transport, mock_session):
    """A live transport whose server forgot the session (404 -> 'Session terminated') is rebuilt."""
    mock_session.call_tool.side_effect = [make_mcp_error(-32600, "Session terminated"), _ok_result("retried")]

    with MCPClient(mock_transport["transport_callable"], auto_reconnect=True) as client:
        result = _call(client)

    assert result == _success(text="retried")
    assert mock_session.call_tool.call_count == 2
    assert mock_transport["transport_callable"].call_count == 2


def test_retries_at_most_once(mock_transport, mock_session):
    mock_session.call_tool.side_effect = make_mcp_error(-32600, "Session terminated")

    with MCPClient(mock_transport["transport_callable"], auto_reconnect=True) as client:
        result = _call(client)

    assert result == _failure("Session terminated")
    assert mock_session.call_tool.call_count == 2
    assert mock_transport["transport_callable"].call_count == 2


def test_tool_errors_are_not_retried(mock_transport, mock_session):
    """Failures that leave the session healthy surface as before, without a reconnect."""
    mock_session.call_tool.side_effect = Exception("tool blew up")

    with MCPClient(mock_transport["transport_callable"], auto_reconnect=True) as client:
        result = _call(client)

    assert result == _failure("tool blew up")
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

    assert result == _success("tu-up")
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

    assert result == _success()
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
    assert "background thread did not start in" in result["content"][0]["text"]
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

    assert results == [_success(f"tu-{index}") for index in range(8)]
    assert mock_transport["transport_callable"].call_count == 2
    assert mock_session.call_tool.call_count == 8
    client.stop(None, None, None)


@pytest.mark.parametrize("call_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("pause_during", ["teardown", "startup"])
def test_call_tool_waits_for_another_callers_reconnect(mock_transport, mock_session, call_async, pause_during):
    """Calls share a rebuild even before its new thread exists (#5297)."""
    mock_session.call_tool.return_value = _ok_result()
    reconnect_paused = threading.Event()
    resume_reconnect = threading.Event()
    second_checked = threading.Event()

    with MCPClient(mock_transport["transport_callable"], auto_reconnect=True) as client:
        _drop_session(client)
        target, name = (mcp_client.uuid, "uuid4") if pause_during == "teardown" else (client, "_start_with_backoff")
        original_step = getattr(target, name)
        original_check = client._check_session_for_tool_call

        def pause_reconnect(*args, **kwargs):
            reconnect_paused.set()
            assert resume_reconnect.wait(timeout=5)
            return original_step(*args, **kwargs)

        def check_second_call():
            try:
                original_check()
            finally:
                second_checked.set()

        def second_call():
            if call_async:
                return asyncio.run(
                    client.call_tool_async(tool_use_id="tu-second", name="echo", arguments={"to_echo": "hi"})
                )
            return _call(client, "tu-second")

        with pytest.MonkeyPatch.context() as monkeypatch:
            monkeypatch.setattr(target, name, pause_reconnect)
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(_call, client, "tu-first")
                try:
                    assert reconnect_paused.wait(timeout=5)
                    monkeypatch.setattr(client, "_check_session_for_tool_call", check_second_call)
                    second = pool.submit(second_call)
                    assert second_checked.wait(timeout=5)
                finally:
                    resume_reconnect.set()
                tru_results = [first.result(timeout=5), second.result(timeout=5)]

    exp_results = [_success("tu-first"), _success("tu-second")]
    assert tru_results == exp_results
    assert mock_transport["transport_callable"].call_count == 2
    assert mock_session.call_tool.call_count == 2


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

    def slow_start(**kwargs):
        reconnect_started.set()
        time.sleep(0.3)
        return original_start(**kwargs)

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
    barrier = threading.Barrier(4, timeout=5)

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

    assert results == [_success(f"tu-{index}") for index in range(4)]
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


def test_in_flight_call_survives_another_callers_reconnect(mock_transport, mock_session, caplog):
    """A call still running when another caller rebuilds the session fails over to the new one instead of hanging."""
    in_flight = threading.Event()

    async def call_tool(name, arguments=None, *args, **kwargs):
        if mock_session.call_tool.call_count == 1:
            in_flight.set()
            await asyncio.sleep(3600)
        if mock_session.call_tool.call_count == 2:
            raise make_mcp_error(-32600, "Session terminated")
        return _ok_result()

    mock_session.call_tool.side_effect = call_tool
    client = MCPClient(mock_transport["transport_callable"], auto_reconnect=True)
    client.start()

    with ThreadPoolExecutor(max_workers=2) as pool:
        slow = pool.submit(_call, client, "tu-slow")
        assert in_flight.wait(5)
        reconnecting = pool.submit(_call, client, "tu-reconnect")
        results = [reconnecting.result(timeout=10), slow.result(timeout=10)]

    assert results == [_success("tu-reconnect"), _success("tu-slow")]
    assert mock_transport["transport_callable"].call_count == 2
    client.stop(None, None, None)
    gc.collect()
    # The old loop finished its tasks before stopping, so none was destroyed while pending.
    assert [record for record in caplog.records if record.name == "asyncio"] == []


@pytest.mark.parametrize("drop_during_submission", [False, True])
def test_call_scheduled_on_a_stopped_loop_fails_instead_of_hanging(
    mock_transport, mock_session, monkeypatch, caplog, drop_during_submission
):
    """A rejected submission releases its coroutine even when shutdown races scheduling (#5297)."""
    client = MCPClient(mock_transport["transport_callable"], auto_reconnect=True)
    client.start()
    loop = client._background_thread_event_loop
    original_submit = loop.call_soon_threadsafe

    def drop_then_submit(*args, **kwargs):
        monkeypatch.setattr(loop, "call_soon_threadsafe", original_submit)
        _drop_session(client)
        return original_submit(*args, **kwargs)

    if drop_during_submission:
        monkeypatch.setattr(loop, "call_soon_threadsafe", drop_then_submit)
    else:
        _drop_session(client)
    coro = asyncio.sleep(0)
    future = client._invoke_on_background_thread(coro)
    with pytest.raises(RuntimeError, match="Connection to the MCP server was closed"):
        future.result(timeout=1)
    loop.run_until_complete(asyncio.sleep(0))
    client.stop(None, None, None)
    assert coro.cr_frame is None
    gc.collect()
    assert [record for record in caplog.records if record.name == "asyncio"] == []


def test_uninitialized_submission_closes_its_coroutine(mock_transport):
    """A missing session cannot leave rejected invocation coroutines unawaited (#5297)."""
    client = MCPClient(mock_transport["transport_callable"])
    coro = asyncio.sleep(0)

    with pytest.raises(MCPClientInitializationError, match="session was not initialized"):
        client._invoke_on_background_thread(coro)

    assert coro.cr_frame is None


def test_stop_after_loop_exit_does_not_leak_shutdown_coroutines(mock_transport, mock_session, monkeypatch, recwarn):
    """Shutdown releases queued work even when the loop finishes before its thread exits (#5297)."""
    client = MCPClient(mock_transport["transport_callable"])
    loop_stopped = threading.Event()
    release_thread = threading.Event()
    joining_thread = threading.Event()
    original_background_task = client._background_task

    def delayed_thread_exit():
        original_background_task()
        loop_stopped.set()
        assert release_thread.wait(timeout=5)

    monkeypatch.setattr(client, "_background_task", delayed_thread_exit)
    client.start()
    original_join = client._background_thread.join

    def observe_join(*args, **kwargs):
        joining_thread.set()
        return original_join(*args, **kwargs)

    monkeypatch.setattr(client._background_thread, "join", observe_join)
    client._background_thread_event_loop.call_soon_threadsafe(client._close_future.set_result, None)
    with ThreadPoolExecutor(max_workers=1) as pool:
        try:
            assert loop_stopped.wait(timeout=5)
            stopped = pool.submit(client.stop, None, None, None)
            assert joining_thread.wait(timeout=5)
        finally:
            release_thread.set()
        stopped.result(timeout=5)
    gc.collect()
    assert [warning for warning in recwarn if "was never awaited" in str(warning.message)] == []


def test_cancelled_submission_closes_its_coroutine_before_the_loop_accepts_it(mock_transport, mock_session):
    """Cancelling a queued call releases its coroutine without dispatching it (#5297)."""
    loop_blocked = threading.Event()
    release_loop = threading.Event()

    def block_loop():
        loop_blocked.set()
        assert release_loop.wait(timeout=5)

    with MCPClient(mock_transport["transport_callable"]) as client:
        loop = client._background_thread_event_loop
        loop.call_soon_threadsafe(block_loop)
        coro = asyncio.sleep(0)
        try:
            assert loop_blocked.wait(timeout=5)
            future = client._invoke_on_background_thread(coro)
            assert future.cancel()
            assert coro.cr_frame is None
        finally:
            release_loop.set()
        asyncio.run_coroutine_threadsafe(asyncio.sleep(0), loop).result(timeout=5)
        assert future.cancelled()


@pytest.mark.parametrize("reject_task", [False, True], ids=["cancelled", "rejected"])
def test_unstarted_wrapper_closes_its_coroutine(mock_transport, mock_session, monkeypatch, reject_task):
    """Cancellation or rejection before the wrapper starts releases the undispatched coroutine (#5297)."""
    with MCPClient(mock_transport["transport_callable"]) as client:
        loop = client._background_thread_event_loop
        original_create_task = loop.create_task
        wrappers = []

        def create_unstarted_wrapper(coro, **kwargs):
            if coro.__name__ == "run_async":
                wrappers.append(coro)
                if reject_task:
                    raise RuntimeError("task factory rejected call")
            task = original_create_task(coro, **kwargs)
            if coro.__name__ == "run_async":
                task.cancel()
            return task

        monkeypatch.setattr(loop, "create_task", create_unstarted_wrapper)
        coro = asyncio.sleep(0)
        future = client._invoke_on_background_thread(coro)
        expected_error = RuntimeError if reject_task else mcp_client.futures.CancelledError
        with pytest.raises(expected_error):
            future.result(timeout=5)
        assert coro.cr_frame is None
        assert len(wrappers) == 1
        assert wrappers[0].cr_frame is None


@pytest.mark.parametrize(
    ("error", "lost"),
    [
        (make_mcp_error(-32000, "Connection closed"), True),
        (make_mcp_error(-32600, "Session terminated"), True),
        (MCPClientInitializationError("the client session was not initialized"), True),
        (make_mcp_error(-32001, "Request timed out"), False),
        (make_mcp_error(-32000, "tool failed"), False),
        (RuntimeError("tool raised"), False),
    ],
)
def test_session_lost_is_decided_by_the_error_not_the_client_state(mock_transport, mock_session, error, lost):
    """While the session is down (e.g. another caller is reconnecting), only connection errors are retried."""
    client = MCPClient(mock_transport["transport_callable"], auto_reconnect=True)
    client.start()
    _drop_session(client)

    assert client._is_session_lost_error(error) is lost
    client.stop(None, None, None)


def test_retry_attempts_share_the_startup_timeout_budget(mock_transport, mock_session, backoff_sleeps):
    """A later attempt only gets what is left of startup_timeout, not a fresh one."""
    client = MCPClient(mock_transport["transport_callable"], auto_reconnect=True, startup_timeout=2)
    client.start()
    _drop_session(client)

    connects = 0

    async def refuse_slowly_once(*args, **kwargs):
        nonlocal connects
        connects += 1
        if connects == 1:
            await asyncio.sleep(0.3)
            raise ConnectionError("still restarting")
        return mock_transport["read_stream"], mock_transport["write_stream"]

    mock_transport["transport_cm"].__aenter__.side_effect = refuse_slowly_once
    timeouts: list[float] = []
    original_start = client._start

    def recording_start(**kwargs):
        timeouts.append(kwargs["timeout"])
        return original_start(**kwargs)

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(client, "_start", recording_start)
        client._reconnect(None)

    assert len(timeouts) == 2
    assert timeouts[1] <= 2 - 0.3
    client.stop(None, None, None)


def _reconnect_in_background(client: MCPClient, mock_transport) -> threading.Thread:
    """Drop the session and start a tool call whose reconnect blocks in connect for about a second."""
    _drop_session(client)
    connecting = threading.Event()
    streams = (mock_transport["read_stream"], mock_transport["write_stream"])

    async def slow_connect(*args, **kwargs):
        connecting.set()
        await asyncio.sleep(1.0)
        return streams

    mock_transport["transport_cm"].__aenter__.side_effect = slow_connect
    call = threading.Thread(target=_call, args=(client,))
    call.start()
    assert connecting.wait(5)
    return call


def _provider_client(mock_transport, mock_session, **kwargs) -> MCPClient:
    mock_session.list_tools.return_value = ListToolsResult(
        tools=[MCPTool(name="echo", description="echo", inputSchema={"type": "object"})]
    )
    mock_session.call_tool.return_value = _ok_result()
    client = MCPClient(mock_transport["transport_callable"], auto_reconnect=True, **kwargs)
    client.add_consumer("agent-1")
    return client


@pytest.mark.asyncio
async def test_load_tools_during_reconnect_keeps_the_tools(mock_transport, mock_session):
    client = _provider_client(mock_transport, mock_session, continue_on_error=True)
    tools = await client.load_tools()
    call = _reconnect_in_background(client, mock_transport)

    assert await client.load_tools() is tools
    call.join(5)
    assert not client.connection_failed
    assert await client.load_tools() is tools
    client.remove_consumer("agent-1")


@pytest.mark.asyncio
async def test_removing_the_last_consumer_during_reconnect_tears_the_client_down(mock_transport, mock_session):
    client = _provider_client(mock_transport, mock_session)
    await client.load_tools()
    call = _reconnect_in_background(client, mock_transport)

    client.remove_consumer("agent-1")
    call.join(5)

    assert client._consumers == set()
    assert client._background_thread is None


def test_call_on_a_closed_loop_is_treated_as_a_lost_session(mock_transport, mock_session):
    """A caller that raced a stop() past the session check gets a retryable error, not 'Event loop is closed'."""
    client = MCPClient(mock_transport["transport_callable"], auto_reconnect=True)
    client.start()
    _drop_session(client)
    client._background_thread_event_loop.close()
    coro = asyncio.sleep(0)

    with pytest.raises(RuntimeError, match="Connection to the MCP server was closed") as raised:
        client._invoke_on_background_thread(coro)

    assert client._is_session_lost_error(raised.value)
    assert coro.cr_frame is None  # closed, so no "never awaited" warning
    client._background_thread_event_loop = None
    client.stop(None, None, None)


def test_stop_from_the_background_thread_fails_instead_of_deadlocking(mock_transport, mock_session):
    """e.g. a GC finalizer on the MCP thread while another thread holds the lock in a reconnect."""
    client = MCPClient(mock_transport["transport_callable"], auto_reconnect=True)
    client.start()

    async def stop_from_loop() -> None:
        client.stop(None, None, None)

    with client._reconnect_lock:
        future = asyncio.run_coroutine_threadsafe(stop_from_loop(), client._background_thread_event_loop)
        with pytest.raises(RuntimeError, match="its own background thread"):
            future.result(timeout=5)
    client.stop(None, None, None)

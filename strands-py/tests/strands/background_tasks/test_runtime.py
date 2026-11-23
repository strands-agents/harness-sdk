import threading

import pytest

from strands.background_tasks._runtime import _BackgroundTaskRuntime


@pytest.mark.asyncio
async def test_call_on_the_runtime_thread_runs_inline() -> None:
    runtime = _BackgroundTaskRuntime()
    threads: list[threading.Thread] = []

    await runtime.run(lambda: runtime.call(lambda: threads.append(threading.current_thread())))

    assert threads == [runtime._thread]


def test_call_stops_waiting_after_the_timeout(caplog: pytest.LogCaptureFixture) -> None:
    runtime = _BackgroundTaskRuntime()
    release = threading.Event()
    ran = threading.Event()
    runtime.call(lambda: None)
    runtime._loop.call_soon_threadsafe(release.wait)

    runtime.call(ran.set, timeout=0.01)

    assert not ran.is_set()
    assert "timeout=<0.01> | background task runtime did not settle in time" in caplog.text
    release.set()
    assert ran.wait(timeout=1)

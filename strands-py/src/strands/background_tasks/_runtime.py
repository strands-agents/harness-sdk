"""Process-lifetime event loop for detached background work."""

from __future__ import annotations

import asyncio
import inspect
import threading
from collections.abc import Awaitable, Callable
from typing import TypeVar, cast

_T = TypeVar("_T")


class _BackgroundTaskRuntime:
    """Own a daemon event loop shared by in-process task managers."""

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._start_lock = threading.Lock()

    async def run(self, operation: Callable[[], _T | Awaitable[_T]]) -> _T:
        """Run an operation on the persistent loop."""
        loop = self._ensure_started()
        if threading.current_thread() is self._thread:
            return await self._invoke(operation)
        future = asyncio.run_coroutine_threadsafe(self._invoke(operation), loop)
        return await asyncio.wrap_future(future)

    def _ensure_started(self) -> asyncio.AbstractEventLoop:
        existing_loop = self._loop
        if existing_loop is not None:
            return existing_loop
        with self._start_lock:
            if self._loop is None:
                self._thread = threading.Thread(
                    target=self._run_loop,
                    name="strands-background-tasks",
                    daemon=True,
                )
                self._thread.start()
                self._ready.wait()
        loop = self._loop
        if loop is None:
            raise RuntimeError("Background task runtime failed to start")
        return loop

    def _run_loop(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        self._ready.set()
        loop.run_forever()

    async def _invoke(self, operation: Callable[[], _T | Awaitable[_T]]) -> _T:
        result = operation()
        if inspect.isawaitable(result):
            return await cast(Awaitable[_T], result)
        return result


_RUNTIME = _BackgroundTaskRuntime()


def get_background_task_runtime() -> _BackgroundTaskRuntime:
    """Return the shared process-lifetime runtime."""
    return _RUNTIME

"""Process-lifetime event loop for detached background work."""

from __future__ import annotations

import asyncio
import concurrent.futures
import inspect
import logging
import threading
from collections.abc import Awaitable, Callable
from typing import TypeVar, cast

_T = TypeVar("_T")

logger = logging.getLogger(__name__)


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

    def call(self, operation: Callable[[], object], *, timeout: float = 5.0) -> None:
        """Run a synchronous operation on the persistent loop and wait for the callbacks it schedules.

        Safe from any thread. On the loop's own thread it runs inline and does not wait. Stops waiting
        after ``timeout`` seconds and logs a warning; the operation still runs when the loop gets to it.
        """
        loop = self._ensure_started()
        if threading.current_thread() is self._thread:
            operation()
            return

        async def settle() -> None:
            operation()
            await asyncio.sleep(0)  # let the task-update notifications it queued run first

        try:
            asyncio.run_coroutine_threadsafe(settle(), loop).result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            logger.warning("timeout=<%s> | background task runtime did not settle in time", timeout)

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

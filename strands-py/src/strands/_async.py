"""Private async execution utilities."""

import asyncio
import contextvars
import threading
from collections.abc import Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from typing import TypeVar

T = TypeVar("T")

_RUN_ASYNC_BRIDGE = contextvars.ContextVar("strands_run_async_bridge", default=False)


def is_run_async_bridge() -> bool:
    """Return whether execution is inside the temporary sync bridge loop."""
    return _RUN_ASYNC_BRIDGE.get()


def run_async(async_func: Callable[[], Awaitable[T]]) -> T:
    """Run an async function in a separate thread to avoid event loop conflicts.

    This utility handles the common pattern of running async code from sync contexts
    by using ThreadPoolExecutor to isolate the async execution.

    Args:
        async_func: A callable that returns an awaitable

    Returns:
        The result of the async function
    """

    async def execute_async() -> T:
        return await async_func()

    def execute() -> T:
        token = _RUN_ASYNC_BRIDGE.set(True)
        try:
            return asyncio.run(execute_async())
        finally:
            _RUN_ASYNC_BRIDGE.reset(token)

    with ThreadPoolExecutor() as executor:
        context = contextvars.copy_context()
        future = executor.submit(context.run, execute)
        return future.result()


# How often a waiter checks a cancellation signal.
_CANCEL_POLL_INTERVAL = 0.05


async def _poll_cancel_signal(cancel_signal: threading.Event) -> None:
    """Complete once the cancellation signal is set."""
    # threading.Event has no async notification hook. Poll on this loop rather than running
    # Event.wait() in an executor: cancelling that await cannot stop a worker already blocked
    # in Event.wait(), so completed streams could strand worker threads.
    while not cancel_signal.is_set():
        await asyncio.sleep(_CANCEL_POLL_INTERVAL)

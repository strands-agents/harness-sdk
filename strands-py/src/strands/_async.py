"""Private async execution utilities."""

import asyncio
import contextvars
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

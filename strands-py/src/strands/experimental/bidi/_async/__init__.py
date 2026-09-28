"""Utilities for async operations."""

from collections.abc import Awaitable, Callable

from ._task_group import _TaskGroup
from ._task_pool import _TaskPool

__all__ = ["_TaskGroup", "_TaskPool"]


async def stop_all(*funcs: Callable[..., Awaitable[None]]) -> None:
    """Call all stops in sequence and aggregate errors.

    A failure in one stop call will not block subsequent stop calls.

    Args:
        funcs: Stop functions to call in sequence.

    Raises:
        RuntimeError: If any stop function raises an exception.
    """
    exceptions = []
    for func in funcs:
        try:
            await func()
        except Exception as exception:
            exceptions.append({"func_name": func.__name__, "exception": repr(exception)})

    if exceptions:
        raise RuntimeError(f"exceptions={exceptions} | failed stop sequence")

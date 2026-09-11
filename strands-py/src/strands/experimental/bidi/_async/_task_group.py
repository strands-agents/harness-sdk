"""Manage a group of async tasks.

This is intended to mimic the behaviors of asyncio.TaskGroup released in Python 3.11.

- Docs: https://docs.python.org/3/library/asyncio-task.html#task-groups
"""

import asyncio
from collections.abc import Coroutine
from typing import Any, cast


class _TaskGroup:
    """Shim of asyncio.TaskGroup for use in Python 3.10.

    Attributes:
        _tasks: Set of tasks in group.
    """

    _tasks: set[asyncio.Task]

    def create_task(self, coro: Coroutine[Any, Any, Any]) -> asyncio.Task:
        """Create an async task and add to group.

        Returns:
            The created task.
        """
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        return task

    async def __aenter__(self) -> "_TaskGroup":
        """Setup self managed task group context."""
        self._tasks = set()
        return self

    async def __aexit__(self, *_: Any) -> None:
        """Execute tasks in group.

        The following execution rules are enforced:
        - The context stops executing all tasks if at least one task raises an Exception or the context is cancelled.
        - The context re-raises Exceptions to the caller.
        - The context re-raises CancelledErrors to the caller only if the context itself was cancelled.
        """
        try:
            pending_tasks = self._tasks
            while pending_tasks:
                done_tasks, pending_tasks = await asyncio.wait(pending_tasks, return_when=asyncio.FIRST_EXCEPTION)

                if any(exception := done_task.exception() for done_task in done_tasks if not done_task.cancelled()):
                    break

            else:  # all tasks completed/cancelled successfully
                return

            for pending_task in pending_tasks:
                pending_task.cancel()

            await asyncio.gather(*pending_tasks, return_exceptions=True)
            raise cast(BaseException, exception)

        except asyncio.CancelledError:  # context itself was cancelled
            for task in self._tasks:
                task.cancel()

            await asyncio.gather(*self._tasks, return_exceptions=True)
            raise

        finally:
            self._tasks = set()

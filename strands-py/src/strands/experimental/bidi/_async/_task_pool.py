"""Manage pool of active async tasks.

This is particularly useful for cancelling multiple tasks at once.
"""

import asyncio
from collections.abc import Coroutine
from typing import Any


class _TaskPool:
    """Manage pool of active async tasks."""

    def __init__(self) -> None:
        """Setup task container."""
        self._tasks: set[asyncio.Task] = set()

    def __len__(self) -> int:
        """Number of active tasks."""
        return len(self._tasks)

    def create(self, coro: Coroutine[Any, Any, Any]) -> asyncio.Task:
        """Create async task.

        Adds a clean up callback to run after task completes.

        Returns:
            The created task.
        """
        task = asyncio.create_task(coro)
        task.add_done_callback(lambda task: self._tasks.remove(task))

        self._tasks.add(task)
        return task

    async def cancel(self) -> None:
        """Cancel all active tasks in pool."""
        for task in self._tasks:
            task.cancel()

        try:
            await asyncio.gather(*self._tasks)
        except asyncio.CancelledError:
            pass

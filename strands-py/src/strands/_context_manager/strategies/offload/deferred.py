"""Deferred block replacement — compute replacements concurrently, apply them at a safe boundary."""

from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import Callable, Coroutine
from typing import Any

from ....agent.conversation_manager.compression.pin_message import is_pinned
from ....types.content import ContentBlock, Messages

logger = logging.getLogger(__name__)

# How often a flush re-checks the cancel signal while waiting on in-flight replacements.
_CANCEL_POLL_INTERVAL = 0.05


class DeferredReplacements:
    """Replace content blocks with results that are computed off the critical path.

    A per-block strategy submits a block together with the coroutine that produces its replacement.
    The block stays in history while the replacement is computed; ``commit`` swaps the finished batch
    in on the agent loop, and ``flush`` waits for it first. A replacement is dropped when its block was
    already replaced or removed, or when its message was pinned in the meantime.

    Work is committed one batch at a time: every submitted replacement must finish before any is
    applied, so a prompt-cache miss is paid once per batch rather than once per block.
    """

    def __init__(self, *, max_pending: int) -> None:
        """Initialize with the maximum number of replacements in flight at once."""
        self._max_pending = max_pending
        self._pending: dict[int, tuple[ContentBlock, asyncio.Task[ContentBlock | None]]] = {}

    def submit(self, block: ContentBlock, compute: Callable[[], Coroutine[Any, Any, ContentBlock | None]]) -> None:
        """Start computing a replacement for ``block``; a no-op if it is already in flight or the batch is full."""
        if id(block) in self._pending or len(self._pending) >= self._max_pending:
            return
        self._pending[id(block)] = (block, asyncio.create_task(compute()))

    def commit(self, messages: Messages) -> bool:
        """Swap the finished batch into ``messages``. Returns True if any block changed."""
        if not self._pending or any(not task.done() for _, task in self._pending.values()):
            return False
        pending, self._pending = self._pending, {}
        acted = False
        for block, task in pending.values():
            replacement = _result(task)
            location = _locate(messages, block)
            if replacement is None or location is None:
                continue
            message_index, block_index = location
            if is_pinned(messages, message_index):
                continue
            messages[message_index]["content"][block_index] = replacement
            acted = True
        return acted

    async def flush(self, messages: Messages, cancel_signal: threading.Event) -> bool:
        """Wait for the batch and commit it, or drop it if the invocation is cancelled first."""
        tasks = {task for _, task in self._pending.values()}
        while tasks and not cancel_signal.is_set():
            _, tasks = await asyncio.wait(tasks, timeout=_CANCEL_POLL_INTERVAL)
        if tasks:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            self._pending.clear()
            return False
        return self.commit(messages)


def _result(task: asyncio.Task[ContentBlock | None]) -> ContentBlock | None:
    if task.cancelled():
        return None
    try:
        return task.result()
    except Exception:
        logger.warning("deferred replacement failed", exc_info=True)
        return None


def _locate(messages: Messages, block: ContentBlock) -> tuple[int, int] | None:
    """Return the (message index, block index) of the block object, or None if it left history."""
    locations = (
        (message_index, block_index)
        for message_index, message in enumerate(messages)
        for block_index, candidate in enumerate(message["content"])
        if candidate is block
    )
    return next(locations, None)

"""Deferred block replacement — compute replacements concurrently, apply them at a safe boundary."""

from __future__ import annotations

import asyncio
import logging
import math
import threading
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from ....agent.conversation_manager.compression.pin_message import is_pinned
from ....background_tasks.in_process._task_engine import TaskEngine
from ....background_tasks.in_process._task_types import (
    TaskCancelSignal,
    TaskExecutionContext,
    TaskOutcome,
    TaskRecord,
    TaskStatus,
)
from ....types.content import ContentBlock, Messages

logger = logging.getLogger(__name__)

# How often a flush re-checks the agent's cancel signal while waiting on in-flight replacements.
_CANCEL_POLL_INTERVAL = 0.05
# Consecutive failed batches after which replacements stop being attempted.
_FAILURES_BEFORE_BACKOFF = 3
# While backed off, one strategy pass in this many retries a replacement as a probe.
_BACKOFF_PROBE_INTERVAL = 5


@dataclass(frozen=True)
class DeferredOptions:
    """Configuration for deferred block replacement."""

    max_concurrency: int = 10
    task_timeout: float = 60.0
    flush_timeout: float = 30.0


@dataclass(frozen=True)
class _Replacement:
    """The engine input for one deferred replacement."""

    # The block object as it sits in history; a different object at commit time means it was replaced.
    block: ContentBlock
    compute: Callable[[], Awaitable[ContentBlock | None]]


_ReplacementRecord = TaskRecord[_Replacement, "ContentBlock | None"]


class DeferredReplacements:
    """Replace content blocks with results that are computed off the critical path.

    A per-block strategy submits a block together with the coroutine that produces its replacement.
    The block stays in history while the replacement is computed; ``commit`` swaps the finished batch
    in on the agent loop, and ``flush`` waits for it first. A replacement is dropped when its block was
    already replaced or removed, or when its message was pinned in the meantime, so a late result can
    never overwrite a newer edit.

    Work is committed one batch at a time: every submitted replacement must finish before any is
    applied, so a prompt-cache miss is paid once per batch rather than once per block. ``flush`` runs at
    every invocation boundary and either commits or drops the batch, so nothing is pending between
    invocations and the next user turn always starts from a consistent history.

    Failure never blocks the agent: a replacement that errors or times out leaves its block untouched
    and eligible for a later pass. A batch dropped at the invocation boundary is detached from history
    and cannot mutate a later user turn; the engine is rotated so a provider that suppresses cancellation
    cannot consume capacity needed by later batches. After ``_FAILURES_BEFORE_BACKOFF`` consecutive
    failed batches, submissions are skipped except for a periodic probe, so a broken summarizer is not
    called on every pass.
    """

    def __init__(self, options: DeferredOptions) -> None:
        """Initialize the component.

        Args:
            options: Concurrency and deadline policy for deferred work.

        Raises:
            TypeError: If ``flush_timeout`` is not a positive finite number.
        """
        if (
            isinstance(options.flush_timeout, bool)
            or not isinstance(options.flush_timeout, (int, float))
            or not math.isfinite(options.flush_timeout)
            or options.flush_timeout <= 0
        ):
            raise TypeError(f"flush_timeout must be a positive finite number, got {options.flush_timeout!r}")
        self._options = options
        self._flush_timeout = float(options.flush_timeout)
        self._engine = self._new_engine()
        self._max_pending = options.max_concurrency
        self._consecutive_failures = 0
        self._skipped_while_backed_off = 0

    def submit(self, block: ContentBlock, compute: Callable[[], Awaitable[ContentBlock | None]]) -> None:
        """Start computing a replacement for ``block``.

        A no-op if the block is already in flight, the batch is full, or replacements are backed off.
        """
        records = self._engine.list()
        if any(record["input"].block is block for record in records) or len(records) >= self._max_pending:
            return
        if self._consecutive_failures >= _FAILURES_BEFORE_BACKOFF and records:
            return
        if self._backed_off():
            return
        self._engine.submit(_Replacement(block=block, compute=compute))

    def commit(self, messages: Messages) -> bool:
        """Swap the finished batch into ``messages``. Returns True if any block changed."""
        records = self._engine.list()
        if not records or any(not _is_task_status_terminal(record["status"]) for record in records):
            return False
        self._engine_remove(records)
        self._track_failures(records)

        acted = False
        for record in records:
            replacement = record.get("result")
            location = _locate(messages, record["input"].block)
            if replacement is None or location is None:
                continue
            message_index, block_index = location
            if is_pinned(messages, message_index):
                continue
            messages[message_index]["content"][block_index] = replacement
            acted = True
        return acted

    async def flush(self, messages: Messages, cancel_signal: threading.Event) -> bool:
        """Wait for the batch and commit it, or drop it if the invocation is cancelled or the deadline passes."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._flush_timeout
        idle_signal = TaskCancelSignal()
        waiter = asyncio.ensure_future(self._engine.wait_for_idle(cancel_signal=idle_signal))
        try:
            while not waiter.done():
                if cancel_signal.is_set() or loop.time() >= deadline:
                    cancelled = cancel_signal.is_set()
                    self._drop(
                        "invocation cancelled" if cancelled else "flush deadline passed",
                        count_failure=not cancelled,
                    )
                    return False
                await asyncio.wait({waiter}, timeout=_CANCEL_POLL_INTERVAL)
        finally:
            idle_signal.abort()
            await asyncio.gather(waiter, return_exceptions=True)
        return self.commit(messages)

    def _drop(self, reason: str, *, count_failure: bool) -> None:
        """Cancel and forget the batch, replacing the engine so non-cooperative work cannot consume future capacity."""
        engine = self._engine
        records = engine.list()
        for record in records:
            engine.cancel(record["task_id"], reason=reason)
        self._engine = self._new_engine()
        if count_failure and records:
            self._consecutive_failures += 1
        logger.debug("count=<%s>, reason=<%s> | deferred replacements dropped", len(records), reason)

    def _new_engine(self) -> TaskEngine[_Replacement, ContentBlock | None]:
        return TaskEngine(
            max_concurrency=self._options.max_concurrency,
            timeout=self._options.task_timeout,
            execute=_execute,
            on_task_updated=lambda _: None,
        )

    def _engine_remove(self, records: list[_ReplacementRecord]) -> None:
        for record in records:
            self._engine.remove(record["task_id"])

    def _track_failures(self, records: list[_ReplacementRecord]) -> None:
        if any(record["status"] == "completed" and record.get("result") is not None for record in records):
            self._consecutive_failures = 0
            self._skipped_while_backed_off = 0
            return
        self._consecutive_failures += 1
        for record in records:
            if record["status"] == "failed":
                failure = record["failure"]
                logger.warning(
                    "type=<%s>, message=<%s> | deferred replacement failed", failure["type"], failure["message"]
                )

    def _backed_off(self) -> bool:
        if self._consecutive_failures < _FAILURES_BEFORE_BACKOFF:
            return False
        self._skipped_while_backed_off += 1
        return self._skipped_while_backed_off % _BACKOFF_PROBE_INTERVAL != 0


async def _execute(
    context: TaskExecutionContext[_Replacement],
) -> TaskOutcome[ContentBlock | None]:
    """Run one replacement, abandoning it as soon as the engine times it out or cancels it.

    A model call has no way to observe the engine's cancel signal, so the compute is raced against it
    rather than relying on cooperation.
    """
    loop = asyncio.get_running_loop()
    aborted: asyncio.Future[None] = loop.create_future()

    def wake_aborted() -> None:
        if not aborted.done():
            aborted.set_result(None)

    def on_abort() -> None:
        loop.call_soon_threadsafe(wake_aborted)

    compute = asyncio.ensure_future(context.input.compute())
    context.cancel_signal.add_abort_callback(on_abort)
    try:
        racers: set[asyncio.Future[Any]] = {compute, aborted}
        await asyncio.wait(racers, return_when=asyncio.FIRST_COMPLETED)
        if compute.done():
            return {"status": "completed", "result": compute.result()}
        compute.cancel()
        await asyncio.gather(compute, return_exceptions=True)
        return {
            "status": "failed",
            "failure": {"type": "execution_error", "message": str(context.cancel_signal.reason)},
        }
    finally:
        context.cancel_signal.remove_abort_callback(on_abort)
        if not aborted.done():
            aborted.cancel()


def _is_task_status_terminal(status: TaskStatus) -> bool:
    return status in {"completed", "failed", "cancelled"}


def _locate(messages: Messages, block: ContentBlock) -> tuple[int, int] | None:
    """Return the (message index, block index) of the block object, or None if it left history."""
    locations = (
        (message_index, block_index)
        for message_index, message in enumerate(messages)
        for block_index, candidate in enumerate(message["content"])
        if candidate is block
    )
    return next(locations, None)

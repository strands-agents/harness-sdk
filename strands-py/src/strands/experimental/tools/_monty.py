"""Shared Monty (https://pydantic.dev/docs/monty/) sandbox primitives for experimental tools.

Each call runs code inside a Monty worker subprocess with no filesystem,
network, or environment access.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
from collections.abc import Awaitable
from typing import Any, Literal

try:
    from pydantic_monty import (
        AsyncMonty,
        CollectStreams,
        MontyError,
        MontyRuntimeError,
        MontySyntaxError,
        MontyTypingError,
        ResourceLimits,
    )
except ImportError as error:
    raise ImportError(
        "This feature requires the 'python-repl' extra (pydantic-monty). "
        "Install with: pip install 'strands-agents[python-repl]'"
    ) from error

# Re-export monty so other tools can import from here and get the custom import error
__all__ = [
    "CollectStreams",
    "MontyError",
    "ResourceLimits",
    "build_error_message",
    "run_session",
]

logger = logging.getLogger(__name__)

_CANCEL_POLL_INTERVAL = 0.05

# Monty error types whose .display() produces a richer traceback than str().
_ERRORS_WITH_DISPLAY = (MontyRuntimeError, MontySyntaxError, MontyTypingError)


async def run_session(
    code: str,
    *,
    state: bytes | None = None,
    cancel_signal: threading.Event | None = None,
    timeout: float | None = None,
    monty_kwargs: dict[str, Any] | None = None,
    checkout_kwargs: dict[str, Any] | None = None,
    feed_kwargs: dict[str, Any] | None = None,
) -> bytes:
    """Execute *code* in a Monty sandbox and return the session dump.

    Raises:
        MontyError: Guest code failed.
        asyncio.CancelledError: *cancel_signal* fired.
        asyncio.TimeoutError: *timeout* elapsed.
    """
    return await _await_bounded(
        _run_session(
            code,
            state=state,
            monty_kwargs=monty_kwargs,
            checkout_kwargs=checkout_kwargs,
            feed_kwargs=feed_kwargs,
        ),
        cancel_signal,
        timeout=timeout,
    )


def build_error_message(
    error: Exception, output: list[tuple[Literal["stdout", "stderr"], str]], max_output_chars: int
) -> str:
    """Format a ``MontyError`` with any captured stdout for display to the model."""
    message = str(error.display()) if isinstance(error, _ERRORS_WITH_DISPLAY) else str(error)
    sections = [message]
    stdout = "".join(text for _, text in output)
    if stdout:
        if len(stdout) > max_output_chars:
            stdout = stdout[:max_output_chars] + "\n\n[output truncated]"
        sections.append(f"--- stdout before failure ---\n{stdout}")
    return "\n\n".join(sections)


async def _run_session(
    code: str,
    *,
    state: bytes | None = None,
    monty_kwargs: dict[str, Any] | None = None,
    checkout_kwargs: dict[str, Any] | None = None,
    feed_kwargs: dict[str, Any] | None = None,
) -> bytes:
    if monty_kwargs is None:
        monty_kwargs = {}
    if checkout_kwargs is None:
        checkout_kwargs = {}
    if feed_kwargs is None:
        feed_kwargs = {}

    async with AsyncMonty(**monty_kwargs) as pool:
        # Load the state and run a session
        if state is not None:
            async with pool.checkout(**checkout_kwargs) as session:
                try:
                    await session.load_session(state)
                except MontyError as error:
                    logger.warning("error=<%s> | discarding unrestorable interpreter state", error)
                else:
                    await session.feed_run(code, **feed_kwargs)
                    return await session.dump()

        # No prior state or restore failed — run in a fresh empty session
        async with pool.checkout(**checkout_kwargs) as session:
            await session.feed_run(code, **feed_kwargs)
            return await session.dump()


async def _await_bounded(
    coro: Awaitable[bytes],
    cancel_signal: threading.Event | None,
    *,
    timeout: float | None = None,
) -> bytes:
    task = asyncio.ensure_future(coro)
    watch = asyncio.ensure_future(_poll_cancel(cancel_signal)) if cancel_signal is not None else None
    waiters = {task} | ({watch} if watch is not None else set())
    try:
        done, _ = await asyncio.wait(waiters, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        if task in done:
            return task.result()
        # Cancel signal fired. Drain the task before raising so it doesn't leak
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        if watch is not None and watch in done:
            raise asyncio.CancelledError
        raise asyncio.TimeoutError
    finally:
        # Drain any task that didn't finish naturally
        for pending in (task, watch):
            if pending is not None and not pending.done():
                pending.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await pending


async def _poll_cancel(cancel_signal: threading.Event) -> None:
    while not cancel_signal.is_set():
        await asyncio.sleep(_CANCEL_POLL_INTERVAL)

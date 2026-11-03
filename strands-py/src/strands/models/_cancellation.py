"""Await a ``threading.Event`` cancellation signal from asyncio code."""

import asyncio
import threading

# How often a waiter checks a cancellation signal.
_CANCEL_POLL_INTERVAL = 0.05


async def _poll_cancel_signal(cancel_signal: threading.Event) -> None:
    """Complete once the cancellation signal is set."""
    # threading.Event has no async notification hook. Poll on this loop rather than running
    # Event.wait() in an executor: cancelling that await cannot stop a worker already blocked
    # in Event.wait(), so completed streams could strand worker threads.
    while not cancel_signal.is_set():
        await asyncio.sleep(_CANCEL_POLL_INTERVAL)

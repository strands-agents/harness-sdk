"""Thread-safe in-memory inbox for messages sent to a running agent."""

import asyncio
import threading
from collections import deque

from ..types.content import Message


class _AgentInbox:
    """Queue user messages and wake waiters on any event loop."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._messages: deque[Message] = deque()
        self._waiters: set[asyncio.Future[None]] = set()

    def put(self, message: Message) -> None:
        """Enqueue a message and notify active waiters."""
        with self._lock:
            self._messages.append(message)
            waiters = tuple(self._waiters)

        for waiter in waiters:
            try:
                waiter.get_loop().call_soon_threadsafe(self._wake, waiter)
            except RuntimeError:
                # A waiter may be removed while its event loop is closing.
                pass

    def snapshot(self) -> tuple[Message, ...]:
        """Read pending messages without claiming them before delivery."""
        with self._lock:
            return tuple(self._messages)

    def remove_snapshot(self, messages: tuple[Message, ...]) -> None:
        """Remove messages after their continuation entered agent history."""
        with self._lock:
            for message in messages:
                if not self._messages or self._messages[0] is not message:
                    break
                self._messages.popleft()

    def has_messages(self) -> bool:
        """Report whether at least one message awaits delivery."""
        with self._lock:
            return bool(self._messages)

    def clear(self) -> None:
        """Discard undelivered messages when agent state is restored."""
        with self._lock:
            self._messages.clear()

    async def wait(self) -> None:
        """Wait until at least one message is queued."""
        loop = asyncio.get_running_loop()
        waiter: asyncio.Future[None] = loop.create_future()
        with self._lock:
            if self._messages:
                return
            self._waiters.add(waiter)
        try:
            await waiter
        finally:
            with self._lock:
                self._waiters.discard(waiter)

    @staticmethod
    def _wake(waiter: asyncio.Future[None]) -> None:
        if not waiter.done():
            waiter.set_result(None)

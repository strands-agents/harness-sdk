"""Rolling lookback of live input audio for replay across a connection restart.

Audio delivered to a connection that is then replaced, before the provider committed it as a user turn,
never reaches the new connection. ``_InputReplayBuffer`` keeps the most recent uncommitted audio so the
loop can resend it once the new connection is up.
"""

from collections import deque

from ..types.content import BidiContentDelta

# Window measured on arrival time: live input arrives in real time, so it approximates audio duration
# without depending on the stream's sample rate or encoding.
_DEFAULT_WINDOW_S = 2.5
_DEFAULT_MAX_BYTES = 1024 * 1024


class _InputReplayBuffer:
    """Holds recently sent audio deltas until the provider commits them as a user turn."""

    def __init__(self, window_s: float = _DEFAULT_WINDOW_S, max_bytes: int = _DEFAULT_MAX_BYTES) -> None:
        """Initialize the buffer.

        Args:
            window_s: How far back, in seconds of arrival time, audio is retained.
            max_bytes: Upper bound on retained audio; the oldest deltas are dropped first.
        """
        self._window_s = window_s
        self._max_bytes = max_bytes
        self._deltas: deque[tuple[float, int, BidiContentDelta]] = deque()
        self._size = 0

    def append(self, delta: BidiContentDelta, now: float) -> None:
        """Retain a delta sent at ``now``."""
        size = len(delta.source.get("bytes", b""))
        self._deltas.append((now, size, delta))
        self._size += size
        while self._size > self._max_bytes and self._deltas:
            self._drop_oldest()

    def clear(self) -> None:
        """Forget all retained audio, e.g. once the provider commits the user turn."""
        self._deltas.clear()
        self._size = 0

    def snapshot(self, now: float) -> list[BidiContentDelta]:
        """Return the retained deltas that arrived within the window before ``now``, oldest first."""
        cutoff = now - self._window_s
        while self._deltas and self._deltas[0][0] < cutoff:
            self._drop_oldest()
        return [delta for _, _, delta in self._deltas]

    def _drop_oldest(self) -> None:
        _, size, _ = self._deltas.popleft()
        self._size -= size

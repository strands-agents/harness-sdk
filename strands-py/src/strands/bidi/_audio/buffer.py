"""Audio buffering for bidirectional device I/O."""

import logging
import queue

logger = logging.getLogger(__name__)


class AudioBuffer:
    """Buffer chunks of audio data between agent and PyAudio."""

    _buffer: queue.Queue[bytes]
    _data: bytearray

    def __init__(self, size: int | None = None):
        """Initialize buffer settings.

        Args:
            size: Size of the buffer (default: unbounded).
        """
        self._size = size or 0

    def start(self) -> None:
        """Setup buffer."""
        self._buffer = queue.Queue(self._size)
        self._data = bytearray()

    def stop(self) -> None:
        """Tear down buffer."""
        if hasattr(self, "_data"):
            self._data.clear()
        if hasattr(self, "_buffer"):
            # Unblock waited get calls by putting an empty chunk.
            # Note, Queue.shutdown exists but is a 3.13+ only feature; we simulate shutdown with the below
            # logic. A full queue already has data available to unblock a consumer, so no sentinel is needed.
            try:
                self._buffer.put_nowait(b"")
            except queue.Full:
                pass
            self._buffer = queue.Queue(self._size)

    def put(self, chunk: bytes) -> None:
        """Put data chunk into buffer.

        If full, removes the oldest chunk.
        """
        if self._buffer.full():
            logger.debug("buffer is full | removing oldest chunk")
            try:
                self._buffer.get_nowait()
            except queue.Empty:
                logger.debug("buffer already empty")
                pass

        self._buffer.put_nowait(chunk)

    def get(self, byte_count: int | None = None) -> bytes:
        """Get the number of bytes specified from the buffer.

        Args:
            byte_count: Number of bytes to get from buffer.

                - If the number of bytes specified is not available, the return is padded with silence.
                - If the number of bytes is not specified, get the first chunk put in the buffer.

        Returns:
            Specified number of bytes.
        """
        if not byte_count:
            self._data.extend(self._buffer.get())
            byte_count = len(self._data)

        while len(self._data) < byte_count:
            try:
                self._data.extend(self._buffer.get_nowait())
            except queue.Empty:
                break

        padding_bytes = b"\x00" * max(byte_count - len(self._data), 0)
        self._data.extend(padding_bytes)

        data = self._data[:byte_count]
        del self._data[:byte_count]

        return bytes(data)

    def clear(self) -> None:
        """Clear the buffer."""
        self._data.clear()
        while True:
            try:
                self._buffer.get_nowait()
            except queue.Empty:
                break

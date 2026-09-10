"""Microphone audio processing for bidirectional streaming.

Provides echo cancellation, noise suppression, and automatic gain control through pywebrtc-audio. Echo
cancellation uses played audio as a reference and resamples it when playback and capture rates differ.

Install with ``pip install strands-agents[bidi-aec]``.
"""

import logging
import queue

import numpy as np
import numpy.typing as npt
from pywebrtc_audio import AudioProcessor

logger = logging.getLogger(__name__)


class _BidiAudioProcessor:
    """Coordinate WebRTC microphone processing with playback reference audio.

    Buffers played audio for echo cancellation and processes microphone audio with aligned playback frames.

    The native processor is not thread-safe. Capture processing must remain serialized.
    """

    @staticmethod
    def frames_per_buffer(rate: int) -> int:
        """Return the frame count required for a 10 ms echo-cancellation interval.

        Echo cancellation pairs capture and playback audio in 10 ms frames, so both callbacks use one interval
        at their respective sample rates.
        """
        return rate // 100

    @property
    def echo_cancellation_enabled(self) -> bool:
        """Whether echo cancellation is enabled."""
        return self._echo_cancellation

    def __init__(
        self,
        *,
        echo_cancellation: bool,
        stream_delay_ms: int,
        far_buffer_size: int | None,
    ) -> None:
        """Initialize processing settings and playback buffering.

        Args:
            echo_cancellation: Whether to remove far-end playback audio from microphone input.
            stream_delay_ms: Playback-to-capture delay hint in milliseconds.
            far_buffer_size: Maximum number of 10 ms playback frames retained for echo cancellation.
        """
        self._echo_cancellation = echo_cancellation
        self._stream_delay_ms = stream_delay_ms
        self._far_buffer_size = far_buffer_size
        self._far_buffer: queue.Queue[bytes] | None = None

    def start(self, *, input_rate: int, output_rate: int, num_channels: int) -> None:
        """Initialize the native processor for an audio session.

        Args:
            input_rate: Microphone sample rate in Hz.
                Must be supported by pywebrtc-audio.
            output_rate: Speaker sample rate in Hz.
                Reference audio is resampled to input_rate when the rates differ.
            num_channels: Number of audio channels.

        Raises:
            ValueError: If the audio format is invalid.
        """
        self._input_rate = input_rate
        self._output_rate = output_rate
        self._processor = AudioProcessor(
            sample_rate=input_rate,
            num_channels=num_channels,
            echo_cancellation=self._echo_cancellation,
            noise_suppression=True,
            auto_gain_control=True,
            stream_delay_ms=self._stream_delay_ms,
        )
        self._far_buffer = queue.Queue[bytes](self._far_buffer_size or 0) if self._echo_cancellation else None
        logger.debug(
            "input_rate=<%d>, output_rate=<%d>, channels=<%d> | audio processor initialized",
            input_rate,
            output_rate,
            num_channels,
        )

    def add_far_data(self, data: bytes) -> None:
        """Add a played audio frame for echo cancellation."""
        if self._far_buffer is None:
            return

        if self._far_buffer.full():
            logger.debug("far buffer is full | removing oldest frame")
            try:
                self._far_buffer.get_nowait()
            except queue.Empty:
                pass

        self._far_buffer.put_nowait(data)

    def _get_far_data(self) -> bytes | None:
        """Take the next played audio frame without blocking."""
        if self._far_buffer is None:
            return None

        try:
            return self._far_buffer.get_nowait()
        except queue.Empty:
            return b""

    def clear_far_data(self) -> None:
        """Discard buffered playback frames."""
        if self._far_buffer is None:
            return

        while True:
            try:
                self._far_buffer.get_nowait()
            except queue.Empty:
                break

    def process(self, near_data: bytes) -> bytes:
        """Process captured mic audio: noise suppression, gain control, and echo cancellation if enabled.

        Args:
            near_data: PCM int16 microphone audio.

        Returns:
            Cleaned PCM int16 audio of the same length. Empty input is returned unchanged because the WebRTC
            processor rejects empty frames.
        """
        if not near_data:
            return near_data

        near = np.frombuffer(near_data, dtype=np.int16)
        far_data = self._get_far_data()
        far = None
        if far_data is not None:
            far = np.frombuffer(far_data, dtype=np.int16)
            far = self._resample(far)
            if len(far) < len(near):
                far = np.pad(far, (0, len(near) - len(far)))
            far = far[: len(near)].astype(np.int16)

        cleaned: npt.NDArray[np.int16] = self._processor.process(near, far)
        return cleaned.astype(np.int16).tobytes()

    def _resample(self, samples: npt.NDArray[np.int16]) -> npt.NDArray[np.int16]:
        """Resample speaker audio to the input rate via linear interpolation.

        Returns samples unchanged when rates match.
        """
        if self._output_rate == self._input_rate:
            return samples

        if len(samples) == 0:
            return samples

        ratio = self._input_rate / self._output_rate
        new_length = max(int(round(len(samples) * ratio)), 1)
        positions = np.linspace(0, len(samples) - 1, new_length)
        resampled = np.interp(positions, np.arange(len(samples)), samples.astype(np.float32))
        result: npt.NDArray[np.int16] = resampled.astype(np.int16)
        return result

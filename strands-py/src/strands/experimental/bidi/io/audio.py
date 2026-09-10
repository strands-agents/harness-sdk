"""Send and receive audio data from devices.

Reads user audio from input device and sends agent audio to output device using PyAudio. If a user interrupts the agent,
the output buffer is cleared to stop playback.

Audio configuration is provided by models that implement ``AudioCapable``.

Optional microphone audio processing (acoustic echo cancellation, noise suppression, and automatic gain
control) is enabled by passing ``audio_processor=True`` or a ``BidiAudioProcessorConfig`` to ``BidiAudioIO``. It
requires pywebrtc-audio (pip install strands-agents[bidi-aec]).
"""

import asyncio
import base64
import logging
import queue
from typing import TYPE_CHECKING, Any, TypedDict

import pyaudio
from typing_extensions import Unpack

from ..models.model import AudioCapable
from ..types.events import (
    BidiAudioInputEvent,
    BidiAudioStreamEvent,
    BidiInterruptionEvent,
    BidiOutputEvent,
)
from ..types.io import BidiInput, BidiOutput

if TYPE_CHECKING:
    from .._audio import _BidiAudioProcessor
    from ..agent.agent import BidiAgent

logger = logging.getLogger(__name__)


class BidiAudioProcessorConfig(TypedDict, total=False):
    """Configure microphone audio processing.

    Attributes:
        echo_cancellation: Cancel the agent's own speaker audio from the mic input.
        stream_delay_ms: Playback-to-capture delay hint in milliseconds for AEC.
            A value of 0 lets AEC3 auto-estimate the delay. Only set a non-zero value if echo cancellation is
            measurably failing on hardware with large or fixed playback-to-capture latency, such as Bluetooth.
    """

    echo_cancellation: bool
    stream_delay_ms: int


class BidiAudioIOConfig(TypedDict, total=False):
    """Configure bidirectional audio input and output."""

    audio_processor: BidiAudioProcessorConfig | bool | None
    input_buffer_size: int | None
    input_device_index: int | None
    input_frames_per_buffer: int
    output_buffer_size: int | None
    output_device_index: int | None
    output_frames_per_buffer: int


class _BidiAudioBuffer:
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


class _BidiAudioInput(BidiInput):
    """Handle audio input from user.

    Attributes:
        _audio: PyAudio instance for audio system access.
        _stream: Audio input stream.
        _buffer: Buffer for sharing audio data between agent and PyAudio.
    """

    _audio: pyaudio.PyAudio
    _stream: pyaudio.Stream

    _BUFFER_SIZE = None
    _DEVICE_INDEX = None
    _FRAMES_PER_BUFFER = 512

    def __init__(
        self,
        config: BidiAudioIOConfig,
        *,
        audio_processor: "_BidiAudioProcessor | None",
    ) -> None:
        """Initialize input settings.

        Args:
            config: Audio device configuration.
            audio_processor: Shared microphone audio processor.
        """
        self._buffer_size = config.get("input_buffer_size", _BidiAudioInput._BUFFER_SIZE)
        self._device_index = config.get("input_device_index", _BidiAudioInput._DEVICE_INDEX)
        self._frames_per_buffer = config.get("input_frames_per_buffer", _BidiAudioInput._FRAMES_PER_BUFFER)

        self._audio_processor = audio_processor
        self._buffer = _BidiAudioBuffer(self._buffer_size)

    async def start(self, agent: "BidiAgent") -> None:
        """Start input stream.

        Args:
            agent: The BidiAgent instance, providing access to model configuration.

        Raises:
            ValueError: If audio processing is enabled but the input rate is unsupported.
        """
        logger.debug("starting audio input stream")

        if not isinstance(agent.model, AudioCapable):
            raise TypeError("BidiAudioIO requires a model that implements AudioCapable")

        audio_config = agent.model.get_audio_config()
        self._channels = audio_config["channels"]
        self._format = audio_config["format"]
        self._rate = audio_config["input_rate"]

        if self._audio_processor is not None:
            self._audio_processor.start(
                input_rate=self._rate,
                output_rate=audio_config["output_rate"],
                num_channels=self._channels,
            )
            if self._audio_processor.echo_cancellation_enabled:
                self._frames_per_buffer = self._audio_processor.frames_per_buffer(self._rate)

        self._buffer.start()
        self._audio = pyaudio.PyAudio()
        self._stream = self._audio.open(
            channels=self._channels,
            format=pyaudio.paInt16,
            frames_per_buffer=self._frames_per_buffer,
            input=True,
            input_device_index=self._device_index,
            rate=self._rate,
            stream_callback=self._callback,
        )

        logger.debug("audio input stream started")

    async def stop(self) -> None:
        """Stop input stream."""
        logger.debug("stopping audio input stream")

        if hasattr(self, "_stream"):
            self._stream.close()
        if hasattr(self, "_audio"):
            self._audio.terminate()
        if hasattr(self, "_buffer"):
            self._buffer.stop()

        logger.debug("audio input stream stopped")

    async def __call__(self) -> BidiAudioInputEvent:
        """Read audio from input stream, applying echo cancellation if enabled."""
        data = await asyncio.to_thread(self._buffer.get)

        if self._audio_processor is not None:
            data = await asyncio.to_thread(self._audio_processor.process, data)

        return BidiAudioInputEvent(
            audio=base64.b64encode(data).decode("utf-8"),
            channels=self._channels,
            format=self._format,
            sample_rate=self._rate,
        )

    def _callback(
        self,
        in_data: bytes | None,
        *_: Any,
    ) -> tuple[None, int]:
        """Callback to receive audio data from PyAudio."""
        self._buffer.put(in_data or b"")
        return (None, pyaudio.paContinue)


class _BidiAudioOutput(BidiOutput):
    """Handle audio output from bidi agent.

    Attributes:
        _audio: PyAudio instance for audio system access.
        _stream: Audio output stream.
        _buffer: Buffer for sharing audio data between agent and PyAudio.
    """

    _audio: pyaudio.PyAudio
    _stream: pyaudio.Stream

    _BUFFER_SIZE = None
    _DEVICE_INDEX = None
    _FRAMES_PER_BUFFER = 512

    def __init__(
        self,
        config: BidiAudioIOConfig,
        *,
        audio_processor: "_BidiAudioProcessor | None",
    ) -> None:
        """Initialize output settings.

        Args:
            config: Audio device configuration.
            audio_processor: Shared audio processor that receives played audio for echo cancellation.
        """
        self._buffer_size = config.get("output_buffer_size", _BidiAudioOutput._BUFFER_SIZE)
        self._device_index = config.get("output_device_index", _BidiAudioOutput._DEVICE_INDEX)
        self._frames_per_buffer = config.get("output_frames_per_buffer", _BidiAudioOutput._FRAMES_PER_BUFFER)

        self._audio_processor = audio_processor
        self._buffer = _BidiAudioBuffer(self._buffer_size)

    async def start(self, agent: "BidiAgent") -> None:
        """Start output stream.

        Args:
            agent: The BidiAgent instance, providing access to model configuration.
        """
        logger.debug("starting audio output stream")

        if not isinstance(agent.model, AudioCapable):
            raise TypeError("BidiAudioIO requires a model that implements AudioCapable")

        audio_config = agent.model.get_audio_config()
        self._channels = audio_config["channels"]
        self._rate = audio_config["output_rate"]

        if self._audio_processor is not None:
            self._frames_per_buffer = self._audio_processor.frames_per_buffer(self._rate)

        self._buffer.start()
        self._audio = pyaudio.PyAudio()
        self._stream = self._audio.open(
            channels=self._channels,
            format=pyaudio.paInt16,
            frames_per_buffer=self._frames_per_buffer,
            output=True,
            output_device_index=self._device_index,
            rate=self._rate,
            stream_callback=self._callback,
        )

        logger.debug("audio output stream started")

    async def stop(self) -> None:
        """Stop output stream."""
        logger.debug("stopping audio output stream")

        if hasattr(self, "_stream"):
            self._stream.close()
        if hasattr(self, "_audio"):
            self._audio.terminate()
        if hasattr(self, "_buffer"):
            self._buffer.stop()

        logger.debug("audio output stream stopped")

    async def __call__(self, event: BidiOutputEvent) -> None:
        """Send audio to output stream."""
        if isinstance(event, BidiAudioStreamEvent):
            data = base64.b64decode(event["audio"])
            self._buffer.put(data)
            logger.debug("audio_bytes=<%d> | audio chunk buffered for playback", len(data))

        elif isinstance(event, BidiInterruptionEvent):
            logger.debug("reason=<%s> | clearing audio buffer due to interruption", event["reason"])
            self._buffer.clear()
            if self._audio_processor is not None:
                self._audio_processor.clear_far_data()

    def _callback(
        self,
        _in_data: bytes | None,
        frame_count: int,
        *_: Any,
    ) -> tuple[bytes, int]:
        """Callback to send audio data to PyAudio.

        When echo cancellation is enabled, records played audio as the reference at the moment it exits the
        speaker — the correct temporal alignment point for echo cancellation.
        """
        byte_count = frame_count * pyaudio.get_sample_size(pyaudio.paInt16)
        data = self._buffer.get(byte_count)

        if self._audio_processor is not None:
            self._audio_processor.add_far_data(data)

        return (data, pyaudio.paContinue)


class BidiAudioIO:
    """Send and receive audio data from devices using PyAudio.

    Reads microphone audio via ``input()`` and plays agent audio via ``output()``. On interruption, the
    playback buffer is cleared to stop the agent mid-response.

    When ``audio_processor=True`` or a ``BidiAudioProcessorConfig`` is passed, the microphone signal gets audio
    processing and, when echo cancellation is enabled, the agent's speaker output is used as a reference to
    cancel echo from the mic input. A shared processor coordinates the input and output channels, so echo
    cancellation only works when both come from the *same* ``BidiAudioIO`` instance.

    Audio processing requires pywebrtc-audio (``pip install strands-agents[bidi-aec]``) and a microphone
    sample rate of 16000, 32000, or 48000 Hz (set via the model's audio config).

    Device audio requires PyAudio. Install the PortAudio system library, then install
    ``strands-agents[bidi-pyaudio]``.

    Example:
        ```python
        from strands.experimental.bidi import BidiAudioProcessorConfig
        from strands.experimental.bidi.io import BidiAudioIO

        # Plain mic/speaker, no processing (a headset is recommended to avoid echo):
        audio_io = BidiAudioIO()
        await agent.run(inputs=[audio_io.input()], outputs=[audio_io.output()])

        # Full processing with defaults: echo cancellation, noise suppression, and auto gain control:
        audio_io = BidiAudioIO(audio_processor=True)
        await agent.run(inputs=[audio_io.input()], outputs=[audio_io.output()])

        # Noise suppression and auto gain control without echo cancellation (e.g. headset users):
        audio_io = BidiAudioIO(audio_processor=BidiAudioProcessorConfig(echo_cancellation=False))
        await agent.run(inputs=[audio_io.input()], outputs=[audio_io.output()])

        # Processing on a specific input device:
        audio_io = BidiAudioIO(audio_processor=BidiAudioProcessorConfig(), input_device_index=1)
        await agent.run(inputs=[audio_io.input()], outputs=[audio_io.output()])
        ```
    """

    _audio_processor: "_BidiAudioProcessor | None"
    _audio_processor_config: BidiAudioProcessorConfig | None

    def __init__(self, **config: Unpack[BidiAudioIOConfig]) -> None:
        """Initialize audio devices.

        Args:
            **config: Optional configuration:

                - audio_processor (bool | BidiAudioProcessorConfig): Set to True to enable microphone audio processing
                  with defaults, or supply a configuration for custom options. False and None disable processing.
                - input_buffer_size (int): Maximum input buffer size (default: None). Must be between 1 and 100
                  when echo cancellation is on; defaults to 100 so the mic and reference buffers remain aligned.
                - input_device_index (int): Specific input device (default: None = system default)
                - input_frames_per_buffer (int): Input buffer size (default: 512). Must not be provided when echo
                  cancellation is on because it is calculated from the model's input rate.
                - output_buffer_size (int): Maximum output buffer size (default: None)
                - output_device_index (int): Specific output device (default: None = system default)
                - output_frames_per_buffer (int): Output buffer size (default: 512). Must not be provided when
                  echo cancellation is on because it is calculated from the model's output rate.

        Raises:
            ImportError: If audio processing is configured but its optional dependencies are unavailable.
            ValueError: If the configuration is invalid.
        """
        self._config = config
        audio_processor_config = self._config.get("audio_processor")
        if isinstance(audio_processor_config, dict):
            self._audio_processor_config = BidiAudioProcessorConfig(**audio_processor_config)
        else:
            self._audio_processor_config = BidiAudioProcessorConfig() if audio_processor_config else None
        self._config["audio_processor"] = self._audio_processor_config

        self._validate_config_echo_cancellation()
        self._validate_config_buffer_size()
        self._validate_config_frames_per_buffer()

        self._import_audio_processor()

    def _import_audio_processor(self) -> None:
        """Import and initialize the optional audio processor implementation."""
        if self._audio_processor_config is None:
            self._audio_processor = None
            return

        try:
            from .._audio import _BidiAudioProcessor
        except ImportError as error:
            raise ImportError(
                f"{error}. Audio processing requires this optional dependency. "
                "Install it with: pip install 'strands-agents[bidi-aec]'."
            ) from error

        self._audio_processor = _BidiAudioProcessor(
            echo_cancellation=self._audio_processor_config["echo_cancellation"],
            stream_delay_ms=self._audio_processor_config["stream_delay_ms"],
            far_buffer_size=self._config.get("input_buffer_size"),
        )

    def _validate_config_echo_cancellation(self) -> None:
        """Validate and normalize echo cancellation configuration."""
        if self._audio_processor_config is None:
            return

        echo_cancellation = self._audio_processor_config.get("echo_cancellation", True)
        stream_delay_ms = self._audio_processor_config.get("stream_delay_ms", 0)
        if not 0 <= stream_delay_ms <= 1000:
            raise ValueError(f"stream_delay_ms=<{stream_delay_ms}> | must be between 0 and 1000")
        if not echo_cancellation and stream_delay_ms:
            raise ValueError("echo_cancellation=<False> | stream_delay_ms requires echo cancellation")

        self._audio_processor_config["echo_cancellation"] = echo_cancellation
        self._audio_processor_config["stream_delay_ms"] = stream_delay_ms

    def _validate_config_buffer_size(self) -> None:
        """Validate the configured input buffer size for echo cancellation."""
        if self._audio_processor_config is None or not self._audio_processor_config["echo_cancellation"]:
            return

        size = self._config.get("input_buffer_size")
        if size is not None and not 1 <= size <= 100:
            raise ValueError(f"input_buffer_size=<{size}> | must be between 1 and 100")
        self._config["input_buffer_size"] = size or 100

    def _validate_config_frames_per_buffer(self) -> None:
        """Reject frame sizes that are calculated automatically for echo cancellation."""
        if self._audio_processor_config is None or not self._audio_processor_config["echo_cancellation"]:
            return

        configured_fields = [
            field for field in ("input_frames_per_buffer", "output_frames_per_buffer") if field in self._config
        ]
        if configured_fields:
            fields = ", ".join(configured_fields)
            raise ValueError(
                f"{fields} cannot be provided when echo cancellation is enabled; "
                "frames per buffer are calculated automatically"
            )

    def input(self) -> _BidiAudioInput:
        """Return audio processing BidiInput."""
        return _BidiAudioInput(
            self._config,
            audio_processor=self._audio_processor,
        )

    def output(self) -> _BidiAudioOutput:
        """Return audio processing BidiOutput."""
        return _BidiAudioOutput(
            self._config,
            audio_processor=(
                self._audio_processor
                if self._audio_processor and self._audio_processor.echo_cancellation_enabled
                else None
            ),
        )

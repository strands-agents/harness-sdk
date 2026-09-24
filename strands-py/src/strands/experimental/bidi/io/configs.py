"""Configuration types for bidirectional I/O."""

from typing import TypedDict


class AudioProcessorConfig(TypedDict, total=False):
    """Configure microphone audio processing.

    Attributes:
        echo_cancellation: Cancel the agent's own speaker audio from the mic input.
        stream_delay_ms: Playback-to-capture delay hint in milliseconds for AEC.
    """

    echo_cancellation: bool
    stream_delay_ms: int


class AudioIOConfig(TypedDict, total=False):
    """Configure bidirectional audio input and output."""

    audio_processor: AudioProcessorConfig | bool | None
    input_buffer_size: int | None
    input_device_index: int | None
    input_frames_per_buffer: int
    output_buffer_size: int | None
    output_device_index: int | None
    output_frames_per_buffer: int


__all__ = ["AudioIOConfig", "AudioProcessorConfig"]

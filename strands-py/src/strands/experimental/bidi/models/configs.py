"""Configuration types and helpers for bidirectional model providers."""

import copy
from collections.abc import Mapping
from typing import Any, TypedDict

from ....models._validation import validate_config_keys
from ..types.events import AudioChannel, AudioFormat, AudioSampleRate

__all__ = ["AudioConfig", "BidiConnectionConfig", "BidiModelConfig"]


class AudioConfig(TypedDict, total=False):
    """Audio configuration for bidirectional streaming models.

    Defines common audio parameters supported by bidirectional model providers.
    All fields are optional to support models that only need specific parameters.

    Model providers build this configuration by merging user-provided values
    with their own defaults. Audio I/O implementations use the stream settings
    to configure hardware, while model providers apply settings such as voice.

    Attributes:
        input_rate: Input sample rate in Hz (e.g., 8000, 16000, 24000, 48000)
        output_rate: Output sample rate in Hz (e.g., 8000, 16000, 24000, 48000)
        channels: Number of audio channels (1=mono, 2=stereo)
        format: Audio encoding format
        voice: Voice used for model audio output.
    """

    input_rate: AudioSampleRate
    output_rate: AudioSampleRate
    channels: AudioChannel
    format: AudioFormat
    voice: str


class BidiConnectionConfig(TypedDict, total=False):
    """Declared reconnect timing for a bidirectional model.

    Providers declare this so the agent loop can reconnect proactively, before the provider
    terminates the connection on its own limit. A provider that declares nothing (empty config)
    keeps reactive-only behavior: no proactive timer, reconnect only after the provider reports
    a timeout.

    All fields are optional. The proactive timer arms only when ``restart_after_s`` is declared.

    Attributes:
        restart_after_s: Seconds after a connection is established at which to proactively
            reconnect. Set it at least ~10s below the provider's own connection limit:
            the reconnect may wait briefly for the current turn to finish (aligning the swap to a
            turn boundary), and that wait plus the swap must complete before the provider's limit.
        auto_reconnect: Whether the loop reconnects automatically (default True).
    """

    restart_after_s: int
    auto_reconnect: bool


class BidiModelConfig(TypedDict, total=False):
    """Configuration shared by bidirectional model providers.

    Attributes:
        model_id: Provider model identifier.
        params: Provider-specific keyword arguments passed to the model request or session.
        connection: Reconnect timing overrides.
    """

    model_id: str
    params: dict[str, Any] | None
    connection: BidiConnectionConfig


def _validate_bidi_config(config: Mapping[str, Any]) -> None:
    """Validate shared bidirectional model configuration."""
    validate_config_keys(config, BidiModelConfig)
    validate_config_keys(config.get("connection", {}), BidiConnectionConfig)


def _validate_audio_config(config: Mapping[str, Any] | None) -> None:
    """Validate shared audio configuration."""
    validate_config_keys(config or {}, AudioConfig)


def _merge_config(config: dict[str, Any], overrides: dict[str, Any]) -> dict[str, Any]:
    """Recursively merge configs without modifying either input."""
    merged = copy.deepcopy(config)
    for key, value in overrides.items():
        if isinstance(value, dict):
            existing = merged.get(key)
            merged[key] = _merge_config(existing if isinstance(existing, dict) else {}, value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged

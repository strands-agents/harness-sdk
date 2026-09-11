"""Configuration types and helpers for bidirectional model providers."""

import copy
from collections.abc import Mapping
from typing import Any, TypedDict

from ....models._validation import validate_config_keys
from ..types.events import AudioChannel, AudioFormat

__all__ = ["AudioConfig", "AudioStreamConfig", "BidiConnectionConfig", "BidiModelConfig"]


class AudioStreamConfig(TypedDict):
    """Resolved format of an audio stream.

    Attributes:
        sample_rate: Sample rate in Hz.
        channels: Number of audio channels.
        format: Audio encoding.
    """

    sample_rate: int
    channels: AudioChannel
    format: AudioFormat


class AudioConfig(TypedDict):
    """Resolved input and output formats consumed by audio I/O.

    Pass provider-specific audio options to the model constructor and use
    ``get_audio_config()`` to obtain the resulting stream formats.

    Attributes:
        input: Audio format configured for model input.
        output: Audio format produced by the model.
    """

    input: AudioStreamConfig
    output: AudioStreamConfig


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


def _validate_model_config(config: Mapping[str, Any]) -> None:
    """Validate shared bidirectional model configuration."""
    validate_config_keys(config, BidiModelConfig)
    validate_config_keys(config.get("connection", {}), BidiConnectionConfig)


def _validate_audio_config(config: AudioConfig) -> None:
    """Validate shared audio configuration."""
    validate_config_keys(config, AudioConfig)
    validate_config_keys(config["input"], AudioStreamConfig)
    validate_config_keys(config["output"], AudioStreamConfig)


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

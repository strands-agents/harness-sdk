"""Bidirectional model interfaces and implementations."""

from typing import Any

from .configs import (
    AudioConfig,
    AudioStreamConfig,
    BedrockNovaSonicAudioConfig,
    BedrockNovaSonicAudioStreamConfig,
    ConnectionConfig,
    GoogleGeminiLiveAudioConfig,
    GoogleGeminiLiveAudioStreamConfig,
    ModelConfig,
)
from .model import AudioCapable, BidiModel, ConnectionTimeoutError, Restartable

__all__ = [
    "AudioCapable",
    "AudioConfig",
    "AudioStreamConfig",
    "BedrockNovaSonicAudioConfig",
    "BedrockNovaSonicAudioStreamConfig",
    "BidiModel",
    "ConnectionConfig",
    "ConnectionTimeoutError",
    "GoogleGeminiLiveAudioConfig",
    "GoogleGeminiLiveAudioStreamConfig",
    "ModelConfig",
    "Restartable",
]


def __getattr__(name: str) -> Any:
    """Lazy load bidi model implementations only when accessed.

    This defers the import of optional dependencies until actually needed.
    """
    if name == "BedrockNovaSonicModel":
        from .bedrock import BedrockNovaSonicModel

        return BedrockNovaSonicModel
    if name == "GoogleGeminiLiveModel":
        from .google import GoogleGeminiLiveModel

        return GoogleGeminiLiveModel
    if name == "OpenAIRealtimeModel":
        from .openai import OpenAIRealtimeModel

        return OpenAIRealtimeModel
    raise AttributeError(f"cannot import name '{name}' from '{__name__}' ({__file__})")

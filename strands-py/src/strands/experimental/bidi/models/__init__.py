"""Bidirectional model interfaces and implementations."""

from typing import Any

from .configs import AudioConfig, BidiConnectionConfig, BidiModelConfig
from .model import AudioCapable, BidiModel, BidiModelTimeoutError, Restartable

__all__ = [
    "AudioCapable",
    "AudioConfig",
    "BidiConnectionConfig",
    "BidiModel",
    "BidiModelConfig",
    "BidiModelTimeoutError",
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

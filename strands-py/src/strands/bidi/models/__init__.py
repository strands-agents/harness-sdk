"""Bidirectional model interfaces and implementations."""

from typing import TYPE_CHECKING, Any

from .configs import (
    AudioConfig,
    AudioStreamConfig,
    BedrockNovaSonicAudioConfig,
    BedrockNovaSonicAudioStreamConfig,
    ConnectionConfig,
    GoogleGeminiLiveAudioConfig,
    GoogleGeminiLiveAudioStreamConfig,
    ModelConfig,
    ModelUpdateConfig,
)
from .model import AudioCapable, BidiModel, ConnectionTimeoutError, Restartable
from .openai.configs import OpenAILiveAudioConfig, OpenAILiveResponsesDelegationConfig

if TYPE_CHECKING:
    from .bedrock import BedrockNovaSonicModel as BedrockNovaSonicModel
    from .google import GoogleGeminiLiveModel as GoogleGeminiLiveModel
    from .openai.live import OpenAILiveModel as OpenAILiveModel
    from .openai.realtime import OpenAIRealtimeModel as OpenAIRealtimeModel

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
    "ModelUpdateConfig",
    "OpenAILiveAudioConfig",
    "OpenAILiveResponsesDelegationConfig",
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
        from .openai.realtime import OpenAIRealtimeModel

        return OpenAIRealtimeModel
    if name == "OpenAILiveModel":
        from .openai.live import OpenAILiveModel

        return OpenAILiveModel
    raise AttributeError(f"cannot import name '{name}' from '{__name__}' ({__file__})")

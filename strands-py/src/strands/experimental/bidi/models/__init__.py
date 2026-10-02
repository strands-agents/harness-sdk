"""Deprecated alias for :mod:`strands.bidi.models`."""

from typing import TYPE_CHECKING, Any

from strands.bidi import models as _real
from strands.bidi.models import (
    AudioCapable,
    AudioConfig,
    AudioStreamConfig,
    BedrockNovaSonicAudioConfig,
    BedrockNovaSonicAudioStreamConfig,
    BidiModel,
    ConnectionConfig,
    ConnectionTimeoutError,
    GoogleGeminiLiveAudioConfig,
    GoogleGeminiLiveAudioStreamConfig,
    ModelConfig,
    ModelUpdateConfig,
    Restartable,
)

if TYPE_CHECKING:
    from strands.bidi.models import BedrockNovaSonicModel as BedrockNovaSonicModel
    from strands.bidi.models import GoogleGeminiLiveModel as GoogleGeminiLiveModel
    from strands.bidi.models import OpenAIRealtimeModel as OpenAIRealtimeModel

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
    "Restartable",
]


def __getattr__(name: str) -> Any:
    """Forward attribute access to :mod:`strands.bidi.models`."""
    return getattr(_real, name)

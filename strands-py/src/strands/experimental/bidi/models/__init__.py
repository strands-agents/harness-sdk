"""Deprecated alias for :mod:`strands.bidi.models`, plus experimental bidi model providers."""

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
    from strands.experimental.bidi.models.openai_live import ConnectionClosedError as ConnectionClosedError
    from strands.experimental.bidi.models.openai_live import OpenAILiveModel as OpenAILiveModel

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
    """Forward attribute access to :mod:`strands.bidi.models`, except for experimental providers defined here."""
    if name in ("ConnectionClosedError", "OpenAILiveModel"):
        from . import openai_live

        return getattr(openai_live, name)
    return getattr(_real, name)

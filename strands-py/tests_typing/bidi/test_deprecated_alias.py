"""Typing compatibility for the deprecated bidirectional streaming namespace."""

from typing_extensions import assert_type

from strands.bidi import BidiAgent as StableBidiAgent
from strands.bidi.io import AudioIO as StableAudioIO
from strands.bidi.models import OpenAIRealtimeModel as StableOpenAIRealtimeModel
from strands.bidi.types import BidiMessage as StableBidiMessage
from strands.experimental.bidi import BidiAgent as DeprecatedBidiAgent
from strands.experimental.bidi.io import AudioIO as DeprecatedAudioIO
from strands.experimental.bidi.models import OpenAIRealtimeModel as DeprecatedOpenAIRealtimeModel
from strands.experimental.bidi.types import BidiMessage as DeprecatedBidiMessage


def deprecated_imports_keep_stable_types(
    agent: DeprecatedBidiAgent,
    audio_io: DeprecatedAudioIO,
    model: DeprecatedOpenAIRealtimeModel,
    message: DeprecatedBidiMessage,
) -> None:
    assert_type(agent, StableBidiAgent)
    assert_type(audio_io, StableAudioIO)
    assert_type(model, StableOpenAIRealtimeModel)
    assert_type(message, StableBidiMessage)

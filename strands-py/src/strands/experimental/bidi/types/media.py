"""Media input types for bidirectional streaming."""

from dataclasses import dataclass

from typing_extensions import TypedDict

from ....types.media import AudioContent, AudioFormat, AudioSource


class _AudioDeltaData(TypedDict):
    audio_delta: AudioContent


@dataclass
class AudioDelta:
    """Audio samples to append to the live input stream.

    Sending a delta does not explicitly end the user's turn.

    Attributes:
        format: Audio format.
        source: Source containing the audio samples.
    """

    format: AudioFormat
    source: AudioSource

    def to_dict(self) -> _AudioDeltaData:
        """Return the dictionary form of this delta."""
        return {"audio_delta": {"format": self.format, "source": self.source}}

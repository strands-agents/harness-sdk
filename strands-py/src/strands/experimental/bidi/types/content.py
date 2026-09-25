"""Content-related type definitions for bidirectional streaming."""

from typing import Literal, TypeAlias

from typing_extensions import TypedDict

from ....types.content import TextBlock, _TextBlockData
from ....types.media import ImageBlock, _ImageBlockData
from .media import AudioDelta, _AudioDeltaData

BidiContentBlock: TypeAlias = TextBlock | ImageBlock
"""A complete text or image block."""

BidiContentDelta: TypeAlias = AudioDelta
"""An audio delta for the live input stream."""

BidiContentBlockData: TypeAlias = _TextBlockData | _ImageBlockData
"""Dictionary form of one text or image block."""

BidiContentDeltaData: TypeAlias = _AudioDeltaData
"""Dictionary form of an audio delta."""


class BidiTranscriptMetadata(TypedDict):
    """Transcript metadata stored under a message's metadata.custom.bidi.

    Attributes:
        kind: Identifies the message as a transcript.
        status: Whether the transcript is pending, complete, or incomplete.
    """

    kind: Literal["transcript"]
    status: Literal["pending", "complete", "incomplete"]


class BidiToolMetadata(TypedDict):
    """Tool-result metadata stored under a message's metadata.custom.bidi.

    Attributes:
        kind: Whether the message records dispatch or the completed result.
        tool_use_id: Original provider tool-use ID.
    """

    kind: Literal["tool_dispatch", "tool_result"]
    tool_use_id: str

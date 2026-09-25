"""Content-related type definitions for bidirectional streaming."""

from dataclasses import dataclass
from typing import Literal, TypeAlias

from typing_extensions import TypedDict

from ....types.content import TextBlock, _TextBlockData
from ....types.media import ImageBlock, _ImageBlockData
from ....types.tools import ToolResultBlock, _ToolResultBlockData
from .media import AudioDelta, _AudioDeltaData

BidiContentBlock: TypeAlias = TextBlock | ImageBlock | ToolResultBlock
"""A complete text, image, or tool result block."""

BidiContentDelta: TypeAlias = AudioDelta
"""An audio delta for the live input stream."""

BidiContentBlockData: TypeAlias = _TextBlockData | _ImageBlockData | _ToolResultBlockData
"""Dictionary form of one text, image, or tool result block."""

BidiContentDeltaData: TypeAlias = _AudioDeltaData
"""Dictionary form of an audio delta."""


@dataclass
class BidiMessage:
    """A complete input message containing ordered content blocks.

    A message contains either user text and images or tool results. Tool results
    cannot be mixed with user content. Send streaming deltas individually.

    Attributes:
        content: Non-empty list of complete content blocks.
    """

    content: list[BidiContentBlock]


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

"""Content-related type definitions for bidirectional streaming."""

from dataclasses import dataclass
from typing import Literal, TypeAlias

from typing_extensions import TypedDict

from ....types.content import TextBlock, _TextBlockData
from ....types.media import ImageBlock, _ImageBlockData
from ....types.tools import ToolResultBlock, _ToolResultBlockData
from .media import AudioDelta, _AudioDeltaData

BidiUserContentBlock: TypeAlias = TextBlock | ImageBlock
"""A complete text or image block supplied by a user."""

BidiContentBlock: TypeAlias = BidiUserContentBlock | ToolResultBlock
"""A complete text, image, or tool result block."""

BidiContentDelta: TypeAlias = AudioDelta
"""An audio delta for the live input stream."""

BidiUserContentBlockData: TypeAlias = _TextBlockData | _ImageBlockData
"""Dictionary form of one user content block."""

BidiContentBlockData: TypeAlias = BidiUserContentBlockData | _ToolResultBlockData
"""Dictionary form of one text, image, or tool result block."""

BidiContentDeltaData: TypeAlias = _AudioDeltaData
"""Dictionary form of an audio delta."""


@dataclass
class BidiMessage:
    """An input message containing ordered content blocks.

    Callers must supply at least one block when sending and must not mix tool
    results with user text or images. Send streaming deltas individually.

    Attributes:
        content: Ordered list of complete content blocks.
    """

    content: list[BidiContentBlock]


class BidiContentMetadata(TypedDict):
    """Streamed content metadata stored under a message's metadata.custom.bidi.

    Attributes:
        kind: Identifies the message as text, reasoning, or a transcript.
        status: Whether the content is pending, complete, or incomplete.
    """

    kind: Literal["text", "reasoning", "transcript"]
    status: Literal["pending", "complete", "incomplete"]


class BidiToolMetadata(TypedDict):
    """Tool-result metadata stored under a message's metadata.custom.bidi.

    Attributes:
        kind: Whether the message records dispatch or the completed result.
        tool_use_id: Original provider tool-use ID.
    """

    kind: Literal["tool_dispatch", "tool_result"]
    tool_use_id: str

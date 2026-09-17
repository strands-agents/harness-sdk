"""Content-related type definitions for bidirectional streaming."""

from typing import TypeAlias

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

"""Content-related type definitions for bidirectional streaming."""

from typing import TypeAlias

from ....types.content import TextBlock, _TextBlockData
from ....types.media import ImageBlock, _ImageBlockData
from .media import AudioDelta, _AudioDeltaData

BidiContentBlock: TypeAlias = TextBlock | AudioDelta | ImageBlock
"""A text block, audio delta, or image block."""

BidiContentBlockData: TypeAlias = _TextBlockData | _AudioDeltaData | _ImageBlockData
"""Dictionary form of one text block, audio delta, or image block."""

"""Content-related type definitions for bidirectional streaming."""

from typing import TypeAlias

from ....types.content import TextBlock, _TextBlockData
from ....types.media import AudioBlock, ImageBlock, _AudioBlockData, _ImageBlockData

BidiContentBlock: TypeAlias = TextBlock | AudioBlock | ImageBlock
"""A text, audio, or image block."""

BidiContentBlockData: TypeAlias = _TextBlockData | _AudioBlockData | _ImageBlockData
"""Dictionary form of one text, audio, or image block."""

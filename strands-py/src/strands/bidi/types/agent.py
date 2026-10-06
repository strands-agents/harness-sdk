"""Agent-related type definitions for bidirectional streaming.

This module defines the types used for BidiAgent.
"""

from typing import TypeAlias

from .content import BidiContentDelta, BidiContentDeltaData, BidiUserContentBlock, BidiUserContentBlockData

BidiAgentInput: TypeAlias = (
    str
    | BidiUserContentBlock
    | BidiUserContentBlockData
    | BidiContentDelta
    | BidiContentDeltaData
    | list[str | BidiUserContentBlock | BidiUserContentBlockData]
)
"""User input accepted by `BidiAgent.send()` and returned by input streams.

Supported forms:

- Text: a string, `TextBlock`, or a dictionary with a `text` key.
- Image: `ImageBlock` or a dictionary with an `image` key.
- Streaming audio: `AudioDelta` or a dictionary with an `audio_delta` key.
- Grouped content: a nonempty list of strings, text/image blocks, or their dictionary forms.

A list forms one user message and preserves block order. Send audio deltas individually,
outside these lists.
"""

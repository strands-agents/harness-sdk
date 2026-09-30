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
"""A single user input or list of user content blocks."""

"""Agent-related type definitions for bidirectional streaming.

This module defines the types used for BidiAgent.
"""

from typing import TypeAlias

from .content import BidiContentBlock, BidiContentBlockData, BidiContentDelta, BidiContentDeltaData

BidiAgentInput: TypeAlias = (
    str
    | BidiContentBlock
    | BidiContentBlockData
    | BidiContentDelta
    | BidiContentDeltaData
    | list[str | BidiContentBlock | BidiContentBlockData]
)
"""A single input or block list. Tool results are rejected by BidiAgent.send."""

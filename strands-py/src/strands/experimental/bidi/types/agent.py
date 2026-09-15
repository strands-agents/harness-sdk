"""Agent-related type definitions for bidirectional streaming.

This module defines the types used for BidiAgent.
"""

from typing import TypeAlias

from .content import BidiContentBlock, BidiContentBlockData

BidiAgentInput: TypeAlias = str | BidiContentBlock | BidiContentBlockData
"""Input accepted by a bidirectional agent."""

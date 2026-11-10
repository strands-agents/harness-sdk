"""Multi-agent related type definitions for the SDK."""

from typing import TypeAlias

from .content import ContentBlock
from .interrupt import InterruptResponseContent

MultiAgentInput: TypeAlias = str | list[ContentBlock] | list[InterruptResponseContent]

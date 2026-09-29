"""Accumulate streamed content for completed events and conversation history."""

from dataclasses import dataclass, field
from typing import ClassVar, Literal

from ....types.content import Message, Role
from ..types.content import BidiContentMetadata
from ..types.events import (
    BidiOutputEvent,
    BidiReasoningBlockEvent,
    BidiTextBlockEvent,
    BidiTranscriptBlockEvent,
)


@dataclass
class _TextBlock:
    """Text accumulated for one reserved history message."""

    kind: ClassVar[Literal["text", "reasoning", "transcript"]] = "text"
    content_id: str
    message: Message = field(init=False)
    text: str = ""

    def __post_init__(self) -> None:
        """Initialize the pending history message."""
        self.message = {
            "role": "assistant",
            "content": [],
            "metadata": {"custom": {"bidi": BidiContentMetadata(kind=self.kind, status="pending")}},
        }

    def append(self, delta: str) -> None:
        """Append the next text fragment."""
        self.text += delta

    def to_message(self, *, complete: bool = True) -> Message:
        """Build a history message with its completion status."""
        return {
            **self.message,
            "content": [{"text": self.text}],
            "metadata": {
                "custom": {"bidi": BidiContentMetadata(kind=self.kind, status="complete" if complete else "incomplete")}
            },
        }

    def to_event(self) -> BidiOutputEvent:
        """Build the completed text event."""
        return BidiTextBlockEvent(self.text, self.content_id)


class _ReasoningBlock(_TextBlock):
    """Reasoning accumulated for one reserved history message."""

    kind = "reasoning"

    def to_message(self, *, complete: bool = True) -> Message:
        """Build a reasoning history message."""
        return {
            **super().to_message(complete=complete),
            "content": [{"reasoningContent": {"reasoningText": {"text": self.text}}}],
        }

    def to_event(self) -> BidiReasoningBlockEvent:
        """Build the completed reasoning event."""
        return BidiReasoningBlockEvent(self.text, self.content_id)


class _TranscriptBlock(_TextBlock):
    """Speech transcription accumulated for one reserved history message."""

    kind = "transcript"

    def __init__(self, content_id: str, role: Role) -> None:
        """Initialize the pending transcript message."""
        super().__init__(content_id)
        self.message["role"] = role

    def to_message(self, *, complete: bool = True) -> Message:
        """Build a transcript message with its completion status."""
        message = super().to_message(complete=complete)
        if not complete:
            message["content"] = [{"text": "[Transcript unavailable.]"}]
        return message

    def to_event(self) -> BidiTranscriptBlockEvent:
        """Build the completed transcript event."""
        return BidiTranscriptBlockEvent(self.text, self.message["role"], self.content_id)

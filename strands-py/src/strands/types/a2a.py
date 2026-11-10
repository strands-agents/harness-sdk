"""Additional A2A types."""

from typing import Any, TypeAlias

from a2a.types import Message, Task, TaskArtifactUpdateEvent, TaskStatusUpdateEvent

from ._events import TypedEvent

A2AResponse: TypeAlias = tuple[Task, TaskStatusUpdateEvent | TaskArtifactUpdateEvent | None] | Message | Any


class A2AStreamEvent(TypedEvent):
    """Event emitted for every update received from the remote A2A server.

    This event wraps all A2A response types during streaming, including:
    - Partial task updates (TaskArtifactUpdateEvent)
    - Status updates (TaskStatusUpdateEvent)
    - Complete messages (Message)
    - Final task completions

    The event is emitted for EVERY update from the server, regardless of whether
    it represents a complete or partial response. When streaming completes, an
    AgentResultEvent containing the final AgentResult is also emitted after all
    A2AStreamEvents.
    """

    def __init__(self, a2a_event: A2AResponse) -> None:
        """Initialize with A2A event.

        Args:
            a2a_event: The original A2A event (Task tuple or Message)
        """
        super().__init__(
            {
                "type": "a2a_stream",
                "event": a2a_event,  # Nest A2A event to avoid field conflicts
            }
        )

"""Additional A2A types."""

from typing import TypeAlias

from a2a.types import StreamResponse

from ._events import TypedEvent

A2AResponse: TypeAlias = StreamResponse


class A2AStreamEvent(TypedEvent):
    """Event emitted for every update received from the remote A2A server.

    This event wraps every ``StreamResponse`` received during streaming, including:
    - The initial ``Task`` (``task`` field)
    - Partial task updates (``artifact_update`` field)
    - Status updates (``status_update`` field)
    - Complete messages (``message`` field)

    The event is emitted for EVERY update from the server, regardless of whether
    it represents a complete or partial response. When streaming completes, an
    AgentResultEvent containing the final AgentResult is also emitted after all
    A2AStreamEvents.
    """

    def __init__(self, a2a_event: A2AResponse) -> None:
        """Initialize with A2A event.

        Args:
            a2a_event: The original A2A StreamResponse event.
        """
        super().__init__(
            {
                "type": "a2a_stream",
                "event": a2a_event,  # Nest A2A event to avoid field conflicts
            }
        )

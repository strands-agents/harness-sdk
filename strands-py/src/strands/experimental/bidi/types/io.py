"""Protocol for bidirectional streaming IO channels.

Defines callable protocols for input and output channels that can be used
with BidiAgent. This approach provides better typing and flexibility
by separating input and output concerns into independent callables.
"""

from collections.abc import Awaitable
from typing import TYPE_CHECKING, Protocol, runtime_checkable

from .agent import BidiAgentInput
from .events import BidiOutputEvent

if TYPE_CHECKING:
    from ..agent.agent import BidiAgent


@runtime_checkable
class BidiInput(Protocol):
    """Protocol for bidirectional input callables.

    Input callables read data from a source (microphone, camera, websocket, etc.)
    and return events to be sent to the agent.
    """

    async def start(self, agent: "BidiAgent") -> None:
        """Start input."""
        return

    async def stop(self) -> None:
        """Stop input."""
        return

    def __call__(self) -> Awaitable[BidiAgentInput]:
        """Read input data from the source.

        Returns:
            Awaitable that resolves to input content (audio, text, image, etc.)
        """
        ...


@runtime_checkable
class BidiOutput(Protocol):
    """Protocol for bidirectional output callables.

    Output callables receive events from the agent and handle them appropriately
    (play audio, display text, send over websocket, etc.).
    """

    async def start(self, agent: "BidiAgent") -> None:
        """Start output."""
        return

    async def stop(self) -> None:
        """Stop output."""
        return

    def __call__(self, event: BidiOutputEvent) -> Awaitable[None]:
        """Process output events from the agent.

        Args:
            event: Output event from the agent (audio, text, tool calls, etc.)
        """
        ...

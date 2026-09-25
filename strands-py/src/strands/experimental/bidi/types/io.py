"""Protocols for bidirectional input and output streams.

The protocols separate input and output concerns into independent callables
with lifecycle methods managed by ``BidiAgent``.
"""

from collections.abc import Awaitable
from typing import TYPE_CHECKING, Protocol, runtime_checkable

from .agent import BidiAgentInput
from .events import BidiOutputEvent

if TYPE_CHECKING:
    from ..agent.agent import BidiAgent


@runtime_checkable
class InputStream(Protocol):
    """Callable input stream managed by a bidirectional agent.

    An input stream reads one value from a source each time the agent calls it.
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
class OutputStream(Protocol):
    """Callable output stream managed by a bidirectional agent.

    An output stream handles one event each time the agent calls it.
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

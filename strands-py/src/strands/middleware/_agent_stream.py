"""Internal stage wrapping the entire agent output stream.

Kept out of ``strands.middleware`` until the copy-vs-reference contract of ``AgentStreamContext``
is finalized; the TypeScript SDK marks the same stage ``@internal``.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from ..interrupt import _AGENT_STREAM_INTERRUPT_ID_PREFIX, Interrupt
from ..types._events import EventLoopStopEvent
from .stages import MiddlewareInterruptResult, _resolve_middleware_interrupt
from .types import MiddlewareStage

if TYPE_CHECKING:
    from ..types._events import TypedEvent
    from ..types.agent import LocalAgent
    from ..types.content import Messages


@dataclass
class AgentStreamContext:
    """Context passed to AgentStreamStage middleware.

    Wraps the entire agent output stream at the outermost interception point, so middleware
    can filter, transform, or inject events across a whole invocation pass, or gate the pass
    behind a human-in-the-loop interrupt.

    ``messages`` is the input for this pass; the terminal appends it to history, so a replaced
    list reaches the model and nothing is appended when middleware short-circuits.
    ``invocation_state`` is shared by reference, matching how hooks and tools receive it. The
    copy-vs-reference contract is not yet finalized; middleware that needs isolation should
    copy explicitly.

    Supports middleware-initiated interrupts via ``interrupt()`` for human-in-the-loop
    approval flows.
    """

    agent: LocalAgent
    messages: Messages
    invocation_state: dict[str, Any]
    _interrupts: Mapping[str, Interrupt] = field(repr=False)
    """Snapshot of the agent's interrupts taken before the pass, always supplied by the run loop.

    A snapshot rather than the live dict because this context outlives a tool cycle within the
    same pass, which ends by clearing the live interrupts; the snapshot keeps a gate's re-read
    after ``next_fn`` stable.
    """

    def interrupt(self, name: str, *, reason: Any = None, response: Any = None) -> MiddlewareInterruptResult:
        """Request a human-in-the-loop interrupt.

        On first execution (no prior response) this raises ``InterruptException`` to halt
        the agent. After the user resumes with a response, the second call returns that
        response. Providing ``response`` preemptively skips the interrupt entirely.

        This method is read-only with respect to interrupt state (see
        ``_resolve_middleware_interrupt``): the run loop registers the interrupt in its
        ``InterruptException`` handler as the single source of truth.

        Args:
            name: User-defined name for the interrupt. The name must be unique
                across all agent-stream middleware that share an interrupt dict — including
                across agents in a Graph/Swarm. Two gates with the same name collide and share
                one response.
            reason: Optional reason for the interrupt (surfaced to the user).
            response: Optional preemptive response — when set, no interrupt is raised.

        Returns:
            The user's response wrapped in a ``MiddlewareInterruptResult``.

        Raises:
            InterruptException: When no response is available yet and none was provided.
            RuntimeError: Raised by the run loop when this is called after the pass has already
                produced its stop event, which resuming cannot replay.
        """
        return _resolve_middleware_interrupt(self._interrupts, self._interrupt_id(name), name, reason, response)

    def _interrupt_id(self, name: str) -> str:
        """Derive the interrupt id for ``name``, namespaced to the agent-stream stage.

        Follows the SDK's ``v1:`` interrupt-id scheme (see ``types/interrupt.py``), hashing
        the user-provided name so ids stay stable across resumes.
        """
        return f"{_AGENT_STREAM_INTERRUPT_ID_PREFIX}{uuid.uuid5(uuid.NAMESPACE_OID, name)}"


@dataclass
class AgentStreamResult:
    """Result passed to and returned from ``AgentStreamStage.Output`` handlers.

    Attributes:
        result: The ``EventLoopStopEvent`` that ends the invocation pass.
    """

    result: EventLoopStopEvent


AgentStreamStage: MiddlewareStage[AgentStreamContext, AgentStreamResult, TypedEvent] = MiddlewareStage(
    name="agentStream", result_type=AgentStreamResult, result_event=EventLoopStopEvent
)
"""Built-in stage wrapping the entire agent output stream (outermost interception point).

Middleware registered for this stage can filter, transform, or inject events, short-circuit the
whole pass, or gate it behind a human-in-the-loop interrupt.
"""

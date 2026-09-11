"""Built-in middleware stages and their context/result types."""

from __future__ import annotations

import threading
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from ..interrupt import _AGENT_STREAM_INTERRUPT_ID_PREFIX, Interrupt, InterruptException
from .types import MiddlewareStage

if TYPE_CHECKING:
    from ..agent.agent import Agent
    from ..experimental.bidi import BidiAgent
    from ..interrupt import _InterruptState
    from ..models.model import Model
    from ..types._events import EventLoopStopEvent, ModelStopReason, ToolResultEvent, TypedEvent
    from ..types.content import Messages, SystemPrompt
    from ..types.tools import AgentTool, ToolChoice, ToolSpec, ToolUse


@dataclass
class InvokeModelContext:
    """Context passed to InvokeModelStage middleware.

    The collection fields (messages, system_prompt, tool_specs, tool_choice) are defensive
    copies, so middleware cannot accidentally mutate agent state. ``invocation_state`` and
    ``model`` are instead shared by reference: ``invocation_state`` is the live dict hooks and
    tools write to during streaming, and ``model`` is the model this call invokes (it starts
    as ``agent.model``; middleware may replace it per call).
    """

    agent: Agent
    messages: Messages
    system_prompt: SystemPrompt
    tool_specs: list[ToolSpec]
    tool_choice: ToolChoice | None
    invocation_state: dict[str, Any]
    model: Model
    projected_input_tokens: int | None = None
    dynamic_trailing_blocks: int = 0


InvokeModelStage: MiddlewareStage[InvokeModelContext, ModelStopReason, TypedEvent] = MiddlewareStage(name="invokeModel")
"""Built-in stage wrapping core model invocation.

Middleware registered for this stage can rate-limit, cache, or transform model inputs/outputs.
"""


@dataclass
class MiddlewareInterruptResult:
    """Value returned by a middleware ``interrupt()`` when the agent resumes.

    Wrapping the response (rather than returning it bare) mirrors the TypeScript SDK and
    leaves room to add fields later without breaking callers.

    Attributes:
        response: The human-provided response the agent resumed with.
    """

    response: Any


def _resolve_middleware_interrupt(
    interrupts: Mapping[str, Interrupt],
    interrupt_id: str,
    name: str,
    reason: Any,
    response: Any,
) -> MiddlewareInterruptResult:
    """Resolve a middleware-initiated interrupt without mutating interrupt state.

    Shared by every ``MiddlewareInterruptible`` context (tool and agent-stream stages). It
    inspects prior responses but never registers the interrupt: the stage's executor
    registers it in its ``InterruptException`` handler as the single source of truth,
    matching the TypeScript SDK where middleware interrupts never write to interrupt state.

    Args:
        interrupts: The prior-response lookup — the agent's live ``interrupts`` dict for the tool
            stage, or a snapshot taken before the pass for the agent-stream stage (whose reads must
            survive a tool cycle ending mid-pass and clearing the live dict).
        interrupt_id: The deterministic id for this interrupt.
        name: User-defined name for the interrupt.
        reason: Optional reason surfaced to the user.
        response: Optional preemptive response — fallback if no prior human response exists.

    Returns:
        The user's response wrapped in a ``MiddlewareInterruptResult``.

    Raises:
        InterruptException: When no response is available yet and none was provided.
    """
    existing = interrupts.get(interrupt_id)
    if existing is not None and existing.response is not None:
        return MiddlewareInterruptResult(response=existing.response)

    if response is not None:
        return MiddlewareInterruptResult(response=response)

    raise InterruptException(Interrupt(id=interrupt_id, name=name, reason=reason))


@dataclass
class ExecuteToolContext:
    """Context passed to ExecuteToolStage middleware.

    ``tool_use`` is a shallow copy of the executor's dict, so reassigning its top-level
    keys (e.g. ``name``, ``toolUseId``) cannot corrupt executor state. Its ``input`` value
    is shared by reference — it can hold arbitrary, non-copyable objects (e.g. the agent
    injected on direct tool calls), so a deep copy is not possible; mutating ``input`` in
    place still leaks. ``invocation_state`` is likewise shared by reference (matching how
    hooks receive it). Middleware that needs a fully isolated ``tool_use`` should build a
    new one and pass a modified context via ``dataclasses.replace()``.

    ``cancel_signal`` is the executor's own signal, passed on to the tool independently of this
    context: middleware can observe it, but replacing it via ``dataclasses.replace()`` does not
    change the signal the tool receives.

    Supports middleware-initiated interrupts via ``interrupt()`` for human-in-the-loop
    approval flows.
    """

    agent: Agent | BidiAgent
    tool: AgentTool | None
    tool_use: ToolUse
    invocation_state: dict[str, Any]
    # Excluded from repr: an Event carries no useful text.
    cancel_signal: threading.Event = field(repr=False)
    # Interrupt state is threaded in from the agent so interrupt() can register/resolve
    # interrupts. Required (the executor is the sole constructor and always supplies it);
    # excluded from repr to avoid dumping unrelated interrupt bookkeeping.
    _interrupt_state: _InterruptState = field(repr=False)

    def interrupt(self, name: str, *, reason: Any = None, response: Any = None) -> MiddlewareInterruptResult:
        """Request a human-in-the-loop interrupt.

        On first execution (no prior response) this raises ``InterruptException`` to halt
        the agent. After the user resumes with a response, the second call returns that
        response. Providing ``response`` preemptively skips the interrupt entirely.

        This method is read-only with respect to interrupt state: it inspects prior
        responses but does not register the interrupt itself. The tool executor registers
        it (in its ``InterruptException`` handler) as the single source of truth, matching
        the TypeScript SDK where middleware interrupts never write to interrupt state.

        Args:
            name: User-defined name for the interrupt. The interrupt id is scoped to the tool
                call (``v1:middleware_execute_tool:<toolUseId>:<uuid5(name)>``) but not to the
                individual middleware, so the name must be unique across all middleware that
                interrupt this tool call — two middleware using the same name on the same tool
                call collide and share one response. (This matches the hook/tool interrupt
                contract, which is likewise unique per tool call, not per callback.)
            reason: Optional reason for the interrupt (surfaced to the user).
            response: Optional preemptive response — when set, no interrupt is raised.

        Returns:
            The user's response wrapped in a ``MiddlewareInterruptResult``.

        Raises:
            InterruptException: When no response is available yet and none was provided.
        """
        return _resolve_middleware_interrupt(
            self._interrupt_state.interrupts, self._interrupt_id(name), name, reason, response
        )

    def _interrupt_id(self, name: str) -> str:
        """Derive the interrupt id for ``name``, namespaced by the tool call.

        Follows the SDK's ``v1:`` interrupt-id scheme (see ``types/interrupt.py``), hashing
        the user-provided name so ids stay stable across resumes for the same tool call.
        """
        return f"v1:middleware_execute_tool:{self.tool_use['toolUseId']}:{uuid.uuid5(uuid.NAMESPACE_OID, name)}"


ExecuteToolStage: MiddlewareStage[ExecuteToolContext, ToolResultEvent, TypedEvent] = MiddlewareStage(name="executeTool")
"""Built-in stage wrapping individual tool execution.

Middleware registered for this stage can add telemetry, validate inputs, mock responses,
or gate execution behind a human-in-the-loop interrupt. The result event is the
``ToolResultEvent`` produced by the tool (matching the "last event is the result"
convention used across the SDK).
"""


@dataclass
class AgentStreamContext:
    """Context passed to AgentStreamStage middleware.

    Wraps the entire agent output stream at the outermost interception point, so middleware
    can filter, transform, or inject events across a whole invocation pass, or gate the pass
    behind a human-in-the-loop interrupt.

    ``messages`` is the input for this pass, shared by reference (the executor already
    appended them to history). ``invocation_state`` is likewise shared by reference, matching
    how hooks and tools receive it. The copy-vs-reference contract is not yet finalized;
    middleware that needs isolation should copy explicitly.

    Supports middleware-initiated interrupts via ``interrupt()`` for human-in-the-loop
    approval flows.
    """

    agent: Agent
    messages: Messages
    invocation_state: dict[str, Any]
    # A snapshot of the agent's interrupts taken before the pass, threaded in so interrupt() can
    # resolve prior responses. It is a snapshot rather than the live dict because this context's
    # lifetime spans the whole pass: a tool cycle within the same pass ends and clears the live
    # interrupts, so reading a snapshot keeps a gate's re-read after next_fn stable. Required
    # (the run loop is the sole constructor and always supplies it); excluded from repr to
    # avoid dumping unrelated interrupt bookkeeping.
    _interrupts: Mapping[str, Interrupt] = field(repr=False)

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


# Internal: not exported from _middleware/__init__.py. The context's copy-vs-reference
# contract for messages/invocation_state is not yet finalized, matching the TS SDK, which
# keeps AgentStreamStage out of its public barrel (@internal) for the same reason.
AgentStreamStage: MiddlewareStage[AgentStreamContext, EventLoopStopEvent, TypedEvent] = MiddlewareStage(
    name="agentStream"
)
"""Built-in stage wrapping the entire agent output stream (outermost interception point).

Middleware registered for this stage can filter, transform, or inject events, short-circuit
the whole pass, or gate it behind a human-in-the-loop interrupt. The result event is the
``EventLoopStopEvent`` that ends the pass (matching the "last event is the result"
convention used across the SDK).
"""

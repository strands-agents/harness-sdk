"""Agent-related type definitions for the SDK.

This module defines the types used for an Agent.
"""

from __future__ import annotations

import threading
from enum import Enum
from typing import TYPE_CHECKING, Any, ClassVar, Literal, Protocol, TypeAlias, TypeVar

from typing_extensions import TypedDict

from .content import ContentBlock, Messages, SystemContentBlock
from .interrupt import InterruptResponseContent

if TYPE_CHECKING:
    from .._context_manager.context_manager import ContextManager
    from ..agent.state import AgentState
    from ..hooks.registry import BaseHookEvent, HookCallback, HookRegistry
    from ..models.model import Model
    from ..sandbox import Sandbox
    from ..storage.storage import Storage
    from ..telemetry.metrics import EventLoopMetrics
    from ..tools._caller import _ToolCaller
    from ..tools.registry import ToolRegistry
    from ._snapshot import Snapshot, SnapshotField, SnapshotPreset

AgentInput: TypeAlias = str | list[ContentBlock] | list[InterruptResponseContent] | Messages | None

_TEvent = TypeVar("_TEvent", bound="BaseHookEvent")
"""Hook event type registered by LocalAgent.add_hook."""


class LocalAgent(Protocol):
    """Interface for SDK-provided agents with locally accessible capabilities.

    This protocol is exported for type annotations and is not intended for external implementation.

    Attributes:
        agent_id: Unique identifier for the agent.
        name: Display name for the agent.
        description: Optional description of the agent.
        messages: Conversation history maintained by the agent.
        state: Application state associated with the agent.
        hooks: Registry containing the agent's hook callbacks.
        model: Model used by the agent.
        system_prompt: String representation of the agent's system prompt.
        tool_registry: Registry containing tools available to the agent.
        event_loop_metrics: Aggregated metrics for the agent's loop execution.
    """

    _is_strands_local_agent: ClassVar[Literal[True]]
    """Internal type-level marker for SDK-provided LocalAgent implementations."""

    agent_id: str
    name: str
    description: str | None
    messages: Messages
    state: AgentState
    hooks: HookRegistry
    model: Model
    system_prompt: str | None
    tool_registry: ToolRegistry
    event_loop_metrics: EventLoopMetrics

    @property
    def tool(self) -> _ToolCaller:
        """Caller for invoking registered tools directly."""
        ...

    @property
    def tool_names(self) -> list[str]:
        """Names of tools registered with the agent."""
        ...

    @property
    def system_prompt_content(self) -> list[SystemContentBlock] | None:
        """Structured system prompt content used by the agent."""
        ...

    @property
    def session_id(self) -> str:
        """Identifier for the current conversation session."""
        ...

    @property
    def storage(self) -> Storage | None:
        """Default storage backend for agent subsystems."""
        ...

    @property
    def sandbox(self) -> Sandbox:
        """Execution environment for running commands, code, and file operations."""
        ...

    @property
    def context_manager(self) -> ContextManager | None:
        """The ContextManager plugin, if one is registered on this agent."""
        ...

    @property
    def cancel_signal(self) -> threading.Event:
        """The cancellation signal for the current invocation."""
        ...

    def cancel(self, *, message: str | None = None, after_current_tools: bool = False) -> None:
        """Request cancellation at the agent's next supported checkpoint.

        Args:
            message: Optional terminal assistant message appended to history on exit.
            after_current_tools: If True, defer cancellation until the current tool
                batch finishes; the loop exits before the next model call.
        """
        ...

    def add_hook(
        self,
        callback: HookCallback[_TEvent],
        event_type: type[_TEvent] | list[type[_TEvent]] | None = None,
        *,
        order: float = ...,
    ) -> None:
        """Register a hook callback."""
        ...

    def take_snapshot(
        self,
        *,
        preset: SnapshotPreset | None = None,
        include: list[SnapshotField] | None = None,
        exclude: list[SnapshotField] | None = None,
        app_data: dict[str, Any] | None = None,
    ) -> Snapshot:
        """Capture current agent state as an in-memory snapshot.

        The fields a preset captures, and the fields accepted by include and exclude, are
        implementation-defined.
        """
        ...

    def load_snapshot(self, snapshot: Snapshot) -> None:
        """Restore agent state from a previously captured snapshot.

        Only fields present in snapshot.data are restored; absent fields are left unchanged.
        """
        ...


class Limits(TypedDict, total=False):
    """Limits for the request a top-level ``invoke_async`` / ``stream_async`` call starts.

    They apply to this agent's loop and to every nested call: agents passed as tools, and
    any Graph or Swarm you pass the request's ``invocation_context`` to (Graph and Swarm have
    no ``limits`` option of their own). An agent run by a hand-written tool joins only when
    the tool forwards ``tool_context.invocation_context`` as ``invocation_context``; otherwise
    it runs standalone under its own limits. A nested call can also set its own ``limits``:
    it stops at whichever limit is reached first, its own or the request's.

    Auxiliary calls (summarization, routing, memory extraction, steering, HITL, goal judging,
    web-fetch) and decision models asked with the request's ``invocation_context`` add their
    tokens to the request's usage, but no limits apply to them. The same holds for an agent that
    an extension point (a conversation manager, context or routing strategy, or memory extractor)
    runs with the ``invocation_context`` it receives, unless the extension point also passes
    ``limits``. Usage starts from zero on each top-level call; pass ``result.invocation_context``
    to a later call to continue on the same limits and usage.

    Limits are checked before each turn, so tools requested by the previous turn finish first
    and ``agent.messages`` stays reinvokable. Each limit, when set, must be a positive ``int``;
    omit a field (or pass ``limits=None``) for no limit on that dimension.

    Priority when several are reached at once (highest first): ``turns``, ``total_tokens``,
    ``output_tokens``, ``structured_output_attempts``, with ``stop_reason`` ``"limit_turns"``,
    ``"limit_total_tokens"``, ``"limit_output_tokens"``, or ``"limit_structured_output_attempts"``.

    Attributes:
        turns: Maximum number of turns. One turn is one model call plus any tool execution
            that follows.
        output_tokens: Maximum cumulative model-generated tokens across every model call in
            the request, unlike a provider's per-call cap. Soft limit: a single oversized
            response can overshoot it, more so when nested calls run in parallel.
        total_tokens: Maximum cumulative input + output tokens across every model call in the
            request. Each model call's input includes prior turns, so this compounds across the
            run and approximates total token spend. Soft limit, same caveat as ``output_tokens``.
        structured_output_attempts: Maximum failed structured output attempts across the request.
            A model response counts as one failed attempt when it calls the structured output tool
            with invalid input, or doesn't return valid structured output while the tool is forced.
            When omitted, retries are unbounded and a failed forced response raises
            ``StructuredOutputException``.
    """

    turns: int
    output_tokens: int
    total_tokens: int
    structured_output_attempts: int


_LIMITS_KEYS = tuple(Limits.__annotations__)
"""The recognized cap names, in declaration order.

Derived from ``Limits`` so validation and the type it validates against cannot drift apart.
"""


class ConcurrentInvocationMode(str, Enum):
    """Mode controlling concurrent invocation behavior.

    Values:
        THROW: Raises ConcurrencyException if concurrent invocation is attempted (default).
        UNSAFE_REENTRANT: Allows concurrent invocations without locking.

    Warning:
        The ``UNSAFE_REENTRANT`` mode makes no guarantees about resulting behavior and is
        provided only for advanced use cases where the caller understands the risks.
    """

    THROW = "throw"
    UNSAFE_REENTRANT = "unsafe_reentrant"

"""Agent-related type definitions for the SDK.

This module defines the types used for an Agent.
"""

from __future__ import annotations

from enum import Enum
from typing import TYPE_CHECKING, ClassVar, Literal, Protocol, TypeAlias, TypeVar

from typing_extensions import TypedDict

from .content import ContentBlock, Messages, SystemContentBlock
from .interrupt import InterruptResponseContent

if TYPE_CHECKING:
    from ..agent.state import AgentState
    from ..hooks.registry import BaseHookEvent, HookCallback, HookRegistry
    from ..models.model import Model
    from ..tools._caller import _ToolCaller
    from ..tools.registry import ToolRegistry

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

    def add_hook(
        self,
        callback: HookCallback[_TEvent],
        event_type: type[_TEvent] | list[type[_TEvent]] | None = None,
        *,
        order: float = ...,
    ) -> None:
        """Register a hook callback."""
        ...


class Limits(TypedDict, total=False):
    """Per-invocation budget caps for the agent loop.

    Each cap, when set, bounds a single ``invoke_async`` / ``stream_async`` call only;
    counters are not cumulative across reuses of the same agent. Caps are checked at
    the top of each loop iteration, so tools requested by the previous turn always run
    to completion before a cap fires and ``agent.messages`` remains in a reinvokable state.

    Each cap, when set, must be a positive ``int``. Omit any field (or pass ``limits=None``)
    for no limit on that dimension.

    Priority on simultaneous trip (highest first): ``turns``, ``total_tokens``,
    ``output_tokens``. The corresponding ``stop_reason`` is ``"limit_turns"``,
    ``"limit_total_tokens"``, or ``"limit_output_tokens"``.

    Attributes:
        turns: Maximum number of agent loop iterations (turns). One turn is one model
            call plus any tool execution that follows. Counted against
            ``len(metrics.latest_agent_invocation.cycles)``.
        output_tokens: Maximum cumulative model-generated tokens, summed across every
            model call in the loop (``metrics.latest_agent_invocation.usage["outputTokens"]``).
            Distinct from per-call provider-level caps, which bound a single model call's
            output. Soft cap: a single oversized response can overshoot the budget;
            checked at turn boundaries, not within an individual model call.
        total_tokens: Maximum cumulative input + output tokens
            (``metrics.latest_agent_invocation.usage["totalTokens"]``). Each model call's
            input includes prior turns, so this counter compounds across the run and
            approximates total token spend. Soft cap, same caveat as ``output_tokens``.
    """

    turns: int
    output_tokens: int
    total_tokens: int


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

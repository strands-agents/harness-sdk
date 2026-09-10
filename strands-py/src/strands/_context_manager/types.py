"""Configuration types for the ContextManager."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol, runtime_checkable

from typing_extensions import TypedDict

from ..types.content import ContentBlock, Messages

if TYPE_CHECKING:
    from ..agent.agent import Agent
    from ..storage.storage import Storage
    from .stash import Stash


def is_tool_result_block(block: ContentBlock) -> bool:
    """Check if a content block is a tool result."""
    return "toolResult" in block


def is_tool_use_block(block: ContentBlock) -> bool:
    """Check if a content block is a tool use."""
    return "toolUse" in block


def is_text_block(block: ContentBlock) -> bool:
    """Check if a content block is plain text (not a tool result or tool use)."""
    return "text" in block and "toolResult" not in block and "toolUse" not in block


@dataclass
class ContextState:
    """State passed to strategies during apply().

    Attributes:
        messages: The agent's current message list (mutable in place).
        agent: The agent instance.
        utilization: Current context utilization ratio (0-1+). Above 1.0 means overflow.
        stash: L1 stash for persisting offloaded content. Present when storage is configured.
    """

    messages: Messages
    agent: Agent
    utilization: float
    stash: Stash | None = field(default=None)


@runtime_checkable
class ContextStrategy(Protocol):
    """A context reduction strategy.

    Strategies are applied in order during the pipeline. Each decides whether
    to act based on the current context state.
    """

    @property
    def name(self) -> str:
        """Stable identifier for logging and observability."""
        ...

    async def apply(self, context: ContextState) -> bool:
        """Attempt to reduce context. Returns True if it made changes."""
        ...


class StashConfig(TypedDict, total=False):
    """Configuration for the L1 stash.

    Attributes:
        storage: Storage backend. Defaults to InMemoryStorage when omitted.
        retrieval_tool: Whether to register the retrieve_context tool. Defaults to True.
    """

    storage: Storage
    retrieval_tool: bool


class ContextManagerConfig(TypedDict, total=False):
    """Full configuration for a ContextManager instance.

    Attributes:
        strategies: Strategies for context reduction, applied as an ordered pipeline.
        stash: L1 stash configuration. Omit or True for defaults; False to disable.
    """

    strategies: list[ContextStrategy]
    stash: StashConfig | bool

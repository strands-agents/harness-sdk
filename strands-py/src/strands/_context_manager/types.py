"""Configuration types for the ContextManager."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol, runtime_checkable

from typing_extensions import TypedDict, deprecated

from ..types.content import ContentBlock, Messages

if TYPE_CHECKING:
    from ..agent.agent import Agent
    from ..agent.invocation_context import InvocationContext
    from ..storage.storage import Storage
    from .archive import Archive


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
        overflow: Set when running in response to a ContextWindowOverflowException.
            Strategies should bypass utilization gates when True.
        archive: L1 archive for persisting offloaded content. Present when storage is configured.
        invocation_context: The request this reduction runs for, if any; a nested call that joins it
            adds to the request's usage, but the request's limits don't apply.
    """

    messages: Messages
    agent: Agent
    utilization: float
    overflow: bool = field(default=False)
    archive: Archive | None = field(default=None)
    invocation_context: InvocationContext | None = field(default=None)

    @property
    @deprecated("ContextState.stash is deprecated and will be removed in v1.68.0. Use ContextState.archive instead.")
    def stash(self) -> Archive | None:
        """Deprecated name for :attr:`archive`. Removed in v1.68.0."""
        return self.archive

    @stash.setter
    @deprecated("ContextState.stash is deprecated and will be removed in v1.68.0. Use ContextState.archive instead.")
    def stash(self, archive: Archive | None) -> None:
        """Deprecated name for :attr:`archive`. Removed in v1.68.0."""
        self.archive = archive


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


class ArchiveConfig(TypedDict, total=False):
    """Configuration for the L1 archive.

    Each agent archives under ``context/<session_id>/scopes/agent/<agent_id>/``. The prefix is dropped
    only when a namespaced view is passed as this config's ``storage``; that view becomes the exact
    archive root, so agents given the same view share one archive. Deleting a session leaves a shared
    archive in place.

    Attributes:
        storage: Storage backend. Defaults to InMemoryStorage when omitted.
        retrieval_tool: Whether to register the retrieve_context tool. Defaults to True.

    Example:
        ```python
        storage = S3Storage(bucket="my-bucket")

        # Namespaced view passed to the archive: archives at "team/" (prefix dropped, shared).
        ContextManager(archive={"storage": storage.namespace("team")})

        # Plain storage passed to the archive:
        # archives at "context/<session_id>/scopes/agent/<agent_id>/".
        ContextManager(archive={"storage": storage})

        # Namespaced view passed as agent-level storage: prefix still applies, under the view:
        # archives at "team/context/<session_id>/scopes/agent/<agent_id>/".
        Agent(storage=storage.namespace("team"), context_manager=ContextManager())
        ```
    """

    storage: Storage
    retrieval_tool: bool


class ContextManagerConfig(TypedDict, total=False):
    """Full configuration for a ContextManager instance.

    Attributes:
        strategies: Strategies for context reduction, applied as an ordered pipeline.
        archive: L1 archive configuration. Omit or True for defaults; False to disable.
        stash: Deprecated name for ``archive``, honored when ``archive`` is omitted. Removed in v1.68.0.
    """

    strategies: list[ContextStrategy | str]
    archive: ArchiveConfig | bool
    stash: ArchiveConfig | bool

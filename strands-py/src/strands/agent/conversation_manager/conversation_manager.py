"""Abstract interface for conversation history management."""

import logging
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any, TypedDict, Union

from ...hooks.events import BeforeModelCallEvent
from ...hooks.registry import HookProvider, HookRegistry
from ...types.content import Message

if TYPE_CHECKING:
    from ...agent.agent import Agent

logger = logging.getLogger(__name__)

DEFAULT_COMPRESSION_THRESHOLD = 0.7


class ProactiveCompressionConfig(TypedDict, total=False):
    """Configuration for proactive compression when passed as an object.

    Attributes:
        compression_threshold: Ratio of context window usage that triggers proactive compression.
            Value between 0 (exclusive) and 1 (inclusive).
            Defaults to 0.7 (compress when 70% of the context window is used).
    """

    compression_threshold: float


class ConversationManager(ABC, HookProvider):
    """Abstract base class for managing conversation history.

    This class provides an interface for implementing conversation management strategies to control the size of message
    arrays/conversation histories, helping to:

    - Manage memory usage
    - Control context length
    - Maintain relevant conversation state

    ConversationManager implements the HookProvider protocol, allowing derived classes to register hooks for agent
    lifecycle events. Derived classes that override register_hooks must call the base implementation to ensure proper
    hook registration chain.

    The primary responsibility of a ConversationManager is overflow recovery: when the model encounters a context
    window overflow, :meth:`reduce_context` is called with ``e`` set and MUST reduce the history enough for the next
    model call to succeed.

    Subclasses can enable proactive compression by passing ``proactive_compression`` in the constructor.
    When enabled, the base class registers a ``BeforeModelCallEvent`` hook that checks projected input tokens
    against the model's context window limit and calls :meth:`reduce_context` (without ``e``) when the
    threshold is exceeded. This is a best-effort operation — errors are swallowed so the model call can
    still proceed.

    Example:
        ```python
        # Enable proactive compression with default threshold (0.7)
        SlidingWindowConversationManager(window_size=50, proactive_compression=True)

        # Enable proactive compression with custom threshold
        SummarizingConversationManager(proactive_compression={"compression_threshold": 0.8})
        ```
    """

    def __init__(self, *, proactive_compression: Union[bool, "ProactiveCompressionConfig", None] = None) -> None:
        """Initialize the ConversationManager.

        Args:
            proactive_compression: Enable proactive context compression before the model call.
                - ``True``: compress when 70% of the context window is used (default threshold).
                - ``{"compression_threshold": float}``: compress at the specified ratio (0, 1].
                - ``False`` or ``None``: disabled, only reactive overflow recovery is used.

        Raises:
            ValueError: If compression_threshold is not in the valid range (0, 1].

        Attributes:
          removed_message_count: The messages that have been removed from the agents messages array.
              These represent messages provided by the user or LLM that have been removed, not messages
              included by the conversation manager through something like summarization.
        """
        # Resolve the threshold from proactive_compression parameter
        if proactive_compression is True:
            threshold: float | None = DEFAULT_COMPRESSION_THRESHOLD
        elif isinstance(proactive_compression, dict):
            threshold = proactive_compression.get("compression_threshold", DEFAULT_COMPRESSION_THRESHOLD)
        else:
            threshold = None

        if threshold is not None and (threshold <= 0 or threshold > 1):
            raise ValueError(f"compression_threshold must be between 0 (exclusive) and 1 (inclusive), got {threshold}")

        self.removed_message_count = 0
        self.pinned_head_count = 0
        self._compression_threshold = threshold

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        """Register hooks for agent lifecycle events.

        Always registers a ``BeforeModelCallEvent`` hook for proactive compression.
        When ``proactive_compression`` is not configured, the handler is a no-op (early return).

        Derived classes that override this method must call the base implementation to ensure proper hook
        registration chain.

        Args:
            registry: The hook registry to register callbacks with.
            **kwargs: Additional keyword arguments for future extensibility.
        """
        # Always subscribe — the threshold check happens inside the handler
        registry.add_callback(BeforeModelCallEvent, self._on_before_model_call_threshold)

    def _on_before_model_call_threshold(self, event: BeforeModelCallEvent) -> None:
        """Handle BeforeModelCallEvent for proactive compression.

        When proactive compression is not configured, this is a no-op.
        When configured, checks projected input tokens against the context window limit
        and calls reduce_context() without error (best-effort) when threshold is exceeded.

        Args:
            event: The before model call event.
        """
        # Early return if proactive compression is not enabled
        if self._compression_threshold is None:
            return

        if event.projected_input_tokens is None:
            logger.debug("projected_input_tokens=<None> | skipping proactive compression")
            return

        ratio = event.agent.model.estimate_utilization(event.projected_input_tokens)
        if ratio >= self._compression_threshold:
            logger.debug(
                "projected_tokens=<%s>, context_window_limit=<%s>, ratio=<%.2f>, compression_threshold=<%s>"
                " | compression threshold exceeded, reducing context",
                event.projected_input_tokens,
                event.agent.model.context_window_limit,
                ratio,
                self._compression_threshold,
            )
            # Proactive compression is best-effort: swallow errors so the model call can still proceed.
            try:
                self.reduce_context(agent=event.agent)
            except Exception:
                logger.debug("proactive compression failed, will proceed with model call", exc_info=True)

    def restore_from_session(self, state: dict[str, Any]) -> list[Message] | None:
        """Restore the Conversation Manager's state from a session.

        Args:
            state: Previous state of the conversation manager
        Returns:
            Optional list of messages to prepend to the agents messages. By default returns None.
        """
        if state.get("__name__") != self.__class__.__name__:
            raise ValueError("Invalid conversation manager state.")
        self.removed_message_count = state["removed_message_count"]
        self.pinned_head_count = state.get("pinned_head_count", 0)
        return None

    def get_state(self) -> dict[str, Any]:
        """Get the current state of a Conversation Manager as a Json serializable dictionary."""
        return {
            "__name__": self.__class__.__name__,
            "removed_message_count": self.removed_message_count,
            "pinned_head_count": self.pinned_head_count,
        }

    @abstractmethod
    def apply_management(self, agent: "Agent", **kwargs: Any) -> None:
        """Applies management strategy to the provided agent.

        Processes the conversation history to maintain appropriate size by modifying the messages list in-place.
        Implementations should handle message pruning, summarization, or other size management techniques to keep the
        conversation context within desired bounds.

        Args:
            agent: The agent whose conversation history will be manage.
                This list is modified in-place.
            **kwargs: Additional keyword arguments for future extensibility.
        """
        pass

    @abstractmethod
    def reduce_context(self, agent: "Agent", e: Exception | None = None, **kwargs: Any) -> None:
        """Reduce the conversation history.

        Called in two scenarios:
        1. **Reactive** (e is set): A context window overflow occurred. The implementation
           MUST remove enough history for the next model call to succeed, or re-raise the error.
        2. **Proactive** (e is None): The compression threshold was exceeded. This is best-effort —
           returning without reduction or raising is acceptable; the model call proceeds regardless.

        Implementations should modify ``agent.messages`` in-place.

        Args:
            agent: The agent whose conversation history will be reduced.
                This list is modified in-place.
            e: The exception that triggered the context reduction, if any.
                When set, this is a reactive overflow recovery call — the implementation MUST
                reduce enough history for the next model call to succeed.
                When None, this is a proactive compression call — best-effort reduction to avoid
                hitting the context window limit.
            **kwargs: Additional keyword arguments for future extensibility.
        """
        pass

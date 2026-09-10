"""Summarizing conversation history management with configurable options."""

import logging
from typing import TYPE_CHECKING, Any, Optional, cast

from typing_extensions import override

from ..._async import run_async
from ...tools._tool_helpers import noop_tool
from ...tools.registry import ToolRegistry
from ...types.content import Message, _ensure_tracking_id
from ...types.exceptions import ContextWindowOverflowException
from ...types.tools import AgentTool
from .compression.context_compression import (
    DEFAULT_SUMMARIZATION_PROMPT,
    adjust_split_point_for_tool_pairs,
    generate_summary,
)
from .compression.pin_message import apply_pin_first, partition_pinned
from .conversation_manager import ConversationManager, ProactiveCompressionConfig

if TYPE_CHECKING:
    from ..agent import Agent


logger = logging.getLogger(__name__)

# ``DEFAULT_SUMMARIZATION_PROMPT`` is re-exported here for backward compatibility; the
# canonical definition now lives in ``compression.context_compression``.
__all__ = ["DEFAULT_SUMMARIZATION_PROMPT", "SummarizingConversationManager"]


class SummarizingConversationManager(ConversationManager):
    """Implements a summarizing window manager.

    This manager provides a configurable option to summarize older context instead of
    simply trimming it, helping preserve important information while staying within
    context limits.
    """

    def __init__(
        self,
        summary_ratio: float = 0.3,
        preserve_recent_messages: int = 10,
        summarization_agent: Optional["Agent"] = None,
        summarization_system_prompt: str | None = None,
        *,
        pin_first: int | None = None,
        proactive_compression: bool | ProactiveCompressionConfig | None = None,
    ):
        """Initialize the summarizing conversation manager.

        Args:
            summary_ratio: Ratio of messages to summarize vs keep when context overflow occurs.
                Value between 0.1 and 0.8. Defaults to 0.3 (summarize 30% of oldest messages).
            preserve_recent_messages: Minimum number of recent messages to always keep.
                Defaults to 10 messages.
            summarization_agent: Optional agent to use for summarization instead of the parent agent.
                If provided, this agent can use tools as part of the summarization process.
            summarization_system_prompt: Optional system prompt override for summarization.
                If None, uses the default summarization prompt.
            pin_first: Number of messages at the start of the conversation to permanently pin.
                Pinned messages are protected from summarization and compacted to the front.
            proactive_compression: Enable proactive context compression before the model call.
                - ``True``: compress when 70% of the context window is used (default threshold).
                - ``{"compression_threshold": float}``: compress at the specified ratio (0, 1].
                - ``False`` or ``None``: disabled, only reactive overflow recovery is used.
        """
        super().__init__(proactive_compression=proactive_compression)
        if summarization_agent is not None and summarization_system_prompt is not None:
            raise ValueError(
                "Cannot provide both summarization_agent and summarization_system_prompt. "
                "Agents come with their own system prompt."
            )

        self.summary_ratio = max(0.1, min(0.8, summary_ratio))
        self.preserve_recent_messages = preserve_recent_messages
        self.summarization_agent = summarization_agent
        self.summarization_system_prompt = summarization_system_prompt
        self.pin_first = max(0, pin_first) if pin_first is not None else None
        self._pin_first_applied = False
        self._summary_message: Message | None = None

    @override
    def restore_from_session(self, state: dict[str, Any]) -> list[Message] | None:
        """Restores the Summarizing Conversation manager from its previous state in a session.

        Args:
            state: The previous state of the Summarizing Conversation Manager.

        Returns:
            Optionally returns the previous conversation summary if it exists.
        """
        super().restore_from_session(state)
        self._summary_message = state.get("summary_message")
        return [self._summary_message] if self._summary_message else None

    def get_state(self) -> dict[str, Any]:
        """Returns a dictionary representation of the state for the Summarizing Conversation Manager."""
        return {"summary_message": self._summary_message, **super().get_state()}

    def apply_management(self, agent: "Agent", **kwargs: Any) -> None:
        """Apply management strategy to conversation history.

        For the summarizing conversation manager, no proactive management is performed.
        Summarization only occurs when there's a context overflow that triggers reduce_context.

        Args:
            agent: The agent whose conversation history will be managed.
                The agent's messages list is modified in-place.
            **kwargs: Additional keyword arguments for future extensibility.
        """
        # No proactive management - summarization only happens on context overflow
        pass

    def reduce_context(self, agent: "Agent", e: Exception | None = None, **kwargs: Any) -> None:
        """Reduce context using summarization.

        When ``e`` is set (reactive overflow recovery), summarization failure is re-raised —
        the agent loop must not proceed with an overflow.

        When ``e`` is None (proactive compression), summarization failure is logged and
        returns silently — the model call proceeds regardless.

        Args:
            agent: The agent whose conversation history will be reduced.
                The agent's messages list is modified in-place.
            e: The exception that triggered the context reduction, if any.
                When set, this is a reactive overflow recovery call.
                When None, this is a proactive compression call (best-effort).
            **kwargs: Additional keyword arguments for future extensibility.

        Raises:
            Exception: If summarization fails during reactive overflow recovery (e is set).
        """
        try:
            self._summarize_oldest(agent)
        except Exception as summarization_error:
            if e is not None:
                # Reactive: rethrow so the ContextWindowOverflowException propagates
                logger.error("Summarization failed: %s", summarization_error)
                raise summarization_error from e
            # Proactive: best-effort, swallow errors so the model call can still proceed.
            logger.warning("Proactive summarization failed, continuing: %s", summarization_error)

    def _summarize_oldest(self, agent: "Agent") -> None:
        """Summarize the oldest messages and replace them with a summary.

        Args:
            agent: The agent instance.

        Raises:
            ContextWindowOverflowException: If there are insufficient messages for summarization.
        """
        # Calculate how many messages to summarize
        messages_to_summarize_count = max(1, int(len(agent.messages) * self.summary_ratio))

        # Ensure we don't summarize recent messages
        messages_to_summarize_count = min(
            messages_to_summarize_count, len(agent.messages) - self.preserve_recent_messages
        )

        if messages_to_summarize_count <= 0:
            raise ContextWindowOverflowException("Cannot summarize: insufficient messages for summarization")

        # Adjust split point to avoid breaking ToolUse/ToolResult pairs
        messages_to_summarize_count = self._adjust_split_point_for_tool_pairs(
            agent.messages, messages_to_summarize_count
        )

        if messages_to_summarize_count <= 0:
            raise ContextWindowOverflowException("Cannot summarize: insufficient messages for summarization")

        # Pin first N messages permanently (only on first reduction)
        if self.pin_first and not self._pin_first_applied:
            apply_pin_first(agent.messages, self.pin_first)
            self._pin_first_applied = True

        # Partition [0, messages_to_summarize_count) into pinned (preserve) and non-pinned (summarize)
        protected_to_preserve, to_summarize = partition_pinned(agent.messages, 0, messages_to_summarize_count)

        if not to_summarize:
            raise ContextWindowOverflowException("Cannot summarize: all messages in summarize range are pinned")

        remaining_messages = agent.messages[messages_to_summarize_count:]

        # Keep track of the number of messages that have been summarized thus far.
        self.removed_message_count += len(to_summarize)
        # If there is a summary message, don't count it in the removed_message_count.
        if self._summary_message:
            self.removed_message_count -= 1

        # Generate summary
        self._summary_message = self._generate_summary(to_summarize, agent)
        # Assign tracking id to the summary message since it bypasses the append method.
        _ensure_tracking_id(self._summary_message)

        # Replace summarized range with protected messages + summary + remaining
        agent.messages[:] = protected_to_preserve + [self._summary_message] + remaining_messages

    def _generate_summary(self, messages: list[Message], agent: "Agent") -> Message:
        """Generate a summary of the provided messages.

        When a dedicated summarization_agent was provided at init time, it is invoked as before
        (full agent pipeline, tool execution, etc.).

        In the default case (no summarization_agent), the parent agent's *model* is called
        directly via ``model.stream()``.  This avoids re-entering the agent pipeline which
        would deadlock on ``_invocation_lock`` and corrupt metrics / traces / interrupt state.

        Args:
            messages: The messages to summarize.
            agent: The agent instance whose model will be used for summarization when no
                dedicated summarization_agent was configured.

        Returns:
            A message containing the conversation summary.

        Raises:
            Exception: If summary generation fails.
        """
        if self.summarization_agent is not None:
            return self._generate_summary_with_agent(messages)

        return self._generate_summary_with_model(messages, agent)

    # ------------------------------------------------------------------
    # Path 1 – dedicated summarization agent (backward-compatible)
    # ------------------------------------------------------------------

    def _generate_summary_with_agent(self, messages: list[Message]) -> Message:
        """Generate a summary using the dedicated summarization agent.

        Args:
            messages: The messages to summarize.

        Returns:
            A message containing the conversation summary.
        """
        summarization_agent = self.summarization_agent
        assert summarization_agent is not None  # guaranteed by caller

        original_system_prompt = summarization_agent.system_prompt
        original_messages = summarization_agent.messages.copy()
        original_tool_registry = summarization_agent.tool_registry
        original_structured_output_model = getattr(summarization_agent, "_default_structured_output_model", None)

        try:
            # Disable structured output for summarization. Summaries are plain text and
            # structured output adds toolUse blocks that are invalid in user messages.
            if hasattr(summarization_agent, "_default_structured_output_model"):
                summarization_agent._default_structured_output_model = None

            # Add no-op tool if agent has no tools to satisfy tool spec requirement
            if not summarization_agent.tool_names:
                tool_registry = ToolRegistry()
                tool_registry.register_tool(cast(AgentTool, noop_tool))
                summarization_agent.tool_registry = tool_registry

            summarization_agent.messages = messages

            result = summarization_agent("Please summarize this conversation.")
            return cast(Message, {**result.message, "role": "user"})

        finally:
            summarization_agent.system_prompt = original_system_prompt
            summarization_agent.messages = original_messages
            summarization_agent.tool_registry = original_tool_registry
            if hasattr(summarization_agent, "_default_structured_output_model"):
                summarization_agent._default_structured_output_model = original_structured_output_model

    # ------------------------------------------------------------------
    # Path 2 – default case: call model.stream() directly
    # ------------------------------------------------------------------

    def _generate_summary_with_model(self, messages: list[Message], agent: "Agent") -> Message:
        """Generate a summary by calling the agent's model directly.

        This bypasses the full agent pipeline (lock, metrics, traces, tool loop) and
        simply asks the underlying model to summarize the conversation. Delegates the
        actual model call to the shared :func:`generate_summary` helper, wrapping it in
        ``run_async`` because this method is invoked from a synchronous context.

        Args:
            messages: The messages to summarize.
            agent: The parent agent whose model is used.

        Returns:
            A message containing the conversation summary.
        """
        return run_async(lambda: generate_summary(messages, agent.model, self.summarization_system_prompt, agent=agent))

    def _adjust_split_point_for_tool_pairs(self, messages: list[Message], split_point: int) -> int:
        """Adjust the split point to avoid breaking ToolUse/ToolResult pairs.

        Thin wrapper around the shared :func:`adjust_split_point_for_tool_pairs` helper,
        kept as a method so subclasses and tests can call or override it directly.

        Args:
            messages: The full list of messages.
            split_point: The initially calculated split point.

        Returns:
            The adjusted split point that doesn't break ToolUse/ToolResult pairs.

        Raises:
            ContextWindowOverflowException: If no valid split point can be found.
        """
        return adjust_split_point_for_tool_pairs(messages, split_point)

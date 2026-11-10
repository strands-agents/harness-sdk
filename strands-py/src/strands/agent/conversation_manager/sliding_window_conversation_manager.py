"""Sliding window conversation history management."""

import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ...agent.agent import Agent

from ...hooks import BeforeModelCallEvent, HookRegistry
from ...types.content import ContentBlock, Messages
from ...types.exceptions import ContextWindowOverflowException
from ...types.tools import ToolResultContent
from .compression.context_compression import find_valid_trim_point
from .compression.pin_message import apply_pin_first, is_pinned
from .conversation_manager import ConversationManager, ProactiveCompressionConfig

logger = logging.getLogger(__name__)

_PRESERVE_CHARS = 200


class SlidingWindowConversationManager(ConversationManager):
    """Implements a sliding window strategy for managing conversation history.

    This class handles the logic of maintaining a conversation window that preserves tool usage pairs and avoids
    invalid window states.

    When truncation is enabled (the default), large tool results are partially truncated, preserving the first
    and last 200 characters, and image blocks inside tool results are replaced with descriptive text placeholders.
    Truncation targets the oldest tool results first so the most relevant recent context is preserved as long
    as possible.

    Supports proactive management during agent loop execution via the per_turn parameter.
    """

    def __init__(
        self,
        window_size: int = 40,
        should_truncate_results: bool = True,
        *,
        per_turn: bool | int = False,
        pin_first: int | None = None,
        proactive_compression: bool | ProactiveCompressionConfig | None = None,
    ):
        """Initialize the sliding window conversation manager.

        Args:
            window_size: Maximum number of messages to keep in the agent's history.
                Use 0 to clear all messages on every reduction. Defaults to 40 messages.
            should_truncate_results: Truncate tool results when a message is too large for the model's context window
            per_turn: Controls when to apply message management during agent execution.
                - False (default): Only apply management at the end (default behavior)
                - True: Apply management before every model call
                - int (e.g., 3): Apply management before every N model calls

                When to use per_turn: If your agent performs many tool operations in loops
                (e.g., web browsing with frequent screenshots), enable per_turn to proactively
                manage message history and prevent the agent loop from slowing down. Start with
                per_turn=True and adjust to a specific frequency (e.g., per_turn=5) if needed
                for performance tuning.
            pin_first: Number of messages at the start of the conversation to permanently pin.
                Pinned messages are protected from eviction during context reduction.
            proactive_compression: Enable proactive context compression before the model call.
                - ``True``: compress when 70% of the context window is used (default threshold).
                - ``{"compression_threshold": float}``: compress at the specified ratio (0, 1].
                - ``False`` or ``None``: disabled, only reactive overflow recovery is used.

        Raises:
            ValueError: If window_size is negative, or if per_turn is 0 or a negative integer.
        """
        if not isinstance(window_size, bool) and window_size < 0:
            raise ValueError(f"window_size must be a non-negative integer, got {window_size}")
        if isinstance(per_turn, int) and not isinstance(per_turn, bool) and per_turn <= 0:
            raise ValueError(f"per_turn must be a positive integer, True, or False, got {per_turn}")

        super().__init__(proactive_compression=proactive_compression)

        self.window_size = window_size
        self.should_truncate_results = should_truncate_results
        self.per_turn = per_turn
        self.pin_first = max(0, pin_first) if pin_first is not None else None
        self._pin_first_applied = False
        self._model_call_count = 0

    def register_hooks(self, registry: "HookRegistry", **kwargs: Any) -> None:
        """Register hook callbacks for per-turn conversation management.

        Args:
            registry: The hook registry to register callbacks with.
            **kwargs: Additional keyword arguments for future extensibility.
        """
        super().register_hooks(registry, **kwargs)

        # Always register the callback - per_turn check happens in the callback
        registry.add_callback(BeforeModelCallEvent, self._on_before_model_call)

    def _on_before_model_call(self, event: BeforeModelCallEvent) -> None:
        """Handle before model call event for per-turn management.

        This callback is invoked before each model call. It tracks the model call count and applies message management
        based on the per_turn configuration.

        Args:
            event: The before model call event containing the agent and model execution details.
        """
        # Check if per_turn is enabled
        if self.per_turn is False:
            return

        self._model_call_count += 1

        # Determine if we should apply management
        should_apply = False
        if self.per_turn is True:
            should_apply = True
        elif isinstance(self.per_turn, int) and self.per_turn > 0:
            should_apply = self._model_call_count % self.per_turn == 0

        if should_apply:
            logger.debug(
                "model_call_count=<%d>, per_turn=<%s> | applying per-turn conversation management",
                self._model_call_count,
                self.per_turn,
            )
            self.apply_management(event.agent)

    def get_state(self) -> dict[str, Any]:
        """Get the current state of the conversation manager.

        Returns:
            Dictionary containing the manager's state, including model call count for per-turn tracking.
        """
        state = super().get_state()
        state["model_call_count"] = self._model_call_count
        return state

    def restore_from_session(self, state: dict[str, Any]) -> list | None:
        """Restore the conversation manager's state from a session.

        Args:
            state: Previous state of the conversation manager

        Returns:
            Optional list of messages to prepend to the agent's messages.
        """
        result = super().restore_from_session(state)
        self._model_call_count = state.get("model_call_count", 0)
        return result

    def apply_management(self, agent: "Agent", **kwargs: Any) -> None:
        """Apply the sliding window to the agent's messages array to maintain a manageable history size.

        This method is called after every event loop cycle to apply a sliding window if the message count
        exceeds the window size.

        Args:
            agent: The agent whose messages will be managed.
                This list is modified in-place.
            **kwargs: Additional keyword arguments for future extensibility.
        """
        messages = agent.messages

        if len(messages) <= self.window_size:
            logger.debug(
                "message_count=<%s>, window_size=<%s> | skipping context reduction", len(messages), self.window_size
            )
            return
        self.reduce_context(agent)

    def reduce_context(self, agent: "Agent", e: Exception | None = None, **kwargs: Any) -> None:
        """Trim the oldest messages to reduce the conversation context size.

        When ``e`` is set (reactive overflow recovery), attempts to truncate large tool results
        first before falling back to message trimming.

        When ``e`` is None (proactive compression or routine management), only trims messages
        without attempting tool result truncation.

        The method handles special cases where trimming the messages leads to:
         - toolResult with no corresponding toolUse
         - toolUse with no corresponding toolResult

        Args:
            agent: The agent whose messages will be reduce.
                This list is modified in-place.
            e: The exception that triggered the context reduction, if any.
                When set, this is a reactive overflow recovery call.
                When None, this is a proactive or routine management call.
            **kwargs: Additional keyword arguments for future extensibility.

        Raises:
            ContextWindowOverflowException: If the context cannot be reduced further and a context overflow
                error was provided (e is not None). When called during routine window management or
                proactive compression (e is None), logs a warning and returns without modification.
        """
        messages = agent.messages

        # Pin first N messages permanently (only on first reduction)
        if self.pin_first and not self._pin_first_applied:
            apply_pin_first(messages, self.pin_first)
            self._pin_first_applied = True

        # window_size=0 means "remove all non-pinned messages"
        if self.window_size == 0:
            pinned = [messages[i] for i in range(len(messages)) if is_pinned(messages, i)]
            self.removed_message_count += len(messages) - len(pinned)
            messages[:] = pinned
            return

        # Try to truncate the tool result first (only for reactive overflow, not proactive compression)
        if e is not None:
            oldest_message_idx_with_tool_results = self._find_oldest_message_with_tool_results(messages)
            if oldest_message_idx_with_tool_results is not None and self.should_truncate_results:
                logger.debug(
                    "message_index=<%s> | found message with tool results at index",
                    oldest_message_idx_with_tool_results,
                )
                results_truncated = self._truncate_tool_results(messages, oldest_message_idx_with_tool_results)
                if results_truncated:
                    logger.debug("message_index=<%s> | tool results truncated", oldest_message_idx_with_tool_results)
                    return

        # Try to trim index id when tool result cannot be truncated anymore
        # If the number of messages is less than the window_size, then we default to 2, otherwise, trim to window size
        start_index = 2 if len(messages) <= self.window_size else len(messages) - self.window_size

        # Find the next valid trim point that:
        # 1. Starts with a user message (required by most model providers)
        # 2. Does not start with an orphaned toolResult
        # 3. Does not start with a toolUse unless its toolResult immediately follows
        trim_index = find_valid_trim_point(messages, start_index)

        if trim_index >= len(messages):
            # No plain user message found. Fall back to an assistant(toolUse) + user(toolResult)
            # boundary if one exists: providers treat a complete toolUse/toolResult pair as a valid
            # conversation continuation, and without this fallback tool-heavy conversations cannot be
            # trimmed. (This fallback is Python-specific and has no equivalent in find_valid_trim_point.)
            fallback_trim_index = self._find_tool_pair_trim_point(messages, start_index)
            if fallback_trim_index is not None:
                logger.debug(
                    "trim_index=<%s> | no plain user message trim point found, "
                    "falling back to assistant(toolUse) + user(toolResult) boundary",
                    fallback_trim_index,
                )
                trim_index = fallback_trim_index
            elif e is not None:
                raise ContextWindowOverflowException("Unable to trim conversation context!") from e
            else:
                logger.warning(
                    "window_size=<%s>, message_count=<%s> | unable to trim conversation context, "
                    "no valid trim point found",
                    self.window_size,
                    len(messages),
                )
                return

        # Collect non-pinned indices in [0, trim_index) to remove
        indices_to_remove = [i for i in range(trim_index) if not is_pinned(messages, i)]

        if not indices_to_remove:
            if e is not None:
                raise ContextWindowOverflowException("Unable to trim conversation context!") from e
            logger.warning(
                "window_size=<%s>, message_count=<%s> | all messages in trim range are pinned, unable to reduce",
                self.window_size,
                len(messages),
            )
            return

        self.removed_message_count += len(indices_to_remove)

        # Remove in reverse order to keep indices stable
        for i in reversed(indices_to_remove):
            del messages[i]

    def _find_tool_pair_trim_point(self, messages: Messages, start_index: int) -> int | None:
        """Find the first assistant(toolUse) + user(toolResult) boundary at or after ``start_index``.

        Used as a fallback when :func:`find_valid_trim_point` finds no plain user message. Providers
        treat a complete toolUse/toolResult pair as a valid conversation continuation, so trimming to
        such a boundary keeps tool-heavy conversations trimmable. This has no equivalent in
        ``find_valid_trim_point`` (whose behavior mirrors the TypeScript SDK).

        Args:
            messages: The full conversation message history.
            start_index: The index to begin searching from.

        Returns:
            The index of the first qualifying assistant(toolUse) message, or ``None`` if none exists.
        """
        for index in range(start_index, len(messages)):
            if (
                any("toolUse" in content for content in messages[index]["content"])
                and index + 1 < len(messages)
                and messages[index + 1]["role"] == "user"
                and any("toolResult" in content for content in messages[index + 1]["content"])
            ):
                return index
        return None

    def _truncate_tool_results(self, messages: Messages, msg_idx: int) -> bool:
        """Truncate tool results and replace image blocks in a message to reduce context size.

        For text blocks within tool results, all blocks are partially truncated unless they
        have already been truncated. The first and last _PRESERVE_CHARS characters are kept,
        and the removed middle is replaced with a notice indicating how many characters were
        removed. The tool result status is not changed.

        Image blocks nested inside tool result content are replaced with a short descriptive placeholder.

        Args:
            messages: The conversation message history.
            msg_idx: Index of the message containing tool results to truncate.

        Returns:
            True if any changes were made to the message, False otherwise.
        """
        if msg_idx >= len(messages) or msg_idx < 0:
            return False

        def _image_placeholder(image_block: Any) -> str:
            source: Any = image_block.get("source", {})
            media_type = image_block.get("format", "unknown")
            data = source.get("bytes", b"")
            return f"[image: {media_type}, {len(data) if data else 0} bytes]"

        message = messages[msg_idx]
        changes_made = False
        new_content: list[ContentBlock] = []

        for content in message.get("content", []):
            if "toolResult" in content:
                tool_result: Any = content["toolResult"]
                tool_result_items = tool_result.get("content", [])
                new_items: list[ToolResultContent] = []
                item_changed = False

                for item in tool_result_items:
                    # Replace image items nested inside toolResult content
                    if "image" in item:
                        new_items.append({"text": _image_placeholder(item["image"])})
                        item_changed = True
                        continue

                    # Partially truncate text items that have not already been truncated
                    if "text" in item:
                        text = item["text"]
                        truncation_marker = "... [truncated:"
                        if truncation_marker not in text and len(text) > 2 * _PRESERVE_CHARS:
                            prefix = text[:_PRESERVE_CHARS]
                            suffix = text[-_PRESERVE_CHARS:]
                            removed = len(text) - 2 * _PRESERVE_CHARS
                            truncated_text = (
                                f"{prefix}...\n\n... [truncated: {removed} chars removed] ...\n\n...{suffix}"
                            )
                            new_items.append({"text": truncated_text})
                            item_changed = True
                            continue

                    new_items.append(item)

                if item_changed:
                    updated_tool_result: Any = {
                        **{k: v for k, v in tool_result.items() if k != "content"},
                        "content": new_items,
                    }
                    new_content.append({"toolResult": updated_tool_result})
                    changes_made = True
                else:
                    new_content.append(content)
                continue

            new_content.append(content)

        if changes_made:
            message["content"] = new_content

        return changes_made

    def _find_oldest_message_with_tool_results(self, messages: Messages) -> int | None:
        """Find the index of the oldest message containing tool results.

        Iterates from oldest to newest so that truncation targets the least-recent
        (and therefore least relevant) tool results first. Skips pinned messages.

        Args:
            messages: The conversation message history.

        Returns:
            Index of the oldest message with tool results, or None if no such message exists.
        """
        for idx in range(len(messages)):
            if is_pinned(messages, idx):
                continue
            current_message = messages[idx]
            for content in current_message.get("content", []):
                if isinstance(content, dict) and "toolResult" in content:
                    return idx

        return None

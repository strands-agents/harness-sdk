"""Agentic context management: model-driven compression via injected tools.

.. warning:: Experimental
    This module is experimental and may change in future versions.

When an agent is created with ``context_manager="agentic"``, three tools are injected
(``summarize_context``, ``truncate_context``, ``pin_context``) that let the model manage
its own conversation history, plus a middleware that surfaces live token usage to the model
so it can decide when to compress.
"""

import logging
from dataclasses import replace
from typing import Literal

from ...._middleware.stages import InvokeModelContext
from ...._middleware.types import MiddlewareInputHandler
from ....agent.conversation_manager.compression.context_compression import (
    MessageType,
    adjust_split_point_for_tool_pairs,
    find_valid_trim_point,
    generate_summary,
    matches_message_type,
)
from ....agent.conversation_manager.compression.pin_message import is_pinned, pin_message, unpin_message
from ....models._defaults import DEFAULT_CONTEXT_WINDOW_LIMIT
from ....tools.decorator import tool
from ....types.content import Message, _ensure_tracking_id
from ....types.exceptions import ContextWindowOverflowException
from ....types.tools import ToolContext

logger = logging.getLogger(__name__)

# Default number of recent messages to preserve verbatim during summarization or truncation.
_DEFAULT_KEEP_RECENT_MESSAGES = 10
# Default fraction of oldest messages to fold into the summary.
_DEFAULT_SUMMARY_RATIO = 0.3
# Minimum allowed summary ratio (prevents near-zero compression).
_MIN_SUMMARY_RATIO = 0.1
# Maximum allowed summary ratio (prevents summarizing nearly everything).
_MAX_SUMMARY_RATIO = 0.8
# Minimum conversation length required before any compression operation can run.
_MIN_MESSAGES_FOR_COMPRESSION = 2


def _collect_preserved(
    messages: list[Message], range_end: int, filter: MessageType
) -> tuple[list[Message], list[Message]]:
    """Identify eligible messages in [0, range_end) and return (eligible, preserved) in original order.

    The first user message is always preserved to maintain a valid conversation start
    (many providers reject conversations that don't begin with a user message).

    Args:
        messages: The full conversation history.
        range_end: Exclusive upper bound of the range to consider.
        filter: Message-type filter selecting which messages are eligible for compression.

    Returns:
        A tuple of (eligible, preserved) message lists.
    """
    eligible: list[Message] = []
    preserved: list[Message] = []
    found_first_user = False

    for i in range(range_end):
        msg = messages[i]
        is_first_user = not found_first_user and msg["role"] == "user"
        if is_first_user:
            found_first_user = True

        if is_first_user or is_pinned(messages, i) or not matches_message_type(msg, filter):
            preserved.append(msg)
        else:
            eligible.append(msg)

    return eligible, preserved


@tool(context=True)
async def summarize_context(
    tool_context: ToolContext,
    keep_recent: int | None = None,
    summary_ratio: float | None = None,
    message_type: MessageType | None = None,
) -> str:
    """Compress the oldest messages in your conversation into a concise summary to free up context space.

    The summary preserves key information while reducing token usage. Recent messages are kept
    verbatim. Pinned messages are never summarized away. Often most useful with message_type
    "messages" to preserve tool results verbatim while condensing discussion.

    Args:
        keep_recent: Minimum number of recent messages to preserve verbatim. Defaults to 10.
        summary_ratio: Fraction of the oldest messages to fold into the summary (0.1-0.8). Defaults to 0.3.
        message_type: Filter which messages to target. "tools" targets only tool use/result messages,
            "messages" targets only non-tool messages, "all" (default) targets everything.
        tool_context: Injected by the framework. Not user-facing.
    """
    agent = tool_context.agent
    messages = agent.messages
    original_message_count = len(messages)
    filter: MessageType = message_type or "all"
    preserve_recent = keep_recent if keep_recent is not None else _DEFAULT_KEEP_RECENT_MESSAGES
    preserve_recent = max(_MIN_MESSAGES_FOR_COMPRESSION, preserve_recent)
    ratio = max(
        _MIN_SUMMARY_RATIO,
        min(_MAX_SUMMARY_RATIO, summary_ratio if summary_ratio is not None else _DEFAULT_SUMMARY_RATIO),
    )

    split_point = max(1, int(len(messages) * ratio))
    split_point = min(split_point, len(messages) - preserve_recent)
    if split_point <= 0:
        return (
            f"No summarization performed: not enough eligible messages to compress "
            f"(conversation has {original_message_count} messages, preserving recent {preserve_recent})."
        )

    try:
        split_point = adjust_split_point_for_tool_pairs(messages, split_point)
    except ContextWindowOverflowException:
        return (
            f"No summarization performed: no valid split boundary found from index {split_point} onward "
            f"(requires a message that isn't mid-tool-call). Try a smaller keep_recent, a larger "
            f'summary_ratio, or use truncate_context with message_type="tools" instead.'
        )

    eligible, preserved = _collect_preserved(messages, split_point, filter)

    if not eligible:
        descriptor = "eligible" if filter == "all" else f'"{filter}"'
        return (
            f"No summarization performed: no {descriptor} messages found in range "
            f"(conversation has {original_message_count} messages)."
        )

    try:
        summary_message = await generate_summary(eligible, agent.model, agent=agent)
    except Exception as err:
        return f"Summarization failed: {err}"

    # Assign tracking id to the summary message since it bypasses the append method.
    _ensure_tracking_id(summary_message)
    messages[:split_point] = preserved + [summary_message]

    removed = original_message_count - len(messages)
    label = "" if filter == "all" else f'"{filter}" '
    return f"Summarized {len(eligible)} {label}message(s). Removed {removed} message(s), {len(messages)} remaining."


@tool(context=True)
def truncate_context(
    tool_context: ToolContext,
    keep_recent: int | None = None,
    message_type: MessageType | None = None,
) -> str:
    """Drop the oldest messages from your conversation history entirely to free up context space.

    Use this when older messages are no longer relevant and do not need to be preserved in any form.
    Pinned messages are always kept. Tool-call pairs are preserved together. Often most useful with
    message_type "tools" since tool results tend to be large and lose relevance quickly.

    Args:
        keep_recent: Number of most recent messages to keep. Everything older (and unpinned) is
            dropped. Defaults to 10.
        message_type: Filter which messages to target. "tools" targets only tool use/result messages,
            "messages" targets only non-tool messages, "all" (default) targets everything.
        tool_context: Injected by the framework. Not user-facing.
    """
    agent = tool_context.agent
    messages = agent.messages
    original_message_count = len(messages)
    filter: MessageType = message_type or "all"
    window_size = keep_recent if keep_recent is not None else _DEFAULT_KEEP_RECENT_MESSAGES
    window_size = max(_MIN_MESSAGES_FOR_COMPRESSION, window_size)

    if len(messages) <= _MIN_MESSAGES_FOR_COMPRESSION or len(messages) <= window_size:
        return f"No messages dropped: conversation only has {original_message_count} messages."

    start_index = len(messages) - window_size
    trim_point = find_valid_trim_point(messages, start_index)

    if trim_point >= len(messages):
        return (
            f"No messages dropped: no valid trim boundary exists between index {start_index} and "
            f"{len(messages) - 1} (requires a plain user text message). Try a larger keep_recent or "
            f"use summarize_context instead."
        )

    eligible, preserved = _collect_preserved(messages, trim_point, filter)

    if not eligible:
        descriptor = "eligible" if filter == "all" else f'"{filter}"'
        return (
            f"No messages dropped: no {descriptor} messages found in range "
            f"(conversation has {original_message_count} messages)."
        )

    messages[:trim_point] = preserved

    dropped = original_message_count - len(messages)
    label = "" if filter == "all" else f'"{filter}" '
    return f"Dropped {dropped} {label}message(s). {len(messages)} remaining."


@tool(context=True)
def pin_context(
    tool_context: ToolContext,
    select: Literal["last_turn"] | int | list[int],
    filter: Literal["user", "assistant", "tools"] | None = None,
    action: Literal["pin", "unpin"] = "pin",
) -> str:
    """Pin or unpin messages in the conversation history.

    Pinned messages are protected from eviction during context reduction (summarize or truncate).
    Best for critical context like user-established constraints or key facts that must survive
    compression. Pin sparingly - too many pinned messages limit what can be compressed. Select
    messages using relative references: pin the current exchange, the last N messages, or specific
    indices.

    Args:
        select: Which messages to target. "last_turn" for the current exchange, a number for the
            last N messages, or an array of zero-based indices.
        filter: Narrow the selection to only messages matching this filter. "user" matches user text
            messages, "assistant" matches assistant text responses, "tools" matches tool call and
            tool result messages (pairs are always kept together).
        action: Whether to pin or unpin the selected messages. Defaults to "pin".
        tool_context: Injected by the framework. Not user-facing.
    """
    messages = tool_context.agent.messages

    if len(messages) == 0:
        return "No messages in the conversation."

    candidate_indices: list[int]

    if select == "last_turn":
        candidate_indices = []
        i = len(messages) - 1
        # Walk back through the entire turn: assistant response, tool results/calls, and the
        # initiating user message.
        while i >= 0:
            candidate_indices.append(i)
            msg = messages[i]
            # Stop after we hit a user text message (the turn boundary).
            if msg["role"] == "user" and any("text" in content for content in msg["content"]):
                break
            i -= 1
    elif isinstance(select, int):
        # Clamp to [0, len]: a negative or zero N selects nothing rather than wrapping around.
        count = min(max(0, select), len(messages))
        candidate_indices = [len(messages) - 1 - k for k in range(count)]
    else:
        # Keep only valid forward indices; negative values must not wrap to the tail.
        candidate_indices = [i for i in select if 0 <= i < len(messages)]
        if not candidate_indices:
            return f"All indices out of range (conversation has {len(messages)} messages)."

    if filter is not None:
        target_indices = [i for i in candidate_indices if _matches_pin_filter(messages[i], filter)]
    else:
        target_indices = candidate_indices

    if not target_indices:
        return "No matching messages found."

    for index in target_indices:
        if action == "pin":
            pin_message(messages, index)
        else:
            unpin_message(messages, index)

    verb = "Pinned" if action == "pin" else "Unpinned"
    return f"{verb} {len(target_indices)} message(s)."


def _matches_pin_filter(message: Message, filter: Literal["user", "assistant", "tools"]) -> bool:
    """Return True if the message matches the pin selection filter."""
    content = message["content"]
    if filter == "user":
        return message["role"] == "user" and any("text" in block for block in content)
    if filter == "assistant":
        return message["role"] == "assistant" and any("text" in block for block in content)
    if filter == "tools":
        return any("toolUse" in block or "toolResult" in block for block in content)
    return True  # type: ignore[unreachable]


def create_token_usage_middleware() -> MiddlewareInputHandler:
    """Create middleware that appends a ``<context-status>`` block to the last message.

    The block reports projected input-token usage against the context window limit of the
    model that will actually handle the call (``context.model``), so guidance stays correct
    even when middleware has redirected the call to a different model. The original messages
    are not mutated; the last message is copied and the status text appended to the copy.

    Returns:
        An async ``MiddlewareInputHandler`` for the ``InvokeModelStage.Input`` phase.
    """

    async def middleware(context: InvokeModelContext) -> InvokeModelContext:
        projected_input_tokens = context.projected_input_tokens
        if projected_input_tokens is None:
            return context

        context_window_limit = context.model.context_window_limit or DEFAULT_CONTEXT_WINDOW_LIMIT
        remaining = max(0, context_window_limit - projected_input_tokens)
        percent_used = (projected_input_tokens / context_window_limit) * 100

        status_text = (
            f"\n\n<context-status>\n"
            f"<used>{projected_input_tokens:,} / {context_window_limit:,} tokens ({percent_used:.1f}%)</used>\n"
            f"<remaining>~{remaining:,} tokens</remaining>\n"
            f"</context-status>"
        )

        messages = list(context.messages)
        if not messages:
            return context

        last_message = messages[-1]
        new_message: Message = {
            "role": last_message["role"],
            "content": [*last_message["content"], {"text": status_text}],
        }
        if "metadata" in last_message:
            new_message["metadata"] = last_message["metadata"]
        messages[-1] = new_message

        # The live token count makes this block per-call, so a cache point must stay ahead of it.
        # Only counted for a user message: elsewhere it would move the cache point off an unrelated message.
        appended = 1 if last_message["role"] == "user" else 0
        return replace(context, messages=messages, dynamic_trailing_blocks=context.dynamic_trailing_blocks + appended)

    return middleware

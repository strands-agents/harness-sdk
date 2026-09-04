"""Shared helpers for context compression strategies.

These functions are used by both the conversation managers (reactive/proactive
compression) and the agentic context-management tools (model-driven compression).
They cover the low-level mechanics: finding safe split/trim boundaries that don't
break tool-use/tool-result pairs, generating a summary via the model, and filtering
messages by type.
"""

import logging
from typing import TYPE_CHECKING, Literal, cast

from ....event_loop._auxiliary_model_call import instrument_auxiliary_model_call
from ....event_loop.streaming import process_stream
from ....types.content import Message
from ....types.exceptions import ContextWindowOverflowException

if TYPE_CHECKING:
    from ....agent import Agent
    from ....models.model import Model

logger = logging.getLogger(__name__)


DEFAULT_SUMMARIZATION_PROMPT = """You are a conversation summarizer. Provide a concise summary of the conversation \
history.

Format Requirements:
- You MUST create a structured and concise summary in bullet-point format.
- You MUST NOT respond conversationally.
- You MUST NOT address the user directly.
- You MUST NOT comment on tool availability.

Assumptions:
- You MUST NOT assume tool executions failed unless otherwise stated.

Task:
Your task is to create a structured summary document:
- It MUST contain bullet points with key topics and questions covered
- It MUST contain bullet points for all significant tools executed and their results
- It MUST contain bullet points for any code or technical information shared
- It MUST contain a section of key insights gained
- It MUST format the summary in the third person

Example format:

## Conversation Summary
* Topic 1: Key information
* Topic 2: Key information

## Tools Executed
* Tool X: Result Y"""


MessageType = Literal["tools", "messages", "all"]
"""Filter selecting which messages a compression operation targets.

- ``"tools"``: only messages containing a toolUse or toolResult block.
- ``"messages"``: only messages without any toolUse or toolResult block.
- ``"all"``: every message.
"""


def adjust_split_point_for_tool_pairs(messages: list[Message], split_point: int) -> int:
    """Adjust a split point forward to avoid breaking toolUse/toolResult pairs.

    Walks the split point forward until the message at that position is neither an
    orphaned toolResult nor a toolUse without an immediately following toolResult.

    Args:
        messages: The full list of messages.
        split_point: The initially calculated split point.

    Returns:
        The adjusted split point that doesn't break a toolUse/toolResult pair.

    Raises:
        ContextWindowOverflowException: If the split point exceeds the message array length,
            or if no valid split point can be found (walked past all messages).
    """
    if split_point > len(messages):
        raise ContextWindowOverflowException("Split point exceeds message array length")

    if split_point == len(messages):
        return split_point

    # Find the next valid split point
    while split_point < len(messages):
        if (
            # Oldest message cannot be a toolResult because it needs a toolUse preceding it
            any("toolResult" in content for content in messages[split_point]["content"])
            or (
                # Oldest message can be a toolUse only if a toolResult immediately follows it.
                any("toolUse" in content for content in messages[split_point]["content"])
                and split_point + 1 < len(messages)
                and not any("toolResult" in content for content in messages[split_point + 1]["content"])
            )
        ):
            split_point += 1
        else:
            break
    else:
        # If we didn't find a valid split point, then we throw
        raise ContextWindowOverflowException("Unable to trim conversation context!")

    return split_point


def find_valid_trim_point(messages: list[Message], start_index: int) -> int:
    """Find a valid trim point for truncation starting at ``start_index``.

    A valid trim point must:

    1. Be a user message (required by most model providers)
    2. Not be an orphaned toolResult
    3. Not be a toolUse unless its toolResult immediately follows

    Args:
        messages: The full list of messages.
        start_index: The index to begin searching from.

    Returns:
        The valid trim index, or ``len(messages)`` if none is found.
    """
    trim_index = start_index

    while trim_index < len(messages):
        message = messages[trim_index]

        if message["role"] != "user":
            trim_index += 1
            continue

        if any("toolResult" in content for content in message["content"]):
            trim_index += 1
            continue

        if any("toolUse" in content for content in message["content"]):
            next_has_tool_result = trim_index + 1 < len(messages) and any(
                "toolResult" in content for content in messages[trim_index + 1]["content"]
            )
            if not next_has_tool_result:
                trim_index += 1
                continue

        break

    return trim_index


async def generate_summary(
    messages_to_summarize: list[Message],
    model: "Model",
    system_prompt: str | None = None,
    *,
    agent: "Agent | None" = None,
) -> Message:
    """Generate a summary of the provided messages by calling the model directly.

    This bypasses the full agent pipeline (lock, traces, tool loop) and simply asks the
    underlying model to summarize the conversation. When ``agent`` is provided, the call
    fires the ``Before/AfterAuxiliaryModelCallEvent`` hook pair and its token usage rolls into
    the agent's metrics under the ``"summarization"`` source.

    Args:
        messages_to_summarize: The messages to summarize.
        model: The model used to generate the summary.
        system_prompt: Optional system prompt override. Defaults to
            :data:`DEFAULT_SUMMARIZATION_PROMPT`.
        agent: The agent this summarization runs on behalf of, used for hooks and
            metrics attribution. None leaves the call uninstrumented.

    Returns:
        A user-role message containing the model-generated summary.

    Raises:
        RuntimeError: If the model fails to produce a response.
    """
    resolved_system_prompt = system_prompt if system_prompt is not None else DEFAULT_SUMMARIZATION_PROMPT

    summarization_messages = list(messages_to_summarize) + [
        {"role": "user", "content": [{"text": "Please summarize this conversation."}]}
    ]

    chunks = model.stream(
        summarization_messages,
        tool_specs=None,
        system_prompt=resolved_system_prompt,
    )

    result_message: Message | None = None
    events = instrument_auxiliary_model_call(
        process_stream(chunks),
        source="summarization",
        agent=agent,
        messages=summarization_messages,
        model_id=model.config.get("model_id") if hasattr(model, "config") else None,
        system_prompt=resolved_system_prompt,
    )
    async for event in events:
        if "stop" in event:
            _, result_message, _, _ = event["stop"]

    if result_message is None:
        raise RuntimeError("Failed to generate summary: no response from model")

    # Return the summary as a user-role message so it's valid as conversation history
    return cast(Message, {**result_message, "role": "user"})


def matches_message_type(message: Message, filter: MessageType) -> bool:
    """Return True if the message matches the given type filter.

    Args:
        message: The message to test.
        filter: The message-type filter (``"tools"``, ``"messages"``, or ``"all"``).

    Returns:
        True if the message matches the filter.
    """
    if filter == "all":
        return True
    has_tool = any("toolUse" in content or "toolResult" in content for content in message.get("content", []))
    if filter == "tools":
        return has_tool
    if filter == "messages":
        return not has_tool
    return False  # type: ignore[unreachable]

"""Utilities for handling streaming responses from language models."""

import copy
import json
import logging
import threading
import time
import warnings
from collections.abc import AsyncGenerator, AsyncIterable
from typing import Any

from ..models.model import AgentMetadata, Model
from ..tools import InvalidToolUseNameException
from ..tools.tools import validate_tool_use_name
from ..types._events import (
    CitationStreamEvent,
    ModelStopReason,
    ModelStreamChunkEvent,
    ModelStreamEvent,
    ReasoningRedactedContentStreamEvent,
    ReasoningSignatureStreamEvent,
    ReasoningTextStreamEvent,
    TextStreamEvent,
    ToolUseStreamEvent,
    TypedEvent,
)
from ..types.citations import CitationsContentBlock
from ..types.content import ContentBlock, Message, Messages, SystemContentBlock
from ..types.streaming import (
    ContentBlockDeltaEvent,
    ContentBlockStart,
    ContentBlockStartEvent,
    MessageStartEvent,
    MessageStopEvent,
    MetadataEvent,
    Metrics,
    RedactContentEvent,
    StopReason,
    StreamEvent,
    Usage,
)
from ..types.tools import ToolSpec, ToolUse

logger = logging.getLogger(__name__)


def _normalize_messages(messages: Messages) -> Messages:
    """Remove or replace blank text in message content.

    Args:
        messages: Conversation messages to update.

    Returns:
        Updated messages.
    """
    removed_blank_message_content_text = False
    replaced_blank_message_content_text = False
    replaced_tool_names = False

    # Deep copy up front so downstream normalization can mutate freely without
    # affecting the caller's message history.
    messages = copy.deepcopy(messages)

    for message in messages:
        # only modify assistant messages
        if "role" in message and message["role"] != "assistant":
            continue
        if "content" in message:
            content = message["content"]
            if len(content) == 0:
                content.append({"text": "[blank text]"})
                continue

            has_tool_use = False

            # Ensure the tool-uses always have valid names before sending
            # https://github.com/strands-agents/harness-sdk/issues/1069
            for item in content:
                if "toolUse" in item:
                    has_tool_use = True
                    tool_use: ToolUse = item["toolUse"]

                    try:
                        validate_tool_use_name(tool_use)
                    except InvalidToolUseNameException:
                        tool_use["name"] = "INVALID_TOOL_NAME"
                        replaced_tool_names = True

            if has_tool_use:
                # Remove blank or None 'text' items for assistant messages
                before_len = len(content)
                content[:] = [
                    item
                    for item in content
                    if "text" not in item or (item["text"] is not None and item["text"].strip())
                ]
                if not removed_blank_message_content_text and before_len != len(content):
                    removed_blank_message_content_text = True
            else:
                # Replace blank or None 'text' with '[blank text]' for assistant messages
                for item in content:
                    if "text" in item and (item["text"] is None or not item["text"].strip()):
                        replaced_blank_message_content_text = True
                        item["text"] = "[blank text]"

    if removed_blank_message_content_text:
        logger.debug("removed blank message context text")
    if replaced_blank_message_content_text:
        logger.debug("replaced blank message context text")
    if replaced_tool_names:
        logger.debug("replaced invalid tool name")

    return messages


def remove_blank_messages_content_text(messages: Messages) -> Messages:
    """Remove or replace blank text in message content.

    !!deprecated!!
        This function is deprecated and will be removed in a future version.

    Args:
        messages: Conversation messages to update.

    Returns:
        Updated messages.
    """
    warnings.warn(
        "remove_blank_messages_content_text is deprecated and will be removed in a future version.",
        DeprecationWarning,
        stacklevel=2,
    )
    removed_blank_message_content_text = False
    replaced_blank_message_content_text = False

    for message in messages:
        # only modify assistant messages
        if "role" in message and message["role"] != "assistant":
            continue
        if "content" in message:
            content = message["content"]
            has_tool_use = any("toolUse" in item for item in content)
            if len(content) == 0:
                content.append({"text": "[blank text]"})
                continue

            if has_tool_use:
                # Remove blank or None 'text' items for assistant messages
                before_len = len(content)
                content[:] = [
                    item
                    for item in content
                    if "text" not in item or (item["text"] is not None and item["text"].strip())
                ]
                if not removed_blank_message_content_text and before_len != len(content):
                    removed_blank_message_content_text = True
            else:
                # Replace blank or None 'text' with '[blank text]' for assistant messages
                for item in content:
                    if "text" in item and (item["text"] is None or not item["text"].strip()):
                        replaced_blank_message_content_text = True
                        item["text"] = "[blank text]"

    if removed_blank_message_content_text:
        logger.debug("removed blank message context text")
    if replaced_blank_message_content_text:
        logger.debug("replaced blank message context text")

    return messages


def handle_message_start(event: MessageStartEvent, message: Message) -> Message:
    """Handles the start of a message by setting the role in the message dictionary.

    Args:
        event: A message start event.
        message: The message dictionary being constructed.

    Returns:
        Updated message dictionary with the role set.
    """
    message["role"] = event["role"]
    return message


def handle_content_block_start(event: ContentBlockStartEvent) -> dict[str, Any]:
    """Handles the start of a content block by extracting tool usage information if any.

    Args:
        event: Start event.

    Returns:
        Dictionary with tool use id and name if tool use request, empty dictionary otherwise.
    """
    start: ContentBlockStart = event["start"]
    current_tool_use = {}

    if "toolUse" in start and start["toolUse"]:
        tool_use_data = start["toolUse"]
        current_tool_use["toolUseId"] = tool_use_data["toolUseId"]
        current_tool_use["name"] = tool_use_data["name"]
        current_tool_use["input"] = ""
        if "reasoningSignature" in tool_use_data:
            current_tool_use["reasoningSignature"] = tool_use_data["reasoningSignature"]

    return current_tool_use


def handle_content_block_delta(
    event: ContentBlockDeltaEvent, state: dict[str, Any]
) -> tuple[dict[str, Any], ModelStreamEvent]:
    """Handles content block delta updates by appending text, tool input, or reasoning content to the state.

    Args:
        event: Delta event.
        state: The current state of message processing.

    Returns:
        Updated state with appended text or tool input.
    """
    delta_content = event["delta"]

    typed_event: ModelStreamEvent = ModelStreamEvent({})

    if "toolUse" in delta_content:
        tool_use_delta = delta_content["toolUse"]
        if "input" not in state["current_tool_use"]:
            state["current_tool_use"]["input"] = ""

        state["current_tool_use"]["input"] += tool_use_delta.get("input", "")

        # Some models emit toolUseId/name in the delta instead of contentBlockStart; keep values already set.
        for field in ("toolUseId", "name"):
            if field not in state["current_tool_use"] and field in tool_use_delta:
                state["current_tool_use"][field] = tool_use_delta[field]

        typed_event = ToolUseStreamEvent(delta_content, state["current_tool_use"])

    elif "text" in delta_content:
        state["text"] += delta_content["text"]
        typed_event = TextStreamEvent(text=delta_content["text"], delta=delta_content)

    elif "citation" in delta_content:
        if "citationsContent" not in state:
            state["citationsContent"] = []

        state["citationsContent"].append(delta_content["citation"])
        typed_event = CitationStreamEvent(delta=delta_content, citation=delta_content["citation"])

    elif "reasoningContent" in delta_content:
        if "text" in delta_content["reasoningContent"]:
            if "reasoningText" not in state:
                state["reasoningText"] = ""

            state["reasoningText"] += delta_content["reasoningContent"]["text"]
            typed_event = ReasoningTextStreamEvent(
                reasoning_text=delta_content["reasoningContent"]["text"],
                delta=delta_content,
            )

        elif "signature" in delta_content["reasoningContent"]:
            if "signature" not in state:
                state["signature"] = ""

            state["signature"] += delta_content["reasoningContent"]["signature"]
            typed_event = ReasoningSignatureStreamEvent(
                reasoning_signature=delta_content["reasoningContent"]["signature"],
                delta=delta_content,
            )

        elif redacted_content := delta_content["reasoningContent"].get("redactedContent"):
            state["redactedContent"] = state.get("redactedContent", b"") + redacted_content
            typed_event = ReasoningRedactedContentStreamEvent(redacted_content=redacted_content, delta=delta_content)

    return state, typed_event


def handle_content_block_stop(state: dict[str, Any]) -> dict[str, Any]:
    """Handles the end of a content block by finalizing tool usage, text content, or reasoning content.

    Args:
        state: The current state of message processing.

    Returns:
        Updated state with finalized content block.
    """
    content: list[ContentBlock] = state["content"]

    current_tool_use = state["current_tool_use"]
    text = state["text"]
    reasoning_text = state["reasoningText"]
    citations_content = state["citationsContent"]
    redacted_content = state.get("redactedContent")

    if current_tool_use:
        if "input" not in current_tool_use:
            current_tool_use["input"] = ""

        try:
            current_tool_use["input"] = json.loads(current_tool_use["input"])
        except ValueError:
            logger.warning(
                "tool_name=<%s>, raw_input=<%s> | failed to parse tool input json, defaulting to empty dict",
                current_tool_use.get("name", "unknown"),
                current_tool_use["input"][:200] if isinstance(current_tool_use.get("input"), str) else "",
            )
            current_tool_use["input"] = {}

        tool_use_id = current_tool_use.get("toolUseId", "")
        tool_use_name = current_tool_use.get("name", "")

        if not tool_use_id or not tool_use_name:
            # Skip, don't raise: an empty tool_uses list still appends a valid toolResult, so the loop continues.
            logger.warning(
                "tool_use_id=<%s>, tool_name=<%s> | incomplete tool use block, skipping content block "
                "(model may be using a non-standard streaming format)",
                tool_use_id,
                tool_use_name,
            )
            state["current_tool_use"] = {}
            return state

        tool_use = ToolUse(
            toolUseId=tool_use_id,
            name=tool_use_name,
            input=current_tool_use["input"],
        )
        if "reasoningSignature" in current_tool_use:
            tool_use["reasoningSignature"] = current_tool_use["reasoningSignature"]
        content.append({"toolUse": tool_use})
        state["current_tool_use"] = {}

    elif text:
        if citations_content:
            citations_block: CitationsContentBlock = {"citations": citations_content, "content": [{"text": text}]}
            content.append({"citationsContent": citations_block})
            state["citationsContent"] = []
        else:
            content.append({"text": text})
        state["text"] = ""

    elif reasoning_text or "signature" in state:
        content_block: ContentBlock = {
            "reasoningContent": {
                "reasoningText": {
                    "text": state["reasoningText"],
                }
            }
        }

        # Consume the signature so it belongs to exactly this block and does not leak into the next one.
        if (signature := state.pop("signature", None)) is not None:
            content_block["reasoningContent"]["reasoningText"]["signature"] = signature

        content.append(content_block)
        state["reasoningText"] = ""
    elif redacted_content:
        content.append({"reasoningContent": {"redactedContent": redacted_content}})
        state["redactedContent"] = b""

    return state


def handle_message_stop(event: MessageStopEvent, content: list[dict[str, Any]]) -> StopReason:
    """Handles the end of a message by returning the stop reason.

    Some models return "end_turn" even when tool calls are present, which prevents the event loop from processing
    those tool calls. This function overrides to "tool_use" so tool execution proceeds correctly.

    Args:
        event: Stop event.
        content: The message content blocks accumulated during streaming.

    Returns:
        The reason for stopping the stream.
    """
    stop_reason = event["stopReason"]

    if stop_reason == "end_turn" and any("toolUse" in item for item in content):
        logger.warning(
            "original_stop_reason=<%s>, new_stop_reason=<%s> | "
            "overriding stop reason due to toolUse blocks in response",
            "end_turn",
            "tool_use",
        )
        stop_reason = "tool_use"

    return stop_reason


def handle_redact_content(event: RedactContentEvent, state: dict[str, Any]) -> None:
    """Handles redacting content from the input or output.

    Args:
        event: Redact Content Event.
        state: The current state of message processing.
    """
    if event.get("redactAssistantContentMessage") is not None:
        state["message"]["content"] = [{"text": event["redactAssistantContentMessage"]}]


def extract_usage_metrics(event: MetadataEvent, time_to_first_byte_ms: int | None = None) -> tuple[Usage, Metrics]:
    """Extracts usage metrics from the metadata chunk.

    Args:
        event: metadata.
        time_to_first_byte_ms: time to get the first byte from the model in milliseconds

    Returns:
        The extracted usage metrics and latency.
    """
    # MetadataEvent has total=False, making all fields optional, but Usage and Metrics types
    # have Required fields. Provide defaults to handle cases where custom models don't
    # provide usage/metrics (e.g., when latency info is unavailable).
    usage = Usage(**{"inputTokens": 0, "outputTokens": 0, "totalTokens": 0, **event.get("usage", {})})
    metrics = Metrics(**{"latencyMs": 0, **event.get("metrics", {})})
    if time_to_first_byte_ms:
        metrics["timeToFirstByteMs"] = time_to_first_byte_ms

    return usage, metrics


async def process_stream(
    chunks: AsyncIterable[StreamEvent],
    start_time: float | None = None,
    cancel_signal: threading.Event | None = None,
) -> AsyncGenerator[TypedEvent, None]:
    """Processes the response stream from the API, constructing the final message and extracting usage metrics.

    Args:
        chunks: The chunks of the response stream from the model.
        start_time: Time when the model request is initiated
        cancel_signal: Optional threading.Event to check for cancellation during streaming.

    Yields:
        The reason for stopping, the constructed message, and the usage metrics.
    """
    stop_reason: StopReason = "end_turn"
    saw_message_stop = False
    first_byte_time = None

    state: dict[str, Any] = {
        "message": {"role": "assistant", "content": []},
        "text": "",
        "current_tool_use": {},
        "reasoningText": "",
        "citationsContent": [],
    }
    state["content"] = state["message"]["content"]

    usage: Usage = Usage(inputTokens=0, outputTokens=0, totalTokens=0)
    metrics: Metrics = Metrics(latencyMs=0, timeToFirstByteMs=0)

    async for chunk in chunks:
        # Check for cancellation during stream processing
        if cancel_signal and cancel_signal.is_set():
            logger.debug("cancellation detected during stream processing")
            # Return cancelled stop reason with cancellation message
            # The incomplete message in state["message"] is discarded and never added to agent.messages
            yield ModelStopReason(
                stop_reason="cancelled",
                message={"role": "assistant", "content": [{"text": "Cancelled by user"}]},
                usage=usage,
                metrics=metrics,
            )
            return

        # Track first byte time when we get first content
        if first_byte_time is None and ("contentBlockDelta" in chunk or "contentBlockStart" in chunk):
            first_byte_time = time.time()
        yield ModelStreamChunkEvent(chunk=chunk)

        if "messageStart" in chunk:
            state["message"] = handle_message_start(chunk["messageStart"], state["message"])
        elif "contentBlockStart" in chunk:
            state["current_tool_use"] = handle_content_block_start(chunk["contentBlockStart"])
        elif "contentBlockDelta" in chunk:
            state, typed_event = handle_content_block_delta(chunk["contentBlockDelta"], state)
            yield typed_event
        elif "contentBlockStop" in chunk:
            state = handle_content_block_stop(state)
        elif "messageStop" in chunk:
            saw_message_stop = True
            stop_reason = handle_message_stop(chunk["messageStop"], state["message"].get("content", []))
        elif "metadata" in chunk:
            time_to_first_byte_ms = (
                int(1000 * (first_byte_time - start_time)) if (start_time and first_byte_time) else None
            )
            usage, metrics = extract_usage_metrics(chunk["metadata"], time_to_first_byte_ms)
        elif "redactContent" in chunk:
            handle_redact_content(chunk["redactContent"], state)

    # A provider that aborts in flight ends the stream without messageStop; the in-loop check
    # above cannot see it, so report the cancellation here rather than a truncated end_turn.
    if not saw_message_stop and cancel_signal and cancel_signal.is_set():
        yield ModelStopReason(
            stop_reason="cancelled",
            message={"role": "assistant", "content": [{"text": "Cancelled by user"}]},
            usage=usage,
            metrics=metrics,
        )
        return

    yield ModelStopReason(stop_reason=stop_reason, message=state["message"], usage=usage, metrics=metrics)


async def stream_messages(
    model: Model,
    system_prompt: str | None,
    messages: Messages,
    tool_specs: list[ToolSpec],
    *,
    tool_choice: Any | None = None,
    system_prompt_content: list[SystemContentBlock] | None = None,
    invocation_state: dict[str, Any] | None = None,
    model_state: dict[str, Any] | None = None,
    dynamic_trailing_blocks: int = 0,
    cancel_signal: threading.Event | None = None,
    agent_metadata: AgentMetadata | None = None,
    **kwargs: Any,
) -> AsyncGenerator[TypedEvent, None]:
    """Streams messages to the model and processes the response.

    Args:
        model: Model provider.
        system_prompt: The system prompt string, used for backwards compatibility with models that expect it.
        messages: List of messages to send.
        tool_specs: The list of tool specs.
        tool_choice: Optional tool choice constraint for forcing specific tool usage.
        system_prompt_content: The authoritative system prompt content blocks that always contains the
            system prompt data.
        invocation_state: Caller-provided state/context that was passed to the agent when it was invoked.
        model_state: Runtime state for model providers (e.g., server-side response ids).
        dynamic_trailing_blocks: How many trailing blocks of the last user message are rebuilt on every
            call, so a provider placing cache points keeps its own ahead of them.
        cancel_signal: Optional threading.Event to check for cancellation during streaming. Also
            forwarded to the model so a provider can abort an in-flight request.
        agent_metadata: Metadata of the invoking agent, forwarded to the model.
        **kwargs: Additional keyword arguments for future extensibility.

    Yields:
        The reason for stopping, the final message, and the usage metrics
    """
    logger.debug("model=<%s> | streaming messages", model)

    messages = _normalize_messages(messages)
    # Whitelist only role and content before sending to the model provider.
    # This ensures metadata (and any future non-model fields) never leak to providers.
    messages = [Message(role=msg["role"], content=msg["content"]) for msg in messages]
    start_time = time.time()

    chunks = model.stream(
        messages,
        tool_specs if tool_specs else None,
        system_prompt,
        tool_choice=tool_choice,
        system_prompt_content=system_prompt_content,
        invocation_state=invocation_state,
        model_state=model_state,
        cancel_signal=cancel_signal,
        agent_metadata=agent_metadata,
        # Omitted when zero, so an ordinary call's arguments are unchanged.
        **({"dynamic_trailing_blocks": dynamic_trailing_blocks} if dynamic_trailing_blocks else {}),
    )

    async for event in process_stream(chunks, start_time, cancel_signal):
        yield event

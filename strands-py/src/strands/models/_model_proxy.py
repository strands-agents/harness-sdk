"""SDK-internal wrapper that sends a model call's messages in the form the model accepts.

Mirrors ``ModelProxy`` in TypeScript. The agent loop and every auxiliary model call route through it, so the stored
history is turned into what the provider receives in one place.

A ``summary`` block reaches a model whose ``model_info.capabilities.server_side_summary`` is True as it is stored;
every other model gets its text. An ``injected`` block reaches a model whose ``temporary_messages`` is True as it is
stored, and that provider sends it so the model reads it only until the next user message. Every other model, custom
ones included, gets the latest user message's injected blocks as text and none of the earlier ones. A reasoning block
with ``providerData`` reaches a model whose ``model_info.capabilities.reasoning_provider`` names its tag as it is
stored; every other model gets only its text. An offload placeholder's ``offloaded`` bookkeeping reaches no model. An
image, document, video, or audio block whose MIME type the model's ``model_info.capabilities.accepted_mime_types``
leaves out is sent as a text saying it was omitted, in a message or a tool result; a model without the list gets every
block.

A proxy for an agent's own model calls records the tools each call sends, which a summary replays to share the call's
prompt cache.
"""

import logging
import threading
import time
import weakref
from collections.abc import AsyncGenerator
from typing import TYPE_CHECKING, Any, TypeVar, cast

from pydantic import BaseModel

from ..event_loop.streaming import _normalize_messages, process_stream
from ..types._events import ModelStopReason
from ..types.content import ContentBlock, Message, Messages, SystemContentBlock
from ..types.event_loop import Metrics, Usage
from ..types.tools import ToolSpec
from ._model_info import ModelInfo, _accepts_mime_type
from ._provider_name import _model_key

if TYPE_CHECKING:
    from ..agent.agent import Agent
    from ..agent.agent_metadata import AgentMetadata
    from ..agent.invocation_context import InvocationContext
    from ..types._events import TypedEvent
    from .model import Model

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


class ModelProxy:
    """Wraps a model so each call gets the messages the model accepts.

    Args:
        model: The model to call.
        agent: The agent whose own model calls these are, which records the tools each call sends; unset for
            auxiliary calls.
    """

    def __init__(self, model: "Model", agent: "Agent | None" = None) -> None:
        """Wrap ``model``."""
        self._model = model
        self._agent = agent

    async def stream(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None,
        system_prompt: str | None,
        *,
        tool_choice: Any | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None,
        invocation_state: dict[str, Any] | None = None,
        model_state: dict[str, Any] | None = None,
        dynamic_trailing_blocks: int = 0,
        cancel_signal: threading.Event | None = None,
        agent_metadata: "AgentMetadata | None" = None,
        structured_output_model: type[BaseModel] | None = None,
        invocation_context: "InvocationContext | None" = None,
    ) -> AsyncGenerator["TypedEvent", None]:
        """Stream the model's reply and aggregate it, adding the call's usage to ``invocation_context``.

        Args:
            messages: The conversation history to send. It is never changed.
            tool_specs: The tools the model may call.
            system_prompt: The system prompt string, for models that expect it.
            tool_choice: Optional tool choice constraint.
            system_prompt_content: The system prompt content blocks.
            invocation_state: Caller-provided state passed to the agent when it was invoked.
            model_state: Runtime state for the provider, such as server-side response ids.
            dynamic_trailing_blocks: How many trailing blocks of the last user message are rebuilt on every call, so
                a provider placing cache points keeps its own ahead of them.
            cancel_signal: Event the provider checks to abort an in-flight request.
            agent_metadata: Metadata of the invoking agent.
            structured_output_model: Output model this call must produce.
            invocation_context: The request the call's usage adds to once the stream ends.

        Yields:
            The stream events, ending with the reason for stopping, the final message and the usage metrics.
        """
        if cancel_signal is not None and cancel_signal.is_set():
            logger.debug("cancellation detected before model call")
            yield ModelStopReason(
                stop_reason="cancelled",
                message={"role": "assistant", "content": [{"text": "Cancelled by user"}]},
                usage=Usage(inputTokens=0, outputTokens=0, totalTokens=0),
                metrics=Metrics(latencyMs=0),
            )
            return

        logger.debug("model=<%s> | streaming messages", self._model)
        if self._agent is not None:
            _latest_tools[self._agent] = list(tool_specs or [])
        messages = _normalize_messages(messages)
        # Only role and content reach the provider, so metadata and any future non-model fields never leak.
        messages = [Message(role=message["role"], content=message["content"]) for message in messages]
        messages, injected_trailing_blocks = self._prepare(messages)
        # The cache point stays ahead of injected text, which the next call no longer sends.
        dynamic_trailing_blocks = max(dynamic_trailing_blocks, injected_trailing_blocks)
        start_time = time.time()

        # Omitted when unset, so an ordinary call's arguments are unchanged.
        optional_kwargs: dict[str, Any] = {}
        if dynamic_trailing_blocks:
            optional_kwargs["dynamic_trailing_blocks"] = dynamic_trailing_blocks
        if structured_output_model:
            optional_kwargs["structured_output_model"] = structured_output_model

        chunks = self._model.stream(
            messages,
            tool_specs if tool_specs else None,
            system_prompt,
            tool_choice=tool_choice,
            system_prompt_content=system_prompt_content,
            invocation_state=invocation_state,
            model_state=model_state,
            cancel_signal=cancel_signal,
            agent_metadata=agent_metadata,
            **optional_kwargs,
        )
        model_key = _model_key(self._model)
        async for event in process_stream(chunks, start_time, cancel_signal, invocation_context, model_key):
            yield event

    def structured_output(
        self, output_model: type[T], messages: Messages, system_prompt: str | None = None, **kwargs: Any
    ) -> AsyncGenerator[dict[str, T | Any], None]:
        """Delegate to the model's ``structured_output``, with summary and injected blocks prepared."""
        return self._model.structured_output(
            output_model, self._prepare(messages)[0], system_prompt=system_prompt, **kwargs
        )

    async def count_tokens(self, messages: Messages, **kwargs: Any) -> int:
        """Delegate to the model's ``count_tokens`` with summary and injected blocks prepared as :meth:`stream` does.

        Args:
            messages: The messages to count.
            **kwargs: System prompt and tool specs to count with them.

        Returns:
            The model's count.
        """
        return await self._model.count_tokens(self._prepare(messages)[0], **kwargs)

    def _without_unaccepted_media(self, messages: Messages) -> Messages:
        """Send media the model doesn't accept as a text saying so; reads ``model_info`` only when there is media."""
        if not any(_has_media(block) for message in messages for block in message["content"]):
            return messages
        return _without_unaccepted_media(messages, self._model.model_info)

    def _prepare(self, messages: Messages) -> tuple[Messages, int]:
        """Return the messages the model accepts, and the trailing blocks the cache point must stay ahead of."""
        messages = self._without_unaccepted_media(
            _without_foreign_reasoning(_without_offload_marks(messages), self._model)
        )
        has_summary = any(_has_block(message, "summary") for message in messages)
        has_injected = any(_has_block(message, "injected") for message in messages)
        if not has_summary and not has_injected:
            return messages, 0
        capabilities = self._model.model_info.capabilities
        if has_summary and capabilities.server_side_summary is not True:
            messages = [
                _with_summary_text(message) if _has_block(message, "summary") else message for message in messages
            ]
        if not has_injected or capabilities.temporary_messages is True:
            return messages, 0
        return _render_injected_blocks(messages)


async def _count_request_tokens(agent: "Agent", messages: Messages) -> int:
    """Count what the next request carries: the messages, plus the system prompt and tool specs.

    The system prompt and tool specs occupy the same context window as the messages, so a utilization
    gate that leaves them out reads low. These are the same inputs behind
    ``BeforeModelCallEvent.projected_input_tokens``.

    Counts that measure a single block or a subset rather than a whole request call ``count_tokens``
    directly — including the system prompt there would inflate every block against its threshold.

    Args:
        agent: The agent whose system prompt and tool specs the request carries.
        messages: The messages the request would send.

    Returns:
        Total input token count for the request.
    """
    return await ModelProxy(agent.model).count_tokens(
        messages,
        tool_specs=agent.tool_registry.get_all_tool_specs(),
        system_prompt=agent.system_prompt,
        system_prompt_content=agent.system_prompt_content,
    )


_latest_tools: "weakref.WeakKeyDictionary[Agent, list[ToolSpec]]" = weakref.WeakKeyDictionary()
"""Each agent's latest model call tool specs, as the call passed them."""


def _latest_call_tools(agent: "Agent") -> list[ToolSpec] | None:
    """The tool specs the agent's latest model call sent.

    Args:
        agent: The agent whose calls were recorded.

    Returns:
        The tool specs, or None before the agent's first model call.
    """
    return _latest_tools.get(agent)


def _without_offload_marks(messages: Messages) -> Messages:
    """The messages with the ``offloaded`` bookkeeping dropped from every placeholder.

    To a provider a placeholder is an ordinary text block; the key records what it stood for, for retrieval and token
    accounting. A provider that passes a tool result's items through as they are would otherwise send it.
    """
    if not any(_marks_offload(block) for message in messages for block in message["content"]):
        return messages
    return [
        {**message, "content": [_without_offload_mark(block) for block in message["content"]]} for message in messages
    ]


def _without_foreign_reasoning(messages: Messages, model: "Model") -> Messages:
    """The messages with each reasoning block whose ``providerData`` names another provider reduced to its text.

    The signature, redacted payload and provider data stay out, and a block without text is left out.
    """

    def tag(block: ContentBlock) -> str | None:
        provider_data = block.get("reasoningContent", {}).get("providerData")
        return provider_data["provider"] if provider_data else None

    tags = {tag(block) for message in messages for block in message["content"]} - {None}
    # Only a call that carries tagged reasoning reads the model info.
    if not tags:
        return messages
    accepted = model.model_info.capabilities.reasoning_provider
    if tags == {accepted}:
        return messages

    def foreign(block: ContentBlock) -> bool:
        return tag(block) not in (None, accepted)

    def as_text(block: ContentBlock) -> list[ContentBlock]:
        text = block["reasoningContent"].get("reasoningText", {}).get("text")
        return [{"reasoningContent": {"reasoningText": {"text": text}}}] if text else []

    def without(message: Message) -> Message:
        content = [kept for block in message["content"] for kept in (as_text(block) if foreign(block) else [block])]
        # A turn that held only such reasoning gets the placeholder an empty assistant turn gets.
        return {**message, "content": content or [{"text": "[blank text]"}]}

    return [
        without(message) if any(foreign(block) for block in message["content"]) else message for message in messages
    ]


# The MIME type _accepts_mime_type checks for each media format; audio is ``audio/<format>``.
_MEDIA_MIME_TYPES: dict[str, dict[str, str]] = {
    "image": {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"},
    "document": {
        "pdf": "application/pdf",
        "csv": "text/csv",
        "doc": "application/msword",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls": "application/vnd.ms-excel",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "html": "text/html",
        "txt": "text/plain",
        "md": "text/markdown",
    },
    "video": {
        "flv": "video/x-flv",
        "mkv": "video/x-matroska",
        "mov": "video/quicktime",
        "mpeg": "video/mpeg",
        "mpg": "video/mpeg",
        "mp4": "video/mp4",
        "three_gp": "video/3gpp",
        "webm": "video/webm",
        "wmv": "video/x-ms-wmv",
    },
}
_MEDIA_KINDS = ("image", "document", "video", "audio")


def _has_media(block: ContentBlock) -> bool:
    """Whether a block, or an item of its tool result, is an image, document, video, or audio block."""
    items = [block, *(block.get("toolResult", {}).get("content") or [])]
    return any(kind in item for item in items for kind in _MEDIA_KINDS)


def _without_unaccepted_media(messages: Messages, info: ModelInfo) -> Messages:
    """The messages with each media block the model doesn't accept, in a message or a tool result, as a text saying so.

    Messages with nothing to replace, and the list when none has, are passed through as they are.
    """
    if not isinstance(info.capabilities.accepted_mime_types, tuple | list):
        return messages
    prepared = [_with_message_media_omitted(message, info) for message in messages]
    return messages if all(new is old for new, old in zip(prepared, messages, strict=True)) else prepared


def _with_message_media_omitted(message: Message, info: ModelInfo) -> Message:
    content = [
        _with_tool_result_media_omitted(block, info) if "toolResult" in block else _omitted_media(block, info)
        for block in message["content"]
    ]
    return (
        message
        if all(new is old for new, old in zip(content, message["content"], strict=True))
        else {**message, "content": content}
    )


def _with_tool_result_media_omitted(block: ContentBlock, info: ModelInfo) -> ContentBlock:
    tool_result = block["toolResult"]
    items = tool_result.get("content") or []
    content = [_omitted_media(cast("ContentBlock", item), info) for item in items]
    if all(new is old for new, old in zip(content, items, strict=True)):
        return block
    return cast("ContentBlock", {**block, "toolResult": {**tool_result, "content": content}})


def _omitted_media(block: ContentBlock, info: ModelInfo) -> ContentBlock:
    """The block, or a text saying it was omitted when it is media the model doesn't accept."""
    kind = next((kind for kind in _MEDIA_KINDS if kind in block), None)
    if kind is None:
        return block
    media: dict[str, Any] = cast(dict[str, Any], block)[kind]
    media_format = str(media.get("format", "")).lower()
    mime_type = f"audio/{media_format}" if kind == "audio" else _MEDIA_MIME_TYPES[kind].get(media_format)
    if mime_type is None or _accepts_mime_type(info, mime_type):
        return block
    logger.debug("mime_type=<%s> | model does not accept media type, sending a placeholder text", mime_type)
    name = f' "{media["name"]}"' if kind == "document" and media.get("name") else ""
    return ContentBlock(text=f"[{kind}{name} omitted: this model can't read {mime_type}]")


def _marks_offload(block: ContentBlock) -> bool:
    """Whether a block, or an item of a tool result, carries the ``offloaded`` key."""
    if "offloaded" in block:
        return True
    # A tool result's content is optional on the wire, so None stands in for no items.
    return any("offloaded" in item for item in block.get("toolResult", {}).get("content") or [])


def _without_offload_mark(block: ContentBlock) -> ContentBlock:
    """``block`` without the ``offloaded`` key, in the block itself and in its tool result's items."""
    stripped: dict[str, Any] = {key: value for key, value in block.items() if key != "offloaded"}
    tool_result = stripped.get("toolResult")
    # A result without items is passed through as it is, so an absent ``content`` is not turned into an empty list.
    if tool_result is not None and tool_result.get("content"):
        items = [{key: value for key, value in item.items() if key != "offloaded"} for item in tool_result["content"]]
        stripped["toolResult"] = {**tool_result, "content": items}
    return cast("ContentBlock", stripped)


def _render_injected_blocks(messages: Messages) -> tuple[Messages, int]:
    """Return the messages as a model without temporary messages receives them.

    The latest user message's injected blocks become text blocks in their place, and every other injected block is
    left out. Messages without an injected block are returned as they are, and the input is never changed.

    Args:
        messages: The messages of a model call.

    Returns:
        The messages to send, and how many trailing blocks the cache point must stay ahead of.
    """
    latest_user = _latest_user_index(messages)
    dynamic_trailing_blocks = 0
    rendered: Messages = []
    for index, message in enumerate(messages):
        if not _has_block(message, "injected"):
            rendered.append(message)
            continue
        content = message["content"]
        if index == latest_user:
            first_injected = next(position for position, block in enumerate(content) if "injected" in block)
            dynamic_trailing_blocks = len(content) - first_injected
            rendered.append({**message, "content": _with_injected_text(content)})
        else:
            rendered.append({**message, "content": [block for block in content if "injected" not in block]})
    return rendered, dynamic_trailing_blocks


def _with_injected_text(content: list[ContentBlock]) -> list[ContentBlock]:
    """The content with each injected block as a text block in its place.

    Some providers join adjacent text blocks, so injected text after other content starts with a blank line.
    """
    blocks: list[ContentBlock] = []
    for index, block in enumerate(content):
        if "injected" not in block:
            blocks.append(block)
            continue
        text = block["injected"]["text"]
        blocks.append(ContentBlock(text=f"\n\n{text}" if index > 0 and not text.startswith("\n") else text))
    return blocks


def _latest_user_index(messages: Messages) -> int:
    """Index of the latest user message, or -1 when there is none."""
    for index in range(len(messages) - 1, -1, -1):
        if messages[index]["role"] == "user":
            return index
    return -1


def _with_summary_text(message: Message) -> Message:
    content = [
        ContentBlock(text=block["summary"]["text"]) if "summary" in block else block for block in message["content"]
    ]
    return {**message, "content": content}


def _has_block(message: Message, key: str) -> bool:
    return any(key in block for block in message["content"])

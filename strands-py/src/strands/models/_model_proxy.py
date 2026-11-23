"""SDK-internal wrapper that sends a model call's messages in the form the model accepts.

Mirrors ``ModelProxy`` in TypeScript. The agent loop and every auxiliary model call route through it, so the stored
history is turned into what the provider receives in one place.

A ``summary`` block reaches a model whose ``model_info.capabilities.server_side_summary`` is True as it is stored;
every other model gets its text. An ``injected`` block reaches a model whose ``temporary_messages`` is True as it is
stored, and that provider sends it so the model reads it only until the next user message. Every other model, custom
ones included, gets the latest user message's injected blocks as text and none of the earlier ones. An offload
placeholder's ``offloaded`` bookkeeping reaches no model.

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
from ..types.content import ContentBlock, Message, Messages, SystemContentBlock
from ..types.tools import ToolSpec
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

    def _prepare(self, messages: Messages) -> tuple[Messages, int]:
        """Return the messages the model accepts, and the trailing blocks the cache point must stay ahead of."""
        messages = _without_offload_marks(messages)
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

"""Sends a model call's messages in the form the model accepts.

The one place a model call's stored history is turned into what the provider receives, as ``ModelProxy`` does in
TypeScript: every direct ``Model.stream``, ``structured_output`` and ``count_tokens`` call goes through it.

A ``summary`` block reaches a model whose ``model_info.capabilities.server_side_summary`` is True as it is stored;
every other model gets its text. An ``injected`` block reaches a model whose ``temporary_messages`` is True as it is
stored, and that provider sends it so the model reads it only until the next user message. Every other model, custom
ones included, gets the latest user message's injected blocks as text and none of the earlier ones.
"""

from typing import TYPE_CHECKING, Any

from ..types.content import ContentBlock, Message, Messages

if TYPE_CHECKING:
    from .model import Model


def prepare_request_messages(model: "Model", messages: Messages) -> tuple[Messages, int]:
    """Return the messages the model accepts, and how many trailing blocks the cache point must stay ahead of.

    Args:
        model: The model the messages are sent to.
        messages: The messages of a model call. They are never changed.

    Returns:
        The messages to send, and the trailing blocks of the latest user message, from its first injected block on,
        that the next call drops.
    """
    has_summary = any(_has_block(message, "summary") for message in messages)
    has_injected = any(_has_block(message, "injected") for message in messages)
    if not has_summary and not has_injected:
        return messages, 0
    capabilities = model.model_info.capabilities
    if has_summary and capabilities.server_side_summary is not True:
        messages = [_with_summary_text(message) if _has_block(message, "summary") else message for message in messages]
    if not has_injected or capabilities.temporary_messages is True:
        return messages, 0
    return _render_injected_blocks(messages)


async def count_tokens_as_sent(model: "Model", messages: Messages, **kwargs: Any) -> int:
    """Count the messages with the model's ``count_tokens``, in the form :func:`prepare_request_messages` sends them.

    Args:
        model: The model that counts the messages.
        messages: The messages to count.
        **kwargs: System prompt and tool specs to count with them, passed to ``count_tokens``.

    Returns:
        The model's count.
    """
    return await model.count_tokens(prepare_request_messages(model, messages)[0], **kwargs)


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

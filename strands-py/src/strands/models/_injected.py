"""Sends a model call's injected blocks in the form the model accepts.

An ``injected`` block reaches a model whose ``model_info.capabilities.temporary_messages`` is True as it is stored,
and that provider sends it so the model reads it only until the next user message. Every other model, custom ones
included, gets the latest user message's injected blocks as text and none of the earlier ones.
"""

from typing import Any

from ..types.content import ContentBlock, Message, Messages
from .model import Model, latest_user_index


def prepare_injected_blocks(model: Model, messages: Messages) -> tuple[Messages, int]:
    """Return the messages the model accepts, and how many trailing blocks the cache point must stay ahead of.

    Args:
        model: The model the messages are sent to.
        messages: The messages of a model call.

    Returns:
        The messages to send, and the trailing blocks of the latest user message, from its first injected block on,
        that the next call drops.
    """
    if not any(_has_injected_block(message) for message in messages):
        return messages, 0
    if model.model_info.capabilities.temporary_messages is True:
        return messages, 0
    return render_injected_blocks(messages)


async def count_tokens_as_sent(model: Model, messages: Messages, **kwargs: Any) -> int:
    """Count the messages with the model's ``count_tokens``, in the form :func:`prepare_injected_blocks` sends them.

    Args:
        model: The model that counts the messages.
        messages: The messages to count.
        **kwargs: System prompt and tool specs to count with them, passed to ``count_tokens``.

    Returns:
        The model's count.
    """
    return await model.count_tokens(prepare_injected_blocks(model, messages)[0], **kwargs)


def render_injected_blocks(messages: Messages) -> tuple[Messages, int]:
    """Return the messages as a model without temporary messages receives them.

    The latest user message's injected blocks become text blocks in their place, and every other injected block is
    left out. Messages without an injected block are returned as they are, and the input is never changed.

    Args:
        messages: The messages of a model call.

    Returns:
        The messages to send, and how many trailing blocks the cache point must stay ahead of.
    """
    latest_user = latest_user_index(messages)
    dynamic_trailing_blocks = 0
    rendered: Messages = []
    for index, message in enumerate(messages):
        if not _has_injected_block(message):
            rendered.append(message)
            continue
        content = message["content"]
        if index == latest_user:
            first_injected = next(i for i, block in enumerate(content) if "injected" in block)
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


def _has_injected_block(message: Message) -> bool:
    return any("injected" in block for block in message["content"])

r"""Keeps lone surrogates out of model requests.

Mirrors ``well-formed-request.ts`` in TypeScript. Python slices strings by code point, so no cut in the SDK leaves a
lone surrogate, but text can arrive with one: ``json.loads`` keeps a lone ``\ud83d`` escape, and ``os.fsdecode`` turns
bytes that are not UTF-8 into lone surrogates. Some providers reject a whole request over a single one, and clients
that encode the request as UTF-8 raise before sending it.
"""

import logging
import re
from collections.abc import Callable
from typing import Any, TypeVar

from ..types.content import ContentBlock, Message, Messages

logger = logging.getLogger(__name__)

# Python strings index code points, so a valid pair is one character outside this range.
_LONE_SURROGATE = re.compile("[\ud800-\udfff]")
_REPLACEMENT_CHARACTER = "\ufffd"

T = TypeVar("T")


def well_formed_request(messages: Messages, **fields: Any) -> tuple[Messages, dict[str, Any]]:
    """Replace lone surrogates in a model request with U+FFFD, without modifying the conversation history.

    Content is walked generically, so new content block types are covered without being registered here.

    Args:
        messages: The messages about to be sent. Only their content is repaired.
        **fields: The other request fields about to be sent, such as the system prompt and tool specs.

    Returns:
        The messages and fields to send. Anything without a lone surrogate is returned as it is rather than copied.
    """
    sent_messages = _map_changed(messages, _well_formed_message)
    sent_fields: dict[str, Any] = _well_formed(fields)
    if sent_messages is not messages or sent_fields is not fields:
        logger.warning("replaced lone surrogates in model request")
    return sent_messages, sent_fields


def _well_formed_message(message: Message) -> Message:
    content = _map_changed(message["content"], _well_formed_block)
    return message if content is message["content"] else {**message, "content": content}


def _well_formed_block(block: ContentBlock) -> ContentBlock:
    # Any edit invalidates signed reasoning.
    if block.get("reasoningContent", {}).get("reasoningText", {}).get("signature") is not None:
        return block
    result: ContentBlock = _well_formed(block)
    return result


def _well_formed(value: Any) -> Any:
    if isinstance(value, str):
        return _LONE_SURROGATE.sub(_REPLACEMENT_CHARACTER, value) if _LONE_SURROGATE.search(value) else value
    if isinstance(value, (list, tuple)):
        items = [_well_formed(item) for item in value]
        if all(new is old for new, old in zip(items, value, strict=True)):
            return value
        return items if isinstance(value, list) else tuple(items)
    if isinstance(value, dict):
        entries = [(_well_formed(key), _well_formed(item)) for key, item in value.items()]
        unchanged = all(
            key is original_key and item is original_item
            for (key, item), (original_key, original_item) in zip(entries, value.items(), strict=True)
        )
        return value if unchanged else dict(entries)
    return value


def _map_changed(values: list[T], transform: Callable[[T], T]) -> list[T]:
    result = [transform(value) for value in values]
    return values if all(new is old for new, old in zip(result, values, strict=True)) else result

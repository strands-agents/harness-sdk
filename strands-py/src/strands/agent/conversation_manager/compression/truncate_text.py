"""Last-resort text truncation for when summarization cannot reduce the context."""

import re
from collections.abc import Iterator

from ....types.content import ContentBlock, Message, Messages
from ....types.tools import ToolResultContent
from .pin_message import is_pinned

_TRUNCATION_MARKER = re.compile(r"\.\.\. \[truncated: \d+ chars removed\] \.\.\.")
_PRESERVE_CHARS = 2_000


def _text_blocks(message: Message) -> Iterator[ContentBlock | ToolResultContent]:
    """Yield every dict carrying a ``text`` key: content blocks and items inside toolResult content."""
    for content in message.get("content", []):
        if not isinstance(content, dict):
            continue  # type: ignore[unreachable]
        if "text" in content:
            yield content
        for item in content.get("toolResult", {}).get("content", []):
            if isinstance(item, dict) and "text" in item:
                yield item


def _truncate_oversized_text_blocks(messages: Messages, preserve_chars: int = _PRESERVE_CHARS) -> bool:
    """Replace every oversized, untruncated text block in non-pinned messages with a head+tail preview.

    A block qualifies when truncating it saves more than ``preserve_chars`` characters, so each call
    either shrinks the history by a meaningful amount or reports that nothing is left to truncate.

    Args:
        messages: The conversation history, modified in place.
        preserve_chars: Characters kept at each end of a truncated text.

    Returns:
        True if at least one block was truncated.
    """
    if preserve_chars <= 0:
        return False

    truncated = False
    for index, message in enumerate(messages):
        if is_pinned(messages, index):
            continue
        for block in _text_blocks(message):
            text = block["text"]
            removed = len(text) - 2 * preserve_chars
            if removed <= preserve_chars or _TRUNCATION_MARKER.search(text):
                continue
            marker = f"...\n\n... [truncated: {removed} chars removed] ...\n\n..."
            block["text"] = f"{text[:preserve_chars]}{marker}{text[-preserve_chars:]}"
            truncated = True
    return truncated

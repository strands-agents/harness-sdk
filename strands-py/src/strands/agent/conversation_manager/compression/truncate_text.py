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


def _is_truncated(block: ContentBlock | ToolResultContent) -> bool:
    return _TRUNCATION_MARKER.search(block["text"]) is not None


def _truncate_largest_text_blocks(messages: Messages, budget: int = 1, preserve_chars: int = _PRESERVE_CHARS) -> int:
    """Replace the largest untruncated text blocks in non-pinned messages with head+tail previews.

    Up to ``budget`` blocks are truncated, largest first (ties go to the oldest). Each end keeps
    ``preserve_chars`` characters, or a quarter of the block when it is shorter than ``4 * preserve_chars``,
    so every truncation drops at least half of the block. Blocks of ``preserve_chars`` or fewer characters
    are never touched, and a block is truncated at most once, keeping about ``min(len / 2, 2 * preserve_chars)``
    characters: an overflow that is still too large once every block is truncated cannot be fixed here.

    Args:
        messages: The conversation history, modified in place.
        budget: Maximum number of blocks to truncate.
        preserve_chars: Characters kept at each end of a truncated text.

    Returns:
        The number of blocks truncated.
    """
    if preserve_chars <= 0:
        return 0

    candidates = sorted(
        (
            block
            for index, message in enumerate(messages)
            if not is_pinned(messages, index)
            for block in _text_blocks(message)
            if not _is_truncated(block)
        ),
        key=lambda block: len(block["text"]),
        reverse=True,
    )
    qualifying = [block for block in candidates[:budget] if len(block["text"]) > preserve_chars]
    for block in qualifying:
        text = block["text"]
        keep = min(preserve_chars, len(text) // 4)
        removed = len(text) - 2 * keep
        marker = f"...\n\n... [truncated: {removed} chars removed] ...\n\n..."
        block["text"] = f"{text[:keep]}{marker}{text[len(text) - keep :]}"
    return len(qualifying)

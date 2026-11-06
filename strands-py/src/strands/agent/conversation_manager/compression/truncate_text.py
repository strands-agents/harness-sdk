"""Last-resort text truncation for when summarization cannot reduce the context."""

import json
import re
from collections.abc import Iterator
from typing import Any, cast

from ....types.content import ContentBlock, Message, Messages
from ....types.tools import ToolResultContent
from .pin_message import is_pinned

_TRUNCATION_MARKER = re.compile(r"\.\.\. \[truncated: \d+ chars removed\] \.\.\.")
_PRESERVE_CHARS = 2_000


def _text_blocks(message: Message) -> Iterator[ContentBlock | ToolResultContent]:
    """Yield every truncatable text or JSON block, including items inside tool results."""
    for content in message.get("content", []):
        if not isinstance(content, dict):
            continue  # type: ignore[unreachable]
        if "text" in content or "json" in content:
            yield content
        for item in content.get("toolResult", {}).get("content", []):
            if isinstance(item, dict) and ("text" in item or "json" in item):
                yield item


def _block_text(block: Any) -> str:
    if "text" in block:
        return cast(str, block["text"])
    return json.dumps(block["json"], ensure_ascii=False)


def _is_truncated(block: Any) -> bool:
    return "text" in block and _TRUNCATION_MARKER.search(block["text"]) is not None


def _truncate_block(block: Any, preserve_chars: int, minimum_removed_chars: int = 0) -> bool:
    """Replace one oversized text or JSON block with a head-and-tail text preview."""
    text = _block_text(block)
    removed = len(text) - 2 * preserve_chars
    if removed <= minimum_removed_chars or _is_truncated(block):
        return False

    marker = f"...\n\n... [truncated: {removed} chars removed] ...\n\n..."
    block.clear()
    block["text"] = f"{text[:preserve_chars]}{marker}{text[-preserve_chars:]}"
    return True


def _truncate_largest_text_blocks(messages: Messages, budget: int = 1, preserve_chars: int = _PRESERVE_CHARS) -> int:
    """Replace the largest untruncated text blocks in non-pinned messages with head+tail previews.

    Up to ``budget`` blocks are truncated, largest first (ties go to the oldest). A block qualifies when
    truncating it saves more than ``preserve_chars`` characters, so each call either shrinks the history
    by a meaningful amount or reports that nothing is left.

    Args:
        messages: The conversation history, modified in place.
        budget: Maximum number of blocks to truncate.
        preserve_chars: Characters kept at each end of a truncated block.

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
        key=lambda block: len(_block_text(block)),
        reverse=True,
    )
    truncated = 0
    for block in candidates[:budget]:
        if _truncate_block(block, preserve_chars, minimum_removed_chars=preserve_chars):
            truncated += 1
    return truncated

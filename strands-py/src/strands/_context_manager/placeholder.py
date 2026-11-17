"""Offload placeholders: the text block left where content was offloaded, and the wording of each marker it carries."""

from __future__ import annotations

from collections.abc import Sequence
from typing import cast

from ..types.content import ContentBlock
from ..types.offload import OffloadedBlock, OffloadMethod
from ..types.tools import ToolResult, ToolResultContent

_AFTER_RECEIVING = "removed from context after it was received"
"""A bare marker reads to the model as media that never arrived, so it doubts what it saw."""

REMOVED_MESSAGES = "earlier messages"
"""What a message-level marker stands for."""


def offload_placeholder(method: OffloadMethod, preview: str, stash_ref: str | None, tokens: int = 0) -> ContentBlock:
    """The block that stands in for offloaded content.

    The preview, followed by the stash reference when the original is retrievable.
    """
    offloaded = OffloadedBlock(method=method)
    if stash_ref is not None:
        offloaded["ref"] = stash_ref
    if tokens > 0:
        offloaded["tokens"] = tokens
    text = preview if stash_ref is None else f"{preview} [ref: {stash_ref}]"
    return ContentBlock(text=text, offloaded=offloaded)


def placeholder_result(tool_result: ToolResult, content: list[ContentBlock | ToolResultContent]) -> ContentBlock:
    """A tool result with ``content`` in place of its items, keeping the id and status that pair it to its tool use.

    A placeholder is a text block both content shapes carry, so it stands as a tool result item as it is.
    """
    return ContentBlock(
        toolResult=ToolResult(
            toolUseId=tool_result["toolUseId"],
            status=tool_result["status"],
            content=cast("list[ToolResultContent]", content),
        )
    )


def is_offloaded(block: ContentBlock | ToolResultContent) -> bool:
    """Whether a block is a placeholder the context manager left where it offloaded content."""
    return "offloaded" in block


def carried_tokens(blocks: Sequence[ContentBlock]) -> int:
    """The tokens the placeholders among ``blocks`` already stand for, including ones inside a tool result.

    Replacing a placeholder then reports the content behind it rather than its own few tokens.
    """
    nested: list[ContentBlock | ToolResultContent] = []
    for block in blocks:
        nested.extend(block["toolResult"]["content"] if "toolResult" in block else [block])
    return sum(block["offloaded"].get("tokens", 0) for block in nested if is_offloaded(block))


def format_dropped(tokens: int, media_kind: str | None = None) -> str:
    """Marker for a dropped block, naming the media kind when it was media."""
    return _marker("Dropped", media_kind, _approx_tokens(tokens), _AFTER_RECEIVING if media_kind else None)


def format_dropped_messages(tokens: int) -> str:
    """Marker for dropped messages of ``tokens`` in total."""
    return _marker("Dropped", REMOVED_MESSAGES, _approx_tokens(tokens))


def format_offloaded(tokens: int, media_kind: str | None = None) -> str:
    """Marker for a block replaced without a preview, naming the media kind when it was media."""
    return _marker("Offloaded", media_kind, _approx_tokens(tokens), _AFTER_RECEIVING if media_kind else None)


def format_summarized(description: str, tokens: int, summary: str | None = None) -> str:
    """Marker for summarized content, followed by the summary when there is one."""
    return _with_body(_marker("Summarized", description, _approx_tokens(tokens)), summary)


def format_truncated(block_count: int, tokens: int, preview: str) -> str:
    """Marker for ``block_count`` blocks shortened to ``preview``, followed by the preview."""
    blocks = f"{block_count} block" if block_count == 1 else f"{block_count} blocks"
    return _with_body(_marker("Truncated", blocks, _approx_tokens(tokens)), preview)


def format_elided(tokens: int) -> str:
    """Marker left where messages of ``tokens`` in total were removed from the context window."""
    details = [detail for detail in (f"{REMOVED_MESSAGES} elided", _approx_tokens(tokens)) if detail]
    return f"[... {', '.join(details)} ...]"


def _marker(label: str, *details: str | None) -> str:
    """``[Label: detail, detail]``, leaving out empty details, or ``[Label]`` when none remain."""
    shown = [detail for detail in details if detail]
    return f"[{label}: {', '.join(shown)}]" if shown else f"[{label}]"


def _approx_tokens(tokens: int) -> str:
    """The size as ``~2,525 tokens``, or empty when the token count could not measure it."""
    return f"~{tokens:,} tokens" if tokens else ""


def _with_body(header: str, body: str | None) -> str:
    return f"{header}\n\n{body}" if body else header

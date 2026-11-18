"""Truncate reduction method.

Replaces content with a preview (head, tail, or head-tail).
"""

from __future__ import annotations

import json
import math
from typing import Literal

from typing_extensions import TypedDict

from ...types.content import ContentBlock
from ...types.tools import ToolResult, ToolResultContent
from ..placeholder import format_truncated, is_offloaded

DEFAULT_PREVIEW_TOKENS = 1000
CHARS_PER_TOKEN = 4

DEFAULT_PREVIEW = "head_tail"

PREVIEW_HEAD_SHARE = {"head": 1.0, "tail": 0.0, "head_tail": 0.6}
"""Share of the preview budget kept from the head; the rest is kept from the tail."""


class TruncateConfig(TypedDict, total=False):
    """Configuration for the truncate method.

    Attributes:
        preview_tokens: Tokens of preview to keep, or, for ``Offload.truncate("*")``, of whole messages kept at the
            head and the tail. Defaults to 1,000. Content that already fits is left unchanged.
        preview: Which portion to keep. Defaults to ``"head_tail"``; for ``Offload.truncate("*")``, ``"head"`` keeps
            the oldest messages and ``"tail"`` the newest.
    """

    preview_tokens: int
    preview: Literal["head", "tail", "head_tail"]


def _resolve_preview_tokens(config: TruncateConfig | None = None) -> int:
    """The preview token budget, defaulting to 1,000."""
    raw = (config or {}).get("preview_tokens")
    if isinstance(raw, (int, float)) and not isinstance(raw, bool) and math.isfinite(raw):
        return max(0, int(raw))
    return DEFAULT_PREVIEW_TOKENS


def _head_share(config: TruncateConfig | None = None) -> float:
    """The share of the preview budget kept from the head, for the configured preview mode."""
    return PREVIEW_HEAD_SHARE.get((config or {}).get("preview", DEFAULT_PREVIEW), PREVIEW_HEAD_SHARE[DEFAULT_PREVIEW])


def _build_preview(full_text: str, block_count: int, config: TruncateConfig | None = None) -> str:
    """Build a head/tail preview of the text, or return the original if within budget."""
    preview_chars = _resolve_preview_tokens(config) * CHARS_PER_TOKEN
    total_chars = len(full_text)

    if total_chars <= preview_chars:
        return full_text

    head_chars = int(preview_chars * _head_share(config))
    tail_chars = preview_chars - head_chars
    head = full_text[:head_chars]
    tail = full_text[-tail_chars:] if tail_chars > 0 else ""
    elided = total_chars - head_chars - tail_chars
    marker = f"[... {elided:,} chars elided ...]"
    preview = "\n\n".join(part for part in [head, marker, tail] if part)

    result = format_truncated(block_count, math.ceil(total_chars / CHARS_PER_TOKEN), preview)
    return full_text if len(result) >= total_chars else result


def _truncate_tool_result_block(
    tool_result: ToolResult, config: TruncateConfig | None = None
) -> tuple[str, list[ToolResultContent]] | None:
    """Split a tool result into a preview of its text and JSON items, and the items kept as they are."""
    textual: list[str] = []
    kept: list[ToolResultContent] = []

    for content in tool_result["content"]:
        if "text" in content and not is_offloaded(content):
            textual.append(content["text"])
        elif "json" in content:
            textual.append(json.dumps(content["json"]))
        else:
            kept.append(content)

    if not textual:
        return None

    full_text = "\n".join(textual)
    preview = _build_preview(full_text, len(textual), config)
    return None if preview == full_text else (preview, kept)


def _truncate_text_block(block: ContentBlock, config: TruncateConfig | None = None) -> str | None:
    """The preview a text block is shortened to, or None when the block is already within budget."""
    preview = _build_preview(block["text"], 1, config)
    return None if preview == block["text"] else preview

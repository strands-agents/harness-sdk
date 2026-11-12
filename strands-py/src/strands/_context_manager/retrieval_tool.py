"""Retrieval tool for accessing stashed (L1) content.

Registered automatically when the ContextManager has storage configured.
"""

from __future__ import annotations

import base64
import json
import logging
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, Union, cast

from ..tools.tools import PythonAgentTool
from ..types.tools import ToolResult, ToolResultContent, ToolSpec
from ..vended_plugins.context_offloader.search import _search_content
from .content_rendering import flatten_messages_to_content
from .methods.truncate import CHARS_PER_TOKEN
from .placeholder import is_offloaded

if TYPE_CHECKING:
    from ..types.content import ContentBlock, Message, Messages
    from .stash import Stash

logger = logging.getLogger(__name__)

RETRIEVAL_TOOL_NAME = "retrieve_context"

_DEFAULT_MAX_RESULT_TOKENS = 10_000

_StashEntry = Union["ContentBlock", ToolResultContent, "Messages"]
"""What a stash entry holds: one stored block, or the messages removed together."""

_MEDIA_KEYS = ("image", "document")
"""Media a tool result can carry back, whose bytes the stash holds base64-encoded."""

_DEFAULT_CONTEXT_LINES = 5


def _create_retrieval_tool(stash: Stash, max_result_tokens: int | None = None) -> PythonAgentTool:
    """Create the ``retrieve_context`` tool backed by the given stash."""
    max_chars = (max_result_tokens or _DEFAULT_MAX_RESULT_TOKENS) * CHARS_PER_TOKEN

    async def _invoke(tool_use: dict[str, Any], **kwargs: Any) -> ToolResult:
        tool_use_id = tool_use["toolUseId"]
        inputs = tool_use.get("input", {})
        reference = str(inputs["reference"]).strip()

        entries = await _resolve_reference(stash, reference)
        if not entries:
            return _error(
                tool_use_id,
                f'reference not found: {reference}. Pass only the <id> from the placeholder\'s "[ref: <id>]".',
            )
        if any(_entry_is_offloaded(entry) for entry in entries):
            return _error(tool_use_id, f"original content for reference {reference} is no longer available")

        if inputs.get("pattern") is None and inputs.get("line_range") is None:
            return ToolResult(toolUseId=tool_use_id, status="success", content=_full_content(entries, max_chars))
        return _search_entries(tool_use_id, entries, inputs, max_chars)

    _invoke.__name__ = RETRIEVAL_TOOL_NAME

    tool_spec = ToolSpec(
        name=RETRIEVAL_TOOL_NAME,
        description=(
            "Retrieve content that was offloaded from context.\n\n"
            "When content is offloaded (truncated, dropped, or summarized), the original is "
            'persisted and the placeholder left in its place ends in "[ref: <id>]". Pass that '
            "<id> as the reference to access the original content.\n\n"
            "Options:\n"
            "  - pattern: regex/keyword to find matching lines with context\n"
            "  - line_range: { start, end } to read a specific span\n"
            "  - Without pattern/line_range: returns the full original content\n\n"
            "Examples:\n"
            '  { reference: "toolu_abc", pattern: "error" }\n'
            '  { reference: "toolu_abc", line_range: { start: 10, end: 25 } }\n'
            '  { reference: "toolu_abc" }'
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "reference": {
                    "type": "string",
                    "description": 'The <id> from the "[ref: <id>]" at the end of the offload placeholder.',
                },
                "pattern": {
                    "type": "string",
                    "description": "Regex or keyword to grep for. Returns matching lines with context.",
                },
                "line_range": {
                    "type": "object",
                    "description": "Return only this span of lines (1-indexed, inclusive).",
                    "properties": {
                        "start": {"type": "integer", "minimum": 1, "description": "First line to return."},
                        "end": {"type": "integer", "minimum": 1, "description": "Last line to return."},
                    },
                    "required": ["start", "end"],
                },
                "context_lines": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Lines of context around each match (default: 5).",
                },
            },
            "required": ["reference"],
        },
    )

    return PythonAgentTool(
        tool_name=RETRIEVAL_TOOL_NAME,
        tool_spec=tool_spec,
        tool_func=_invoke,
    )


async def _resolve_reference(stash: Stash, reference: str) -> list[_StashEntry]:
    """Resolve a reference to its stored entries.

    An id (a tool result's ``toolUseId``, or ``removed-<tracking_id>``) resolves to every entry keyed under it, in
    index order; otherwise the reference is an exact key and resolves to that entry. Ids take precedence because a
    placeholder references a tool result by id, and an id may itself end like a key (``tool_1``).
    """
    keys = await stash.keys_of(reference)
    if keys:
        stored = [await stash.retrieve(key) for key in keys]
        return [cast("_StashEntry", entry) for entry in stored if entry is not None]
    exact = await stash.retrieve(reference)
    return [cast("_StashEntry", exact)] if exact is not None else []


def _full_content(entries: list[_StashEntry], max_chars: int) -> list[ToolResultContent]:
    """The stored content itself.

    Tool result items, and removed messages rendered as role markers and their content, are returned as blocks, so
    media reaches the model as media and only their text is cut to ``max_chars``; anything else is returned as JSON.
    """
    blocks = [block for entry in entries for block in _entry_blocks(entry)]
    items = [item for item in (_as_result_item(block) for block in blocks) if item is not None]
    if len(items) == len(blocks):
        return _clip_text(items, max_chars)

    serialized = json.dumps(entries[0] if len(entries) == 1 else entries)
    text = serialized if len(serialized) <= max_chars else f"{serialized[:max_chars]}\n\n[truncated]"
    return [ToolResultContent(text=text)]


def _search_entries(
    tool_use_id: str, entries: list[_StashEntry], inputs: Mapping[str, Any], max_chars: int
) -> ToolResult:
    """The lines of the entries' text that match ``pattern`` or fall in ``line_range``."""
    text = _join_text(_entry_text(entry) for entry in entries)
    if text is None:
        return _error(tool_use_id, "cannot search non-text content. Omit pattern/line_range to retrieve full content.")

    line_range: Mapping[str, Any] | None = inputs.get("line_range")
    try:
        span = (int(line_range["start"]), int(line_range["end"])) if line_range is not None else None
    except (KeyError, TypeError, ValueError) as error:
        return _error(tool_use_id, f"invalid line_range: {error}")

    try:
        found = _search_content(
            text,
            pattern=inputs.get("pattern"),
            line_range=span,
            context_lines=inputs.get("context_lines") or _DEFAULT_CONTEXT_LINES,
            max_chars=max_chars,
        )
    except ValueError as error:
        return ToolResult(toolUseId=tool_use_id, status="error", content=[ToolResultContent(text=str(error))])
    return ToolResult(toolUseId=tool_use_id, status="success", content=[ToolResultContent(text=found)])


def _entry_blocks(entry: _StashEntry) -> list[ContentBlock | ToolResultContent]:
    """An entry as content blocks: removed messages rendered with role markers, or the stored block itself."""
    if isinstance(entry, list):
        return list(flatten_messages_to_content(entry))
    return [entry]


def _as_result_item(block: ContentBlock | ToolResultContent) -> ToolResultContent | None:
    """A block as a tool result item, media bytes decoded, or None when a tool result can't carry it."""
    # The two content shapes share their keys but not their types, so the keys are read off the mapping itself.
    data: Mapping[str, Any] = block
    media = _restore_media(data)
    if media is not None:
        return media
    for key in ("text", "json"):
        if key in data:
            return cast("ToolResultContent", {key: data[key]})
    return None


def _restore_media(data: Mapping[str, Any]) -> ToolResultContent | None:
    """A media tool result item from stash data, bytes decoded from the base64 the stash holds, or None."""
    for key in _MEDIA_KEYS:
        if key not in data:
            continue
        media = data[key]
        source = media.get("source", {})
        if isinstance(source.get("bytes"), str):
            media = {**media, "source": {**source, "bytes": base64.b64decode(source["bytes"])}}
        return cast("ToolResultContent", {key: media})
    return None


def _clip_text(items: list[ToolResultContent], max_chars: int) -> list[ToolResultContent]:
    """Cut the items' text to ``max_chars`` in total, in order.

    The item that exhausts the budget is cut and marked, later textual items are left out, and media passes through
    untouched.
    """
    budget = max_chars
    kept: list[ToolResultContent] = []
    for item in items:
        text = _block_text(item)
        if text is None or len(text) <= budget:
            budget -= len(text) if text else 0
            kept.append(item)
        elif budget > 0:
            kept.append(ToolResultContent(text=f"{text[:budget]}\n\n[truncated]"))
            budget = 0
    return kept


def _entry_text(entry: _StashEntry) -> str | None:
    """The searchable text of an entry: its text, JSON, and tool-result text, in order."""
    if isinstance(entry, list):
        return _join_text(_block_text(block) for message in entry for block in message["content"])
    return _block_text(entry)


def _block_text(block: ContentBlock | ToolResultContent) -> str | None:
    """The searchable text of a block, or None when it holds none."""
    data: Mapping[str, Any] = block
    if "text" in data:
        return cast("str", data["text"])
    if "json" in data:
        return json.dumps(data["json"], indent=2)
    if "toolResult" in data:
        return _join_text(_block_text(item) for item in data["toolResult"]["content"])
    if "citationsContent" in data:
        return _join_text(cited.get("text") for cited in data["citationsContent"].get("content", []))
    return None


def _join_text(parts: Any) -> str | None:
    """The present parts joined by newlines, or None when none of them held text."""
    present = [part for part in parts if part is not None]
    return "\n".join(present) if present else None


def _entry_is_offloaded(entry: _StashEntry) -> bool:
    """Whether an entry is a placeholder, which stands where the original content no longer is."""
    return not isinstance(entry, list) and is_offloaded(entry)


def _error(tool_use_id: str, message: str) -> ToolResult:
    return ToolResult(toolUseId=tool_use_id, status="error", content=[ToolResultContent(text=f"Error: {message}")])


def _track_retrieval_tool_use_ids(message: Message, skip_set: set[str]) -> None:
    """Track tool-use IDs from retrieve_context calls for loop prevention."""
    if message.get("role") != "assistant":
        return
    for block in message.get("content", []):
        if "toolUse" in block and block["toolUse"].get("name") == RETRIEVAL_TOOL_NAME:
            skip_set.add(block["toolUse"]["toolUseId"])

"""Retrieval tool for accessing stashed (L1) content.

Registered automatically when the ContextManager has storage configured.
"""

from __future__ import annotations

import base64
import json
import logging
from typing import TYPE_CHECKING, Any

from ..tools.tools import PythonAgentTool
from ..types.tools import ToolResult, ToolResultContent, ToolSpec
from ..vended_plugins.context_offloader.search import _search_content
from .methods.truncate import CHARS_PER_TOKEN

if TYPE_CHECKING:
    from ..types.content import Message
    from .stash import Stash

logger = logging.getLogger(__name__)

RETRIEVAL_TOOL_NAME = "retrieve_context"

_DEFAULT_MAX_RESULT_TOKENS = 10_000


_MEDIA_KEYS = frozenset({"image", "document"})


def _restore_media(data: dict[str, Any]) -> ToolResultContent | None:
    """Reconstruct a media ToolResultContent from stash data, or None if not media."""
    for key in _MEDIA_KEYS:
        if key in data:
            media = data[key]
            source = media.get("source", {})
            if isinstance(source.get("bytes"), str):
                media = {**media, "source": {**source, "bytes": base64.b64decode(source["bytes"])}}
            return ToolResultContent(**{key: media})  # type: ignore[misc]
    return None


def _extract_text(data: object) -> str | None:
    """Extract searchable text from decoded stash data."""
    if isinstance(data, str):
        return data
    if isinstance(data, dict):
        text = data.get("text")
        if isinstance(text, str):
            return text
        json_val = data.get("json")
        if json_val is not None:
            return json.dumps(json_val, indent=2)
    return None


def _create_retrieval_tool(stash: Stash, max_result_tokens: int | None = None) -> PythonAgentTool:
    """Create the ``retrieve_context`` tool backed by the given stash."""
    max_chars = (max_result_tokens or _DEFAULT_MAX_RESULT_TOKENS) * CHARS_PER_TOKEN

    async def _invoke(tool_use: dict[str, Any], **kwargs: Any) -> ToolResult:
        tool_use_id = tool_use["toolUseId"]
        inputs = tool_use.get("input", {})
        reference: str = inputs["reference"]
        pattern: str | None = inputs.get("pattern")
        line_range: dict[str, int] | None = inputs.get("line_range")
        context_lines: int | None = inputs.get("context_lines")

        result = await stash.retrieve(reference)
        if result is None:
            text = f"Error: reference not found: {reference}"
            return ToolResult(toolUseId=tool_use_id, status="error", content=[ToolResultContent(text=text)])

        if pattern is None and line_range is None:
            if isinstance(result, dict):
                media = _restore_media(result)
                if media is not None:
                    return ToolResult(toolUseId=tool_use_id, status="success", content=[media])
            full_text = json.dumps(result)
            if len(full_text) > max_chars:
                full_text = full_text[:max_chars] + "\n\n[truncated]"
            content: list[ToolResultContent] = [ToolResultContent(text=full_text)]
            return ToolResult(toolUseId=tool_use_id, status="success", content=content)

        text_content = _extract_text(result)
        if text_content is None:
            text = "Error: cannot search non-text content. Omit pattern/line_range to retrieve full content."
            return ToolResult(toolUseId=tool_use_id, status="error", content=[ToolResultContent(text=text)])

        resolved_context_lines = context_lines if context_lines is not None else 5
        line_range_pair: tuple[int, int] | None = None
        if line_range is not None:
            try:
                line_range_pair = (int(line_range["start"]), int(line_range["end"]))
            except (KeyError, TypeError, ValueError) as error:
                text = f"Error: invalid line_range: {error}"
                return ToolResult(toolUseId=tool_use_id, status="error", content=[ToolResultContent(text=text)])

        try:
            search_result = _search_content(
                text_content,
                pattern=pattern,
                line_range=line_range_pair,
                context_lines=resolved_context_lines,
                max_chars=max_chars,
            )
        except ValueError as error:
            return ToolResult(toolUseId=tool_use_id, status="error", content=[ToolResultContent(text=str(error))])
        return ToolResult(toolUseId=tool_use_id, status="success", content=[ToolResultContent(text=search_result)])

    _invoke.__name__ = RETRIEVAL_TOOL_NAME

    tool_spec = ToolSpec(
        name=RETRIEVAL_TOOL_NAME,
        description=(
            "Retrieve content that was offloaded from context.\n\n"
            "When content is offloaded (truncated, dropped, or summarized), the original is "
            "persisted and a reference key is left in its place. Use this tool with that "
            "reference to access the original content.\n\n"
            "Options:\n"
            "  - pattern: regex/keyword to find matching lines with context\n"
            "  - line_range: { start, end } to read a specific span\n"
            "  - Without pattern/line_range: returns the full original content\n\n"
            "Examples:\n"
            '  { reference: "tu_abc123_0", pattern: "error" }\n'
            '  { reference: "tu_abc123_0", line_range: { start: 10, end: 25 } }\n'
            '  { reference: "tu_abc123_0" }'
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "reference": {
                    "type": "string",
                    "description": "The reference key from the offload placeholder.",
                },
                "pattern": {
                    "type": "string",
                    "description": "Regex or keyword to grep for. Returns matching lines with context.",
                },
                "line_range": {
                    "type": "object",
                    "description": "Line range to extract (1-indexed, inclusive).",
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


def _track_retrieval_tool_use_ids(message: Message, skip_set: set[str]) -> None:
    """Track tool-use IDs from retrieve_context calls for loop prevention."""
    if message.get("role") != "assistant":
        return
    for block in message.get("content", []):
        if "toolUse" in block and block["toolUse"].get("name") == RETRIEVAL_TOOL_NAME:
            skip_set.add(block["toolUse"]["toolUseId"])

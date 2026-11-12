"""Messages and tool results rendered as content blocks that can go back into model input.

The summarize strategy renders the content it summarizes through these, and the retrieval tool renders the messages
it hands back the same way, so stored media reaches the model as media rather than as JSON.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from ..types.content import ContentBlock, Message, Messages
from ..types.tools import ToolResult, ToolResultContent

_OMITTED_KINDS = {"video": "[video omitted]", "audio": "[audio omitted]"}
"""Media a summary request or retrieval result names rather than carries."""


def _to_input_blocks(block: ContentBlock | ToolResultContent) -> list[ContentBlock]:
    """Convert a block to what a model takes as input.

    Text, images, and documents pass through, other content is rendered as text or a placeholder, and the rest is
    left out.
    """
    # The two content shapes share their keys but not their types, so the keys are read off the mapping itself.
    data: Mapping[str, Any] = block
    if "text" in data:
        return [ContentBlock(text=data["text"])]
    if "image" in data:
        return [ContentBlock(image=data["image"])]
    if "document" in data:
        return [ContentBlock(document=data["document"])]
    if "json" in data:
        return [ContentBlock(text=json.dumps(data["json"], indent=2))]
    if "citationsContent" in data:
        return [ContentBlock(text=content["text"]) for content in data["citationsContent"].get("content", [])]
    if "guardContent" in data:
        guarded = data["guardContent"].get("text")
        return [ContentBlock(text=guarded["text"] if guarded else "[image omitted]")]
    if "summary" in data:
        return [ContentBlock(text=data["summary"].get("text", ""))]
    for kind, omitted in _OMITTED_KINDS.items():
        if kind in data:
            return [ContentBlock(text=omitted)]
    return []


def tool_result_to_content_blocks(content: list[ToolResultContent]) -> list[ContentBlock]:
    """Convert a tool result's content to the content blocks a model takes as input."""
    return [rendered for item in content for rendered in _to_input_blocks(item)]


def format_tool_result_label(tool_result: ToolResult, name: str | None) -> str:
    """The label the summarizer reads before a tool result's content, such as ``[tool result: bash (error)]``."""
    status = " (error)" if tool_result["status"] == "error" else ""
    return f"[tool result: {name}{status}]" if name else f"[tool result{status}]"


def _message_to_content_blocks(message: Message, tool_names: dict[str, str]) -> list[ContentBlock]:
    """Convert a message's content to content blocks, rendering tool calls and tool result labels as text."""
    blocks: list[ContentBlock] = []
    for block in message["content"]:
        if "toolResult" in block:
            tool_result = block["toolResult"]
            label = format_tool_result_label(tool_result, tool_names.get(tool_result["toolUseId"]))
            blocks.append(ContentBlock(text=label))
            blocks.extend(tool_result_to_content_blocks(tool_result["content"]))
        elif "toolUse" in block:
            tool_use = block["toolUse"]
            blocks.append(ContentBlock(text=f"[tool call: {tool_use['name']}] {json.dumps(tool_use['input'])}"))
        else:
            blocks.extend(_to_input_blocks(block))
    return blocks


def flatten_messages_to_content(messages: Messages) -> list[ContentBlock]:
    """Flatten a range of messages into one content block list, for a summary request or a retrieval result.

    Inserts role markers and separators so the reader can tell the message boundaries. Reasoning blocks are left
    out: they are assistant-only content, and their signatures are bound to the conversation that produced them.
    Messages with nothing left get no role marker.
    """
    tool_names = {
        block["toolUse"]["toolUseId"]: block["toolUse"]["name"]
        for message in messages
        for block in message["content"]
        if "toolUse" in block
    }
    blocks: list[ContentBlock] = []
    for message in messages:
        content = _message_to_content_blocks(message, tool_names)
        if not content:
            continue
        blocks.append(ContentBlock(text=f"\n---\n[{message['role']}]"))
        blocks.extend(content)
    return blocks

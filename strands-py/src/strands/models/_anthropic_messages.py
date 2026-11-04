"""The Anthropic Messages API wire format, without the ``anthropic`` SDK.

Shared by :class:`~strands.models.anthropic.AnthropicModel` and the Bedrock InvokeModel path, so a provider that sends
Anthropic request bodies over another transport needs no ``anthropic`` dependency.
"""

import base64
import json
import logging
from typing import Any, cast
from urllib.parse import urlparse

from ..types.citations import (
    DocumentCharLocationDict,
    DocumentChunkLocationDict,
    DocumentPageLocationDict,
    SearchResultLocationDict,
    WebLocation,
    WebLocationDict,
)
from ..types.content import ContentBlock
from ..types.event_loop import Usage
from ..types.streaming import CitationsDelta, StreamEvent
from ..types.tools import ToolChoice, ToolChoiceToolDict

logger = logging.getLogger(__name__)

# Content blocks for tools Anthropic executes server side. They have no toolUse/toolResult equivalent
# (the agent never runs them), so they are not streamed.
SERVER_TOOL_BLOCK_TYPES = frozenset(
    {
        "bash_code_execution_tool_result",
        "code_execution_tool_result",
        "container_upload",
        "mcp_tool_result",
        "mcp_tool_use",
        "server_tool_use",
        "text_editor_code_execution_tool_result",
        "tool_search_tool_result",
        "web_fetch_tool_result",
        "web_search_tool_result",
    }
)

IMAGE_MEDIA_TYPES = {
    "gif": "image/gif",
    "jpeg": "image/jpeg",
    "jpg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
}

# Anthropic document sources accept only pdf (base64) and plain text; these formats are delivered as text.
TEXT_FILE_FORMATS = frozenset({"csv", "html", "md", "txt"})

# Anthropic accepts ``cache_control`` on these block types only; any other block is rejected.
# https://docs.claude.com/en/docs/build-with-claude/prompt-caching
CACHEABLE_BLOCK_TYPES = frozenset({"document", "image", "text", "tool_result", "tool_use"})

# ``ephemeral`` is the only cache type the Anthropic API supports
ANTHROPIC_CACHE_TYPE = "ephemeral"


def format_content_block(content: ContentBlock) -> dict[str, Any] | None:
    """Format an Anthropic content block.

    Args:
        content: Message content.

    Returns:
        Anthropic formatted content block, or None if Anthropic cannot accept the block.

    Raises:
        TypeError: If the content block type or document format cannot be converted to an
            Anthropic-compatible format.
    """
    if "document" in content:
        document_format = content["document"]["format"]
        if document_format == "pdf":
            source: dict[str, Any] = {
                "data": base64.b64encode(content["document"]["source"]["bytes"]).decode("utf-8"),
                "media_type": "application/pdf",
                "type": "base64",
            }
        elif document_format in TEXT_FILE_FORMATS:
            try:
                text_data = content["document"]["source"]["bytes"].decode("utf-8")
            except UnicodeDecodeError as decode_error:
                raise TypeError(
                    f"content_type=<document>, format=<{document_format}> | document is not valid utf-8 text"
                ) from decode_error
            source = {
                "data": text_data,
                "media_type": "text/plain",
                "type": "text",
            }
        else:
            raise TypeError(f"content_type=<document>, format=<{document_format}> | unsupported format")

        return {
            "source": source,
            "title": content["document"]["name"],
            "type": "document",
        }

    if "image" in content:
        image_format = content["image"]["format"]
        if image_format not in IMAGE_MEDIA_TYPES:
            raise TypeError(f"content_type=<image>, format=<{image_format}> | unsupported format")

        return {
            "source": {
                "data": base64.b64encode(content["image"]["source"]["bytes"]).decode("utf-8"),
                "media_type": IMAGE_MEDIA_TYPES[image_format],
                "type": "base64",
            },
            "type": "image",
        }

    if "reasoningContent" in content:
        reasoning_text = content["reasoningContent"].get("reasoningText", {})
        if signature := reasoning_text.get("signature"):
            return {
                "signature": signature,
                "thinking": reasoning_text.get("text", ""),
                "type": "thinking",
            }

        if redacted_content := content["reasoningContent"].get("redactedContent"):
            return {
                "data": base64.b64encode(redacted_content).decode("utf-8"),
                "type": "redacted_thinking",
            }

        # Anthropic rejects reasoning text without a signature, which is how other model families emit it.
        return None

    if "text" in content:
        return {"text": content["text"], "type": "text"}

    if "citationsContent" in content:
        text = "".join(c["text"] for c in content["citationsContent"].get("content", []) if "text" in c)
        return {"text": text, "type": "text"}

    if "toolUse" in content:
        return {
            "id": content["toolUse"]["toolUseId"],
            "input": content["toolUse"]["input"],
            "name": content["toolUse"]["name"],
            "type": "tool_use",
        }

    if "toolResult" in content:
        formatted_results = [
            format_content_block(
                {"text": json.dumps(tool_result_content["json"], ensure_ascii=False)}
                if "json" in tool_result_content
                else cast(ContentBlock, tool_result_content)
            )
            for tool_result_content in content["toolResult"]["content"]
        ]
        return {
            "content": [block for block in formatted_results if block is not None],
            "is_error": content["toolResult"]["status"] == "error",
            "tool_use_id": content["toolResult"]["toolUseId"],
            "type": "tool_result",
        }

    raise TypeError(f"content_type=<{next(iter(content))}> | unsupported type")


def format_cache_control(ttl: str | None) -> dict[str, Any]:
    """Build an Anthropic ``cache_control`` value.

    Args:
        ttl: TTL duration (e.g. "5m", "1h"). A falsy value is omitted, leaving the API default.

    Returns:
        An Anthropic cache_control dict.
    """
    cache_control: dict[str, Any] = {"type": ANTHROPIC_CACHE_TYPE}
    if ttl:
        cache_control["ttl"] = ttl
    return cache_control


def attach_cache_control(formatted_contents: list[dict[str, Any]], ttl: str | None, skip_trailing: int = 0) -> bool:
    """Mark the last already-formatted block that the API accepts ``cache_control`` on.

    Scans backwards because the nearest block may be a type the API rejects (a ``thinking`` block,
    for example) or may have been dropped in translation.

    Args:
        formatted_contents: Blocks formatted so far for the current message. Mutated in place.
        ttl: Optional TTL duration carried by the cache point.
        skip_trailing: Trailing blocks rebuilt every call; the cache point stays ahead of them, since a
            prefix that changes every call is written every call and never read.

    Returns:
        True when a block was marked, False when none of the blocks can carry a cache point.
    """
    durable = formatted_contents[: len(formatted_contents) - skip_trailing]
    for block in reversed(durable):
        if block.get("type") in CACHEABLE_BLOCK_TYPES:
            block["cache_control"] = format_cache_control(ttl)
            return True

    return False


def format_tool_choice(tool_choice: ToolChoice | None) -> dict:
    """Format a tool choice as the request's ``tool_choice`` field, or nothing when unset."""
    if tool_choice is None:
        return {}

    if "any" in tool_choice:
        return {"tool_choice": {"type": "any"}}
    elif "auto" in tool_choice:
        return {"tool_choice": {"type": "auto"}}
    elif "tool" in tool_choice:
        return {"tool_choice": {"type": "tool", "name": cast(ToolChoiceToolDict, tool_choice)["tool"]["name"]}}
    else:
        return {}


def format_citation(citation: dict[str, Any]) -> CitationsDelta:
    """Format an Anthropic citation into a Strands citation delta.

    Args:
        citation: An Anthropic citation object from a `citations_delta` event.

    Returns:
        The formatted citation delta.
    """
    formatted: CitationsDelta = {}

    if title := citation.get("title") or citation.get("document_title"):
        formatted["title"] = title

    if cited_text := citation.get("cited_text"):
        formatted["sourceContent"] = [{"text": cited_text}]

    match citation.get("type"):
        case "web_search_result_location":
            url = citation.get("url") or ""
            web: WebLocation = {"url": url}
            if domain := urlparse(url).hostname:
                web["domain"] = domain
            web_location: WebLocationDict = {"web": web}
            formatted["location"] = web_location

        case "search_result_location":
            search_location: SearchResultLocationDict = {
                "searchResultLocation": {
                    "searchResultIndex": citation.get("search_result_index", 0),
                    "start": citation.get("start_block_index", 0),
                    "end": citation.get("end_block_index", 0),
                }
            }
            formatted["location"] = search_location

        case "char_location":
            char_location: DocumentCharLocationDict = {
                "documentChar": {
                    "documentIndex": citation.get("document_index", 0),
                    "start": citation.get("start_char_index", 0),
                    "end": citation.get("end_char_index", 0),
                }
            }
            formatted["location"] = char_location

        case "page_location":
            page_location: DocumentPageLocationDict = {
                "documentPage": {
                    "documentIndex": citation.get("document_index", 0),
                    "start": citation.get("start_page_number", 0),
                    "end": citation.get("end_page_number", 0),
                }
            }
            formatted["location"] = page_location

        case "content_block_location":
            chunk_location: DocumentChunkLocationDict = {
                "documentChunk": {
                    "documentIndex": citation.get("document_index", 0),
                    "start": citation.get("start_block_index", 0),
                    "end": citation.get("end_block_index", 0),
                }
            }
            formatted["location"] = chunk_location

        case unknown_type:
            logger.warning("citation_type=<%s> | unsupported citation location | skipping", unknown_type)

    return formatted


def format_event(event: dict[str, Any]) -> StreamEvent:
    """Format an Anthropic response event into a standardized message chunk.

    Args:
        event: A response event from the Anthropic model, or a ``metadata`` event carrying the summed usage.

    Returns:
        The formatted chunk.

    Raises:
        RuntimeError: If the event or delta type is not recognized.
    """
    match event["type"]:
        case "message_start":
            return {"messageStart": {"role": "assistant"}}

        case "content_block_start":
            content = event["content_block"]

            if content["type"] == "tool_use":
                return {
                    "contentBlockStart": {
                        "contentBlockIndex": event["index"],
                        "start": {
                            "toolUse": {
                                "name": content["name"],
                                "toolUseId": content["id"],
                            }
                        },
                    }
                }

            return {"contentBlockStart": {"contentBlockIndex": event["index"], "start": {}}}

        case "content_block_delta":
            delta = _format_delta(event["delta"])
            return {"contentBlockDelta": {"contentBlockIndex": event["index"], "delta": delta}}

        case "content_block_stop":
            return {"contentBlockStop": {"contentBlockIndex": event["index"]}}

        case "message_stop":
            message = event["message"]

            return {"messageStop": {"stopReason": message["stop_reason"]}}

        case "metadata":
            return {"metadata": {"usage": _format_usage(event["usage"]), "metrics": {"latencyMs": 0}}}

        case _:
            raise RuntimeError(f"event_type=<{event['type']} | unknown type")


def _format_delta(delta: dict[str, Any]) -> Any:
    match delta["type"]:
        case "signature_delta":
            return {"reasoningContent": {"signature": delta["signature"]}}
        case "thinking_delta":
            return {"reasoningContent": {"text": delta["thinking"]}}
        case "input_json_delta":
            return {"toolUse": {"input": delta["partial_json"]}}
        case "text_delta":
            return {"text": delta["text"]}
        case "citations_delta":
            return {"citation": format_citation(delta["citation"])}
        case _:
            raise RuntimeError(f"event_type=<content_block_delta>, delta_type=<{delta['type']}> | unknown type")


def _format_usage(usage: dict[str, Any]) -> Usage:
    input_tokens = usage["input_tokens"]
    output_tokens = usage["output_tokens"]
    cache_read = usage.get("cache_read_input_tokens") or 0
    cache_write = usage.get("cache_creation_input_tokens") or 0
    # Anthropic's input_tokens excludes tokens read from or written to the cache, so the
    # billed total is the sum of all four counters.
    usage_chunk: Usage = {
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "totalTokens": input_tokens + output_tokens + cache_read + cache_write,
    }
    if cache_read:
        usage_chunk["cacheReadInputTokens"] = cache_read
    if cache_write:
        usage_chunk["cacheWriteInputTokens"] = cache_write
    return usage_chunk


class RawEventReader:
    """Turn raw Messages API stream events, as decoded JSON, into Strands stream events.

    Raw streams report the stop reason in ``message_delta`` and spread usage over ``message_start`` and
    ``message_delta``, so the reader holds both and emits ``messageStop`` and ``metadata`` from :meth:`finish`.
    """

    def __init__(self) -> None:
        """Initialize an empty reader."""
        self._skipped: set[int] = set()
        self._stop_reason: str | None = None
        self._usage: dict[str, int] = {}

    def read(self, event: dict[str, Any]) -> list[StreamEvent]:
        """Return the Strands events for one raw event."""
        event_type = event.get("type")
        if event_type == "message_start":
            self._merge_usage(event.get("message", {}).get("usage"))
            return [format_event(event)]
        if event_type == "message_delta":
            self._stop_reason = event.get("delta", {}).get("stop_reason") or self._stop_reason
            self._merge_usage(event.get("usage"))
            return []
        if event_type == "content_block_start":
            return self._read_block_start(event)
        if event_type in ("content_block_delta", "content_block_stop"):
            return self._read_block_event(event)
        return []

    def finish(self) -> list[StreamEvent]:
        """Return the closing ``messageStop`` and ``metadata`` events."""
        events: list[StreamEvent] = []
        if self._stop_reason is not None:
            events.append(format_event({"type": "message_stop", "message": {"stop_reason": self._stop_reason}}))
        if "input_tokens" in self._usage and "output_tokens" in self._usage:
            events.append(format_event({"type": "metadata", "usage": self._usage}))
        return events

    def _read_block_start(self, event: dict[str, Any]) -> list[StreamEvent]:
        block = event["content_block"]
        if block.get("type") in SERVER_TOOL_BLOCK_TYPES:
            self._skipped.add(event["index"])
            logger.debug("block_type=<%s> | skipping server-side tool block", block.get("type"))
            return []
        start = format_event(event)
        if block.get("type") != "redacted_thinking":
            return [start]
        # A redacted block arrives whole in its start event, with no deltas.
        redacted: StreamEvent = {
            "contentBlockDelta": {
                "contentBlockIndex": event["index"],
                "delta": {"reasoningContent": {"redactedContent": base64.b64decode(block.get("data", ""))}},
            }
        }
        return [start, redacted]

    def _read_block_event(self, event: dict[str, Any]) -> list[StreamEvent]:
        if event["index"] in self._skipped:
            if event["type"] == "content_block_stop":
                self._skipped.discard(event["index"])
            return []
        return [format_event(event)]

    def _merge_usage(self, usage: dict[str, Any] | None) -> None:
        # message_delta counts are cumulative, so later values replace earlier ones.
        for key, value in (usage or {}).items():
            if isinstance(value, int):
                self._usage[key] = value


def message_to_events(message: dict[str, Any]) -> list[dict[str, Any]]:
    """Rebuild the raw stream events of a complete (non-streaming) Messages API response."""
    events: list[dict[str, Any]] = [{"type": "message_start", "message": {"usage": message.get("usage") or {}}}]
    for index, block in enumerate(message.get("content") or []):
        events.extend(_block_to_events(index, block))
    stop = {"type": "message_delta", "delta": {"stop_reason": message.get("stop_reason")}, "usage": {}}
    return [*events, stop]


def _block_to_events(index: int, block: dict[str, Any]) -> list[dict[str, Any]]:
    block_type = block.get("type")
    start = {"type": "content_block_start", "index": index, "content_block": block}
    stop = {"type": "content_block_stop", "index": index}
    deltas: list[dict[str, Any]] = []
    if block_type == "text":
        deltas = [{"type": "text_delta", "text": block.get("text", "")}]
    elif block_type == "thinking":
        deltas = [
            {"type": "thinking_delta", "thinking": block.get("thinking", "")},
            {"type": "signature_delta", "signature": block.get("signature", "")},
        ]
    elif block_type == "tool_use":
        deltas = [{"type": "input_json_delta", "partial_json": json.dumps(block.get("input") or {})}]
    middle = [{"type": "content_block_delta", "index": index, "delta": delta} for delta in deltas]
    return [start, *middle, stop]

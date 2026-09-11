"""Anthropic Claude model provider.

- Docs: https://docs.anthropic.com/claude/reference/getting-started-with-the-api
- Server tools: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview
"""

import base64
import json
import logging
from collections.abc import AsyncGenerator
from typing import Any, TypeVar, cast
from urllib.parse import urlparse

import anthropic
from pydantic import BaseModel
from typing_extensions import Required, Unpack, override

from ..event_loop.streaming import process_stream
from ..tools.structured_output.structured_output_utils import convert_pydantic_to_tool_spec
from ..types.citations import (
    DocumentCharLocationDict,
    DocumentChunkLocationDict,
    DocumentPageLocationDict,
    SearchResultLocationDict,
    WebLocation,
    WebLocationDict,
)
from ..types.content import ContentBlock, Message, Messages, SystemContentBlock
from ..types.event_loop import Usage
from ..types.exceptions import ContextWindowOverflowException, ModelThrottledException
from ..types.streaming import CitationsDelta, StreamEvent
from ..types.tools import ToolChoice, ToolChoiceToolDict, ToolSpec
from ._defaults import resolve_config_metadata
from ._validation import _has_location_source, _warn_on_deprecated_cache_tools, validate_config_keys
from .model import BaseModelConfig, CacheConfig, CacheToolsConfig, Model

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

# Content blocks for tools Anthropic executes server side. They have no toolUse/toolResult equivalent
# (the agent never runs them), so they are not streamed.
_SERVER_TOOL_BLOCK_TYPES = frozenset(
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

# Anthropic pauses a long server-side tool turn with stop_reason=pause_turn and expects the paused
# assistant message to be sent back as-is to resume it. Bounds how many times stream() does so.
_MAX_PAUSE_TURN_CONTINUATIONS = 10

_IMAGE_MEDIA_TYPES = {
    "gif": "image/gif",
    "jpeg": "image/jpeg",
    "jpg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
}

# Anthropic document sources accept only pdf (base64) and plain text; these formats are delivered as text.
_TEXT_FILE_FORMATS = frozenset({"csv", "html", "md", "txt"})

# Anthropic accepts ``cache_control`` on these block types only; any other block is rejected.
# https://docs.claude.com/en/docs/build-with-claude/prompt-caching
_CACHEABLE_BLOCK_TYPES = frozenset({"document", "image", "text", "tool_result", "tool_use"})

# ``ephemeral`` is the only cache type the Anthropic API supports
_ANTHROPIC_CACHE_TYPE = "ephemeral"


class AnthropicModel(Model):
    """Anthropic model provider implementation."""

    EVENT_TYPES = {
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_stop",
    }

    OVERFLOW_MESSAGES = {
        "prompt is too long:",
        "input is too long",
        "input length exceeds context window",
        "input and output tokens exceed your context limit",
    }

    class AnthropicConfig(BaseModelConfig, total=False):
        """Configuration options for Anthropic models.

        Attributes:
            cache_config: Configuration for prompt caching. Adds a cache point to the last user message,
                caching everything before it. Caching is off when unset.
            cache_tools: Caches the tool definitions (deprecated, use CacheConfig(tools_ttl=...)). Superseded
                by an explicitly set cache_config.tools_ttl.
            max_tokens: Maximum number of tokens to generate.
            model_id: Calude model ID (e.g., "claude-3-7-sonnet-latest").
                For a complete list of supported models, see
                https://docs.anthropic.com/en/docs/about-claude/models/all-models.
            params: Additional model parameters (e.g., temperature).
                For a complete list of supported parameters, see https://docs.anthropic.com/en/api/messages.
            anthropic_tools: Anthropic-specific server-side tools that are not function tools
                (e.g., web_search, web_fetch, code_execution). Appended alongside the agent's function tools.
                Use the standard tools interface for function calling tools.
                For a complete list of supported tools, see
                https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview
            use_native_token_count: Whether to use the native Anthropic count_tokens API.
                When True, count_tokens() calls the Anthropic API for accurate counts.
                When False (default), skips the API call and uses the local estimator.
        """

        cache_config: CacheConfig | None
        cache_tools: str | CacheToolsConfig | None
        max_tokens: Required[int]
        model_id: Required[str]
        params: dict[str, Any] | None
        anthropic_tools: list[dict[str, Any]]
        use_native_token_count: bool

    def __init__(self, *, client_args: dict[str, Any] | None = None, **model_config: Unpack[AnthropicConfig]):
        """Initialize provider instance.

        Args:
            client_args: Arguments for the underlying Anthropic client (e.g., api_key).
                For a complete list of supported arguments, see https://docs.anthropic.com/en/api/client-sdks.
            **model_config: Configuration options for the Anthropic model.
        """
        validate_config_keys(model_config, self.AnthropicConfig)
        _warn_on_deprecated_cache_tools(model_config, stacklevel=3)
        self.config = AnthropicModel.AnthropicConfig(**model_config)

        if "anthropic_tools" in self.config:
            self._validate_anthropic_tools(self.config["anthropic_tools"])

        logger.debug("config=<%s> | initializing", self.config)

        client_args = client_args or {}
        self.client = anthropic.AsyncAnthropic(**client_args)

    @override
    def update_config(self, **model_config: Unpack[AnthropicConfig]) -> None:  # type: ignore[override]
        """Update the Anthropic model configuration with the provided arguments.

        Args:
            **model_config: Configuration overrides.
        """
        validate_config_keys(model_config, self.AnthropicConfig)

        if "anthropic_tools" in model_config:
            self._validate_anthropic_tools(model_config["anthropic_tools"])

        _warn_on_deprecated_cache_tools(model_config, stacklevel=3)
        self.config.update(model_config)

    @override
    def get_config(self) -> AnthropicConfig:
        """Get the Anthropic model configuration.

        Returns:
            The Anthropic model configuration.
        """
        return resolve_config_metadata(self.config, self.config["model_id"])

    def _format_request_message_content(self, content: ContentBlock) -> dict[str, Any]:
        """Format an Anthropic content block.

        Args:
            content: Message content.

        Returns:
            Anthropic formatted content block.

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
            elif document_format in _TEXT_FILE_FORMATS:
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
            if image_format not in _IMAGE_MEDIA_TYPES:
                raise TypeError(f"content_type=<image>, format=<{image_format}> | unsupported format")

            return {
                "source": {
                    "data": base64.b64encode(content["image"]["source"]["bytes"]).decode("utf-8"),
                    "media_type": _IMAGE_MEDIA_TYPES[image_format],
                    "type": "base64",
                },
                "type": "image",
            }

        if "reasoningContent" in content:
            return {
                "signature": content["reasoningContent"]["reasoningText"]["signature"],
                "thinking": content["reasoningContent"]["reasoningText"]["text"],
                "type": "thinking",
            }

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
            return {
                "content": [
                    self._format_request_message_content(
                        {"text": json.dumps(tool_result_content["json"], ensure_ascii=False)}
                        if "json" in tool_result_content
                        else cast(ContentBlock, tool_result_content)
                    )
                    for tool_result_content in content["toolResult"]["content"]
                ],
                "is_error": content["toolResult"]["status"] == "error",
                "tool_use_id": content["toolResult"]["toolUseId"],
                "type": "tool_result",
            }

        raise TypeError(f"content_type=<{next(iter(content))}> | unsupported type")

    def _format_request_messages(
        self, messages: Messages, cache_target_idx: int | None = None, dynamic_trailing_blocks: int = 0
    ) -> list[dict[str, Any]]:
        """Format an Anthropic messages array.

        Args:
            messages: List of message objects to be processed by the model.
            cache_target_idx: Index of the message that owns the managed cache point while
                ``cache_config`` is set. Automatic placement applies to that message only when nothing in
                it already carries the cache point.
            dynamic_trailing_blocks: How many trailing blocks of the cache-target message are rebuilt on
                every call, so the cache point stays ahead of them.

        Returns:
            An Anthropic messages array.
        """
        cache_config = self.config.get("cache_config")
        configured_ttl = cache_config.ttl if cache_config else None
        formatted_messages = []

        for message_idx, message in enumerate(messages):
            formatted_contents: list[dict[str, Any]] = []
            marked = False

            for content in message["content"]:
                if "cachePoint" in content:
                    ttl = content["cachePoint"].get("ttl")
                    if not ttl and message_idx == cache_target_idx:
                        ttl = configured_ttl

                    if self._attach_cache_control(formatted_contents, ttl):
                        marked = True
                    elif message_idx == cache_target_idx:
                        logger.warning(
                            "msg_idx=<%d> | nothing ahead of the placed cache point can carry one, "
                            "falling back to automatic placement",
                            message_idx,
                        )
                    else:
                        logger.warning("no preceding block accepts a cache point | skipped cache point")
                    continue

                # Check for location sources in image, document, or video content
                if _has_location_source(content):
                    logger.warning("Location sources are not supported by Anthropic | skipping content block")
                    continue

                formatted_contents.append(self._format_request_message_content(content))

            # Automatic placement runs once the whole message is formatted, so the cache point lands on a
            # block that survived translation. It is skipped when a caller-placed point already marked one.
            # Per-call trailing blocks apply only to the cache-target message, which is where a producer
            # appends content rebuilt every call.
            if message_idx == cache_target_idx and not marked:
                if self._attach_cache_control(formatted_contents, configured_ttl, dynamic_trailing_blocks):
                    logger.debug("msg_idx=<%d> | added cache point to last user message", message_idx)
                else:
                    logger.debug("msg_idx=<%d> | no cacheable content block, skipped cache point", message_idx)

            if formatted_contents:
                formatted_messages.append({"content": formatted_contents, "role": message["role"]})

        return formatted_messages

    @classmethod
    def _attach_cache_control(
        cls, formatted_contents: list[dict[str, Any]], ttl: str | None, skip_trailing: int = 0
    ) -> bool:
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
            if block.get("type") in _CACHEABLE_BLOCK_TYPES:
                block["cache_control"] = cls._format_cache_control(ttl)
                return True

        return False

    def _resolve_tools_cache(self) -> dict[str, Any] | None:
        """Return the Anthropic ``cache_control`` payload for tool definitions, if enabled.

        An explicitly set ``cache_config.tools_ttl`` takes precedence; when it is left unset (None) the
        deprecated model-level ``cache_tools`` applies instead so existing configs keep working.
        """
        cache_config = self.config.get("cache_config")
        if cache_config is None or cache_config.tools_ttl is None:
            return self._resolve_deprecated_cache_tools()

        if cache_config.tools_ttl is False or cache_config.strategy not in ("auto", "anthropic"):
            return None

        tools_ttl = cache_config.tools_ttl
        ttl = tools_ttl if isinstance(tools_ttl, str) else cache_config.ttl
        return self._format_cache_control(ttl)

    def _resolve_deprecated_cache_tools(self) -> dict[str, Any] | None:
        """Resolve tool caching from the deprecated model-level ``cache_tools`` option.

        Reached only when ``cache_config.tools_ttl`` is unset; an explicit ``tools_ttl`` supersedes this path.
        """
        cache_tools = self.config.get("cache_tools")
        if not cache_tools:
            return None

        ttl = cache_tools.ttl if isinstance(cache_tools, CacheToolsConfig) else None
        if not ttl:
            cache_config = self.config.get("cache_config")
            if cache_config and cache_config.ttl and cache_config.strategy in ("auto", "anthropic"):
                ttl = cache_config.ttl
        return self._format_cache_control(ttl)

    @staticmethod
    def _format_cache_control(ttl: str | None) -> dict[str, Any]:
        """Build an Anthropic ``cache_control`` value.

        Args:
            ttl: TTL duration (e.g. "5m", "1h"). A falsy value is omitted, leaving the API default.

        Returns:
            An Anthropic cache_control dict.
        """
        cache_control: dict[str, Any] = {"type": _ANTHROPIC_CACHE_TYPE}
        if ttl:
            cache_control["ttl"] = ttl
        return cache_control

    def _manage_cache_points(self, messages: Messages) -> tuple[Messages, int | None]:
        """Return a copy of messages carrying at most one cache point, and the message that owns it.

        A cache point in the last user message is kept where it sits; extras there, and points in earlier
        messages, are stripped so they cannot accumulate one per turn against the API's shared budget.

        Args:
            messages: List of message objects to manage cache points for.

        Returns:
            A new list of messages and the index of the message that owns the cache point, or None when no
            user message can carry one. The input is never modified.
        """
        cache_config = self.config.get("cache_config")
        if not cache_config:
            return messages, None

        if cache_config.strategy not in ("auto", "anthropic"):
            logger.warning("strategy=<%s> | unknown cache strategy, prompt caching disabled", cache_config.strategy)
            return messages, None

        target_idx = next(
            (
                idx
                for idx in reversed(range(len(messages)))
                if messages[idx]["role"] == "user"
                and any("cachePoint" not in block for block in messages[idx]["content"])
            ),
            None,
        )
        if target_idx is None:
            logger.debug("no user message with content | skipped cache point")

        copied: list[Message] = []
        stripped = 0
        for msg_idx, message in enumerate(messages):
            content: list[ContentBlock] = []
            honored = False
            for block in message["content"]:
                if "cachePoint" not in block:
                    content.append(block)
                elif msg_idx == target_idx and not honored:
                    honored = True
                    content.append(block)
                else:
                    stripped += 1
            copied.append({"role": message["role"], "content": content})

        if stripped:
            logger.warning(
                "count=<%d> | stripped extra cache points, cache_config keeps the first cache point in the "
                "last user message; unset cache_config to keep every cache point",
                stripped,
            )

        return copied, target_idx

    def format_request(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        tool_choice: ToolChoice | None = None,
        dynamic_trailing_blocks: int = 0,
        *,
        system_prompt_content: list[SystemContentBlock] | None = None,
    ) -> dict[str, Any]:
        """Format an Anthropic streaming request.

        Args:
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            system_prompt: Plain string system prompt. Ignored when system_prompt_content is provided.
            tool_choice: Selection strategy for tool invocation.
            dynamic_trailing_blocks: How many trailing blocks of the last user message are rebuilt on
                every call, so the cache point stays ahead of them.
            system_prompt_content: Structured system prompt content blocks, which can carry a cache point.

        Returns:
            An Anthropic streaming request.

        Raises:
            TypeError: If a message contains a content block type that cannot be converted to an Anthropic-compatible
                format.
        """
        messages, cache_target_idx = self._manage_cache_points(messages)

        tools: list[dict[str, Any]] = [
            {
                "name": tool_spec["name"],
                "description": tool_spec["description"],
                "input_schema": tool_spec["inputSchema"]["json"],
            }
            for tool_spec in tool_specs or []
        ]

        params = self.config.get("params") or {}
        # Forcing a tool means this turn must call a function tool, so server tools are left out.
        if tool_choice is None or "auto" in tool_choice:
            # Copied so the cache_control below never lands on the caller's config.
            tools.extend(dict(tool) for tool in self.config.get("anthropic_tools") or [])
            tools.extend(dict(tool) for tool in params.get("tools") or [])

        # A cache_control on the final tool caches all of them, so one cache point suffices.
        if tools and (cache_control := self._resolve_tools_cache()):
            tools[-1]["cache_control"] = cache_control

        system = self._format_system_prompt(system_prompt, system_prompt_content)

        request = {
            "max_tokens": self.config["max_tokens"],
            "messages": self._format_request_messages(messages, cache_target_idx, dynamic_trailing_blocks),
            "model": self.config["model_id"],
            **(self._format_tool_choice(tool_choice)),
            **({"system": system} if system else {}),
            **params,
            "tools": tools,
        }

        return request

    def _format_system_prompt(
        self, system_prompt: str | None, system_prompt_content: list[SystemContentBlock] | None
    ) -> str | list[dict[str, Any]] | None:
        """Format the system prompt for the Anthropic API, auto-injecting a cache point at its end.

        Args:
            system_prompt: Plain string system prompt. Ignored when system_prompt_content is provided.
            system_prompt_content: Structured system prompt content blocks.

        Returns:
            The API system value (string or text blocks), or None when no system prompt is given.
        """
        cache_config = self.config.get("cache_config")
        if cache_config is None or cache_config.strategy not in ("auto", "anthropic"):
            managed_ttl: str | None = None
            auto_inject = False
        else:
            system_prompt_ttl = cache_config.system_prompt_ttl
            managed_ttl = system_prompt_ttl if isinstance(system_prompt_ttl, str) else cache_config.ttl
            auto_inject = system_prompt_ttl is not False

        if system_prompt_content is None:
            if not system_prompt:
                return None
            if not auto_inject:
                return system_prompt
            return [{"type": "text", "text": system_prompt, "cache_control": self._format_cache_control(managed_ttl)}]

        formatted: list[dict[str, Any]] = []
        placed = False
        for block in system_prompt_content:
            if "cachePoint" in block:
                if formatted and "cache_control" in formatted[-1]:
                    logger.warning("stripped an extra system cache point | keeping the earlier point on the block")
                elif self._attach_cache_control(formatted, block["cachePoint"].get("ttl") or managed_ttl):
                    placed = True
                continue
            if "text" in block:
                formatted.append({"type": "text", "text": block["text"]})

        if not formatted:
            return None
        if auto_inject and not placed:
            formatted[-1]["cache_control"] = self._format_cache_control(managed_ttl)
        return formatted

    @staticmethod
    def _validate_anthropic_tools(anthropic_tools: list[dict[str, Any]]) -> None:
        """Validate that anthropic_tools does not contain function tool definitions.

        Args:
            anthropic_tools: List of Anthropic tools to validate.

        Raises:
            ValueError: If any tool carries an input_schema.
        """
        for tool in anthropic_tools:
            if "input_schema" in tool:
                raise ValueError(
                    "anthropic_tools should not contain function tool definitions. "
                    "Use the standard tools interface for function calling tools. "
                    "anthropic_tools is reserved for Anthropic server-side tools like "
                    "web_search, web_fetch, and code_execution."
                )

    @staticmethod
    def _format_citation(citation: dict[str, Any]) -> CitationsDelta:
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

    @staticmethod
    def _log_server_tool_block(content_block: Any) -> None:
        """Log a skipped server-side tool block, at warning level when the tool returned an error.

        Args:
            content_block: The `content_block` of a `content_block_start` event.
        """
        error_code = getattr(getattr(content_block, "content", None), "error_code", None)
        if error_code is not None:
            logger.warning("block_type=<%s>, error_code=<%s> | server-side tool failed", content_block.type, error_code)
        else:
            logger.debug("block_type=<%s> | skipping server-side tool block", content_block.type)

    @staticmethod
    def _format_tool_choice(tool_choice: ToolChoice | None) -> dict:
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

    def format_chunk(self, event: dict[str, Any]) -> StreamEvent:
        """Format the Anthropic response events into standardized message chunks.

        Args:
            event: A response event from the Anthropic model.

        Returns:
            The formatted chunk.

        Raises:
            RuntimeError: If chunk_type is not recognized.
                This error should never be encountered as we control chunk_type in the stream method.
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
                delta = event["delta"]

                match delta["type"]:
                    case "signature_delta":
                        return {
                            "contentBlockDelta": {
                                "contentBlockIndex": event["index"],
                                "delta": {
                                    "reasoningContent": {
                                        "signature": delta["signature"],
                                    },
                                },
                            },
                        }

                    case "thinking_delta":
                        return {
                            "contentBlockDelta": {
                                "contentBlockIndex": event["index"],
                                "delta": {
                                    "reasoningContent": {
                                        "text": delta["thinking"],
                                    },
                                },
                            },
                        }

                    case "input_json_delta":
                        return {
                            "contentBlockDelta": {
                                "contentBlockIndex": event["index"],
                                "delta": {
                                    "toolUse": {
                                        "input": delta["partial_json"],
                                    },
                                },
                            },
                        }

                    case "text_delta":
                        return {
                            "contentBlockDelta": {
                                "contentBlockIndex": event["index"],
                                "delta": {
                                    "text": delta["text"],
                                },
                            },
                        }

                    case "citations_delta":
                        return {
                            "contentBlockDelta": {
                                "contentBlockIndex": event["index"],
                                "delta": {
                                    "citation": self._format_citation(delta["citation"]),
                                },
                            },
                        }

                    case _:
                        raise RuntimeError(
                            f"event_type=<content_block_delta>, delta_type=<{delta['type']}> | unknown type"
                        )

            case "content_block_stop":
                return {"contentBlockStop": {"contentBlockIndex": event["index"]}}

            case "message_stop":
                message = event["message"]

                return {"messageStop": {"stopReason": message["stop_reason"]}}

            case "metadata":
                usage = event["usage"]
                input_tokens = usage["input_tokens"]
                output_tokens = usage["output_tokens"]
                cache_read = usage.get("cache_read_input_tokens") or 0
                cache_write = usage.get("cache_creation_input_tokens") or 0
                usage_chunk: Usage = {
                    "inputTokens": input_tokens,
                    "outputTokens": output_tokens,
                    "totalTokens": input_tokens + output_tokens,
                }
                if cache_read:
                    usage_chunk["cacheReadInputTokens"] = cache_read
                if cache_write:
                    usage_chunk["cacheWriteInputTokens"] = cache_write

                return {
                    "metadata": {
                        "usage": usage_chunk,
                        "metrics": {
                            "latencyMs": 0,  # TODO
                        },
                    }
                }

            case _:
                raise RuntimeError(f"event_type=<{event['type']} | unknown type")

    @override
    async def count_tokens(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None,
    ) -> int:
        """Count tokens using Anthropic's native count_tokens API.

        Uses the same message format as the Messages API to get accurate token counts
        directly from the Anthropic service.

        Args:
            messages: List of message objects to count tokens for.
            tool_specs: List of tool specifications to include in the count.
            system_prompt: Plain string system prompt. Ignored if system_prompt_content is provided.
            system_prompt_content: Structured system prompt content blocks.

        Returns:
            Total input token count.
        """
        if self.config.get("use_native_token_count") is not True:
            return await super().count_tokens(messages, tool_specs, system_prompt, system_prompt_content)

        try:
            request = self.format_request(
                messages, tool_specs, system_prompt, system_prompt_content=system_prompt_content
            )
            # Keep only fields accepted by count_tokens; strip inference params (max_tokens, temperature, etc.)
            count_tokens_fields = {"model", "messages", "tools", "tool_choice", "system"}
            request = {k: request[k] for k in request.keys() & count_tokens_fields}

            response = await self.client.messages.count_tokens(**request)
            total_tokens: int = response.input_tokens

            logger.debug(
                "model_id=<%s>, total_tokens=<%d> | native token count",
                self.config["model_id"],
                total_tokens,
            )
            return total_tokens
        except Exception as e:
            logger.debug(
                "model_id=<%s>, error=<%s> | native token counting failed, falling back to estimation",
                self.config["model_id"],
                e,
            )
            return await super().count_tokens(messages, tool_specs, system_prompt, system_prompt_content)

    @override
    async def stream(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        *,
        tool_choice: ToolChoice | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Stream conversation with the Anthropic model.

        Args:
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            system_prompt: Plain string system prompt. Ignored when system_prompt_content is provided.
            tool_choice: Selection strategy for tool invocation.
            system_prompt_content: Structured system prompt content blocks, which can carry a cache point.
            **kwargs: Additional keyword arguments for future extensibility.

        Yields:
            Formatted message chunks from the model.

        Raises:
            ContextWindowOverflowException: If the input exceeds the model's context window.
            ModelThrottledException: If the request is throttled by Anthropic.
            RuntimeError: If a paused server-side tool turn is still paused after the continuation limit.
        """
        logger.debug("formatting request")
        request = self.format_request(
            messages,
            tool_specs,
            system_prompt,
            system_prompt_content=system_prompt_content,
            tool_choice=tool_choice,
            dynamic_trailing_blocks=kwargs.get("dynamic_trailing_blocks", 0),
        )
        logger.debug("request=<%s>", request)

        logger.debug("invoking model")
        usage: dict[str, int] = {}
        block_index_offset = 0
        continuations = 0
        try:
            while True:
                async with self.client.messages.stream(**request) as stream:
                    logger.debug("got response from model")
                    server_tool_block_indexes: set[int] = set()
                    next_block_index = block_index_offset
                    stop_reason: str | None = None
                    async for event in stream:
                        if event.type not in AnthropicModel.EVENT_TYPES:
                            continue
                        if event.type == "message_start":
                            if continuations == 0:
                                yield self.format_chunk(event.model_dump())
                            continue
                        if event.type == "message_stop":
                            stop_reason = event.message.stop_reason
                            continue
                        if event.type == "content_block_start" and event.content_block.type in _SERVER_TOOL_BLOCK_TYPES:
                            server_tool_block_indexes.add(event.index)
                            self._log_server_tool_block(event.content_block)
                            continue
                        if event.type == "content_block_delta" and event.index in server_tool_block_indexes:
                            continue
                        if event.type == "content_block_stop":
                            if event.index in server_tool_block_indexes:
                                server_tool_block_indexes.discard(event.index)
                                continue
                            payload: dict[str, Any] = {"type": "content_block_stop", "index": event.index}
                        else:
                            payload = event.model_dump()

                        payload["index"] += block_index_offset
                        next_block_index = max(next_block_index, payload["index"] + 1)
                        yield self.format_chunk(payload)

                    message_snapshot = None
                    try:
                        message_snapshot = await stream.get_final_message()
                    except AssertionError as e:
                        logger.warning(
                            "error=<%s> | failed to retrieve message snapshot, usage metadata unavailable", e
                        )
                    else:
                        for key, value in message_snapshot.usage.model_dump().items():
                            if isinstance(value, int):
                                usage[key] = usage.get(key, 0) + value

                if stop_reason == "pause_turn":
                    if continuations >= _MAX_PAUSE_TURN_CONTINUATIONS:
                        raise RuntimeError(
                            f"server-side tool turn did not complete after {continuations} continuations"
                        )
                    if message_snapshot is not None:
                        continuations += 1
                        block_index_offset = next_block_index
                        request = {
                            **request,
                            "messages": [
                                *request["messages"],
                                {"role": "assistant", "content": message_snapshot.content},
                            ],
                        }
                        logger.debug("continuation=<%d> | resuming paused server-side tool turn", continuations)
                        continue
                    logger.warning(
                        "continuations=<%d> | paused server-side tool turn not resumed, ending turn", continuations
                    )
                    stop_reason = "end_turn"

                if stop_reason is not None:
                    # Build dict directly to avoid Pydantic serialization warnings
                    # when the message contains ParsedTextBlock objects (issue #1746)
                    yield self.format_chunk({"type": "message_stop", "message": {"stop_reason": stop_reason}})
                if usage:
                    yield self.format_chunk({"type": "metadata", "usage": usage})
                break

        except anthropic.RateLimitError as error:
            raise ModelThrottledException(str(error)) from error

        except anthropic.BadRequestError as error:
            if any(overflow_message in str(error).lower() for overflow_message in AnthropicModel.OVERFLOW_MESSAGES):
                raise ContextWindowOverflowException(str(error)) from error

            raise error

        logger.debug("finished streaming response from model")

    @override
    async def structured_output(
        self, output_model: type[T], prompt: Messages, system_prompt: str | None = None, **kwargs: Any
    ) -> AsyncGenerator[dict[str, T | Any], None]:
        """Get structured output from the model.

        Args:
            output_model: The output model to use for the agent.
            prompt: The prompt messages to use for the agent.
            system_prompt: System prompt to provide context to the model.
            **kwargs: Additional keyword arguments for future extensibility.

        Yields:
            Model events with the last being the structured output.
        """
        tool_spec = convert_pydantic_to_tool_spec(output_model)

        response = self.stream(
            messages=prompt,
            tool_specs=[tool_spec],
            system_prompt=system_prompt,
            tool_choice=cast(ToolChoice, {"any": {}}),
            **kwargs,
        )
        async for event in process_stream(response):
            yield event

        stop_reason, messages, _, _ = event["stop"]

        if stop_reason != "tool_use":
            raise ValueError(f'Model returned stop_reason: {stop_reason} instead of "tool_use".')

        content = messages["content"]
        output_response: dict[str, Any] | None = None
        for block in content:
            # if the tool use name doesn't match the tool spec name, skip, and if the block is not a tool use, skip.
            # if the tool use name never matches, raise an error.
            if block.get("toolUse") and block["toolUse"]["name"] == tool_spec["name"]:
                output_response = block["toolUse"]["input"]
            else:
                continue

        if output_response is None:
            raise ValueError("No valid tool use or tool use input was found in the Anthropic response.")

        yield {"output": output_model(**output_response)}

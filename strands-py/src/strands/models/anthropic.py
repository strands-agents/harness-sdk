"""Anthropic Claude model provider.

Anthropic-specific server-side tools (e.g. ``web_search``, ``web_fetch``, ``code_execution``) are
configured through ``anthropic_tools``, which is appended alongside the agent's function tools rather
than replacing them. Server-side tools run inside Anthropic's infrastructure, so the agent never
executes them locally.

Coverage of the content these tools stream back:

- ``web_search`` (supported): search citations are surfaced as ``citationsContent`` blocks carrying
  the url, domain, title, and cited text.
- ``server_tool_use`` / ``*_tool_result`` blocks (partial): Anthropic executes these server side, so
  they are not surfaced as ``toolUse``/``toolResult`` content blocks -- doing so would make the event
  loop try to run them locally. The raw result blocks have no matching content block type; result
  errors are logged at warning level so a failed search is never silent.

- Docs: https://docs.anthropic.com/claude/reference/getting-started-with-the-api
- Server tools: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool
"""

import base64
import json
import logging
import mimetypes
import warnings
from collections.abc import AsyncGenerator, Mapping
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
from ..types.content import ContentBlock, Messages, SystemContentBlock
from ..types.event_loop import Usage
from ..types.exceptions import ContextWindowOverflowException, ModelThrottledException
from ..types.streaming import CitationsDelta, StreamEvent
from ..types.tools import ToolChoice, ToolChoiceToolDict, ToolSpec
from ._defaults import resolve_config_metadata
from ._validation import _has_location_source, validate_config_keys
from .model import BaseModelConfig, Model

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

# Content block types the agent itself acts on.
_CLIENT_SIDE_BLOCK_TYPES = frozenset({"redacted_thinking", "text", "thinking", "tool_use"})

# Content block types Anthropic produces for tools it resolves server side. These are informational for
# the client: the search/fetch/execution already happened inside Anthropic's infrastructure, so they must
# not be replayed as toolUse/toolResult blocks (the event loop would try to run them locally, and the
# resulting dangling tool_use ids would be rejected on the next request).
#
# Blocks that represent an invocation, and therefore carry a tool `name` rather than a result. Split out
# only to pick the right log message.
_SERVER_TOOL_USE_BLOCK_TYPES = frozenset({"mcp_tool_use", "server_tool_use"})

_SERVER_TOOL_RESULT_BLOCK_TYPES = frozenset(
    {
        "bash_code_execution_tool_result",
        "code_execution_tool_result",
        "container_upload",
        "mcp_tool_result",
        "text_editor_code_execution_tool_result",
        "tool_search_tool_result",
        "web_fetch_tool_result",
        "web_search_tool_result",
    }
)

_SERVER_TOOL_BLOCK_TYPES = _SERVER_TOOL_USE_BLOCK_TYPES | _SERVER_TOOL_RESULT_BLOCK_TYPES

_IMAGE_MEDIA_TYPES = {
    "gif": "image/gif",
    "jpeg": "image/jpeg",
    "jpg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
}


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
            max_tokens: Maximum number of tokens to generate.
            model_id: Calude model ID (e.g., "claude-3-7-sonnet-latest").
                For a complete list of supported models, see
                https://docs.anthropic.com/en/docs/about-claude/models/all-models.
            params: Additional model parameters (e.g., temperature).
                For a complete list of supported parameters, see https://docs.anthropic.com/en/api/messages.
                Note: do not pass `tools` here. Use `anthropic_tools` instead so that server-side tools
                are appended to, rather than replacing, the agent's function tools.
            anthropic_tools: Anthropic-specific tools that are not function tools (e.g., web_search,
                web_fetch, code_execution, memory, text_editor, bash). These run server side inside
                Anthropic's infrastructure and are appended alongside the function tool definitions.
                Use the standard tools interface for function calling tools.
                Entries are `anthropic.types.ToolUnionParam` dicts, so the versioned `type` string is
                supplied by the caller (e.g., `{"type": "web_search_20260318", "name": "web_search"}`).
                For a complete list of supported tools, see
                https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview
            use_native_token_count: Whether to use the native Anthropic count_tokens API.
                When True, count_tokens() calls the Anthropic API for accurate counts.
                When False (default), skips the API call and uses the local estimator.
        """

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
            TypeError: If the content block type cannot be converted to an Anthropic-compatible format.
        """
        if "document" in content:
            mime_type = mimetypes.types_map.get(f".{content['document']['format']}", "application/octet-stream")
            return {
                "source": {
                    "data": (
                        content["document"]["source"]["bytes"].decode("utf-8")
                        if mime_type == "text/plain"
                        else base64.b64encode(content["document"]["source"]["bytes"]).decode("utf-8")
                    ),
                    "media_type": mime_type,
                    "type": "text" if mime_type == "text/plain" else "base64",
                },
                "title": content["document"]["name"],
                "type": "document",
            }

        if "image" in content:
            image_format = content["image"]["format"]
            return {
                "source": {
                    "data": base64.b64encode(content["image"]["source"]["bytes"]).decode("utf-8"),
                    "media_type": _IMAGE_MEDIA_TYPES.get(
                        image_format,
                        mimetypes.types_map.get(f".{image_format}", "application/octet-stream"),
                    ),
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
            # Citations are output-only for Anthropic: `web_search_result_location` citations describe
            # a search Anthropic already ran and cannot be sent back as input. Preserve the generated
            # text so a cited answer survives into the next turn instead of raising on an unsupported
            # content type. Blocks with no generated text are dropped upstream in
            # _format_request_messages (Anthropic rejects empty text blocks).
            return {"text": self._citations_text(content), "type": "text"}

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

    @staticmethod
    def _citations_text(content: ContentBlock) -> str:
        """Flatten the generated text carried by a citations content block.

        Args:
            content: A content block containing `citationsContent`.

        Returns:
            The concatenated generated text.
        """
        return "".join(
            citation_content["text"]
            for citation_content in content["citationsContent"].get("content", [])
            if "text" in citation_content
        )

    def _format_request_messages(self, messages: Messages) -> list[dict[str, Any]]:
        """Format an Anthropic messages array.

        Args:
            messages: List of message objects to be processed by the model.

        Returns:
            An Anthropic messages array.
        """
        formatted_messages = []

        for message in messages:
            formatted_contents: list[dict[str, Any]] = []

            for content in message["content"]:
                if "cachePoint" in content:
                    formatted_contents[-1]["cache_control"] = {"type": "ephemeral"}
                    continue

                # Check for location sources in image, document, or video content
                if _has_location_source(content):
                    logger.warning("Location sources are not supported by Anthropic | skipping content block")
                    continue

                # A citations block flattens to a text block, and Anthropic rejects empty text blocks
                # ("text content blocks must contain non-whitespace text"). Providers that stream
                # citations separately from the text they ground can produce a citations block with no
                # generated text, so drop those rather than sending a request that is certain to 400.
                if "citationsContent" in content and not self._citations_text(content).strip():
                    logger.debug("citations block has no generated text | skipping content block")
                    continue

                formatted_contents.append(self._format_request_message_content(content))

            if formatted_contents:
                formatted_messages.append({"content": formatted_contents, "role": message["role"]})

        return formatted_messages

    def format_request(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        tool_choice: ToolChoice | None = None,
    ) -> dict[str, Any]:
        """Format an Anthropic streaming request.

        Args:
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            system_prompt: System prompt to provide context to the model.
            tool_choice: Selection strategy for tool invocation.

        Returns:
            An Anthropic streaming request.

        Raises:
            TypeError: If a message contains a content block type that cannot be converted to an Anthropic-compatible
                format.
        """
        tools: list[dict[str, Any]] = [
            {
                "name": tool_spec["name"],
                "description": tool_spec["description"],
                "input_schema": tool_spec["inputSchema"]["json"],
            }
            for tool_spec in tool_specs or []
        ]

        # Server-side tools are additive: they extend the function tool definitions instead of
        # replacing them (mirrors GeminiModel's gemini_tools).
        tools.extend(self.config.get("anthropic_tools") or [])

        # Copy params before mutating: ** unpacking below aliases self.config["params"] by reference,
        # so popping from the original would silently rewrite the stored config.
        params = dict(self.config.get("params") or {})
        if "tools" in params:
            params_tools = params.pop("tools")
            warnings.warn(
                "Passing `tools` through `params` is deprecated and previously overwrote every function "
                "tool definition, silently disabling the agent's tools. The value has been appended to "
                "the request instead. Use the `anthropic_tools` config option for Anthropic server-side "
                "tools (e.g. web_search) and the standard tools interface for function tools.",
                stacklevel=3,
            )
            tools.extend(self._normalize_tools(params_tools, 'params["tools"]'))

        return {
            "max_tokens": self.config["max_tokens"],
            "messages": self._format_request_messages(messages),
            "model": self.config["model_id"],
            "tools": tools,
            **(self._format_tool_choice(tool_choice)),
            **({"system": system_prompt} if system_prompt else {}),
            **params,
        }

    @staticmethod
    def _normalize_tools(value: Any, label: str) -> list[dict[str, Any]]:
        """Coerce a tool-list-ish value into a list of tool dicts.

        A bare mapping is a common mistake and is unambiguous, so it is wrapped. Anything else (a
        string, an int, a mapping-of-mappings) would be iterated element-by-element by `list.extend`,
        turning a single mistake into a request full of nonsense tools, so it is rejected outright.

        Args:
            value: The user-supplied value.
            label: Human-readable name of the option, used in the error message.

        Returns:
            A list of tool dicts.

        Raises:
            ValueError: If the value is neither a mapping nor a sequence of mappings.
        """
        if value is None:
            return []

        if isinstance(value, Mapping):
            return [cast(dict[str, Any], value)]

        if isinstance(value, (list, tuple)):
            return list(value)

        raise ValueError(
            f"{label} must be a list of Anthropic tool dicts "
            f"(e.g. [{{'type': 'web_search_20260318', 'name': 'web_search'}}]), got {type(value).__name__}."
        )

    @staticmethod
    def _validate_anthropic_tools(anthropic_tools: list[dict[str, Any]] | None) -> None:
        """Validate that anthropic_tools does not contain function tool definitions.

        Anthropic-specific tools should only include tools that Anthropic executes server side and that
        therefore cannot be expressed as a function tool (e.g., web_search, web_fetch, code_execution).
        Standard function calling tools should use the tools interface instead.

        Args:
            anthropic_tools: List of Anthropic tools to validate.

        Raises:
            ValueError: If any entry is not a mapping, is missing the versioned `type` string, or looks
                like a function tool definition.
        """
        for tool in AnthropicModel._normalize_tools(anthropic_tools, "anthropic_tools"):
            if not isinstance(tool, Mapping):
                raise ValueError(
                    "anthropic_tools entries must be Anthropic tool dicts "
                    f"(e.g. {{'type': 'web_search_20260318', 'name': 'web_search'}}), got {type(tool).__name__}."
                )

            if "input_schema" in tool:
                raise ValueError(
                    "anthropic_tools should not contain function tool definitions. "
                    "Use the standard tools interface for function calling tools. "
                    "anthropic_tools is reserved for Anthropic-specific server-side tools like "
                    "web_search, web_fetch, code_execution, memory, text_editor, and bash."
                )

            if not tool.get("type"):
                raise ValueError(
                    "anthropic_tools entries must carry the versioned `type` string for the tool "
                    "(e.g. 'web_search_20260318'). See "
                    "https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview"
                )

    @staticmethod
    def _format_citation(citation: dict[str, Any]) -> CitationsDelta:
        """Format an Anthropic citation into a Strands citation delta.

        Server-side web search attaches `web_search_result_location` citations to the text blocks it
        grounds. Those carry the source url, title, and the cited source text; the url also yields the
        domain that `WebLocation` exposes.

        Args:
            citation: An Anthropic citation object from a `citations_delta` event.

        Returns:
            The formatted citation delta.
        """
        formatted: CitationsDelta = {}

        # Web search and search result citations use `title`; document citations use `document_title`.
        if title := citation.get("title") or citation.get("document_title"):
            formatted["title"] = title

        if cited_text := citation.get("cited_text"):
            formatted["sourceContent"] = [{"text": cited_text}]

        match citation.get("type"):
            case "web_search_result_location":
                url = citation.get("url") or ""
                web: WebLocation = {"url": url}
                # hostname, not netloc: netloc carries port and userinfo, which the TS provider's
                # URL().hostname does not, and the two must agree.
                if domain := urlparse(url).hostname:
                    web["domain"] = domain
                web_location: WebLocationDict = {"web": web}
                formatted["location"] = web_location

            case "search_result_location":
                # Anthropic's end_block_index is exclusive (a single-block citation has
                # end = start + 1); copied through as-is.
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
                # Anthropic page numbers are 1-based; copied through as-is.
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
                # Keep the title and cited text rather than dropping the citation outright.
                logger.warning("citation_type=<%s> | unsupported citation location | skipping", unknown_type)

        return formatted

    @staticmethod
    def _log_server_tool_block(content_block: Any) -> None:
        """Log a server-side tool block that has no equivalent Strands content block type.

        Result errors (e.g. `max_uses_exceeded`, `unavailable`) are logged at warning level so that a
        server-side search which returned nothing is never silent.

        Args:
            content_block: The Anthropic `content_block` object from a `content_block_start` event.
        """
        block_type = getattr(content_block, "type", None)

        if block_type in _SERVER_TOOL_USE_BLOCK_TYPES:
            logger.debug(
                "block_type=<%s>, tool_name=<%s> | anthropic executed this tool server side",
                block_type,
                getattr(content_block, "name", None),
            )
            return

        content = getattr(content_block, "content", None)
        error_code = getattr(content, "error_code", None)
        if error_code is not None:
            logger.warning(
                "block_type=<%s>, error_code=<%s> | server-side tool returned an error",
                block_type,
                error_code,
            )
            return

        logger.debug(
            "block_type=<%s>, result_count=<%s> | server-side tool result has no content block "
            "representation | citations on the following text blocks carry the cited sources",
            block_type,
            len(content) if isinstance(content, list) else None,
        )

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
                stop_reason = message["stop_reason"]

                if stop_reason == "pause_turn":
                    # Anthropic pauses long-running server-side tool turns and expects the response to be
                    # sent back to continue. The event loop has no equivalent stop reason, so surface the
                    # content that did arrive as a completed turn rather than an unknown stop reason.
                    logger.warning(
                        "stop_reason=<pause_turn> | server-side tool turn paused, reporting as end_turn | "
                        "the response may be incomplete"
                    )
                    stop_reason = "end_turn"

                return {"messageStop": {"stopReason": stop_reason}}

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
            # system_prompt_content is not used; this provider only accepts system_prompt as a plain string,
            # matching the behavior of stream(). The caller always provides system_prompt alongside
            # system_prompt_content, so the plain string is always available.
            request = self.format_request(messages, tool_specs, system_prompt)
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
        **kwargs: Any,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Stream conversation with the Anthropic model.

        Args:
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            system_prompt: System prompt to provide context to the model.
            tool_choice: Selection strategy for tool invocation.
            **kwargs: Additional keyword arguments for future extensibility.

        Yields:
            Formatted message chunks from the model.

        Raises:
            ContextWindowOverflowException: If the input exceeds the model's context window.
            ModelThrottledException: If the request is throttled by Anthropic.
        """
        logger.debug("formatting request")
        request = self.format_request(messages, tool_specs, system_prompt, tool_choice)
        logger.debug("request=<%s>", request)

        logger.debug("invoking model")
        try:
            async with self.client.messages.stream(**request) as stream:
                logger.debug("got response from model")

                # Indexes of content blocks Anthropic resolved server side. Their input_json_delta
                # events describe a tool the agent never executes, so replaying them as function tool
                # input would corrupt the streaming tool-use state. The whole block is skipped, start
                # and stop included, so it leaves no empty content block behind.
                server_tool_block_indexes: set[int] = set()

                async for event in stream:
                    if event.type in AnthropicModel.EVENT_TYPES:
                        if event.type == "content_block_start":
                            block_type = getattr(event.content_block, "type", None)

                            if block_type in _SERVER_TOOL_BLOCK_TYPES:
                                server_tool_block_indexes.add(event.index)
                                self._log_server_tool_block(event.content_block)
                                continue

                            if block_type not in _CLIENT_SIDE_BLOCK_TYPES:
                                # Forward rather than suppress: dropping a block type we simply do not
                                # know about would lose content silently, which is worse than the
                                # degraded handling below. Warn loudly so a newly shipped Anthropic
                                # block type shows up instead of quietly misbehaving.
                                logger.warning(
                                    "block_type=<%s> | unrecognized content block type | forwarding | "
                                    "if anthropic resolves this server side its input deltas may be "
                                    "replayed as function tool input",
                                    block_type,
                                )

                        elif event.type == "content_block_delta":
                            if event.index in server_tool_block_indexes:
                                continue

                        elif event.type == "content_block_stop":
                            if event.index in server_tool_block_indexes:
                                # Release the index: Anthropic reuses indexes, so a later client-side
                                # block at the same index must still stream.
                                server_tool_block_indexes.discard(event.index)
                                continue

                        if event.type == "message_stop":
                            # Build dict directly to avoid Pydantic serialization warnings
                            # when the message contains ParsedTextBlock objects (issue #1746)
                            yield self.format_chunk(
                                {
                                    "type": "message_stop",
                                    "message": {"stop_reason": event.message.stop_reason},
                                }
                            )
                        elif event.type == "content_block_stop":
                            yield self.format_chunk({"type": "content_block_stop", "index": event.index})
                        else:
                            yield self.format_chunk(event.model_dump())

                            # A text block can arrive with its first characters already attached to
                            # content_block_start. format_chunk emits one chunk per event, so the text
                            # needs a follow-up delta or it is lost (the TS provider does the same).
                            if event.type == "content_block_start":
                                initial_text = getattr(event.content_block, "text", None)
                                if isinstance(initial_text, str) and initial_text:
                                    yield self.format_chunk(
                                        {
                                            "type": "content_block_delta",
                                            "index": event.index,
                                            "delta": {"type": "text_delta", "text": initial_text},
                                        }
                                    )

                try:
                    message_snapshot = await stream.get_final_message()
                except AssertionError as e:
                    logger.warning("error=<%s> | failed to retrieve message snapshot, usage metadata unavailable", e)
                else:
                    yield self.format_chunk({"type": "metadata", "usage": message_snapshot.usage.model_dump()})

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

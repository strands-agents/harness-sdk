"""OpenAI model provider.

- Docs: https://platform.openai.com/docs/overview
"""

import base64
import json
import logging
import mimetypes
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Protocol, TypeVar, cast

import openai
from openai.types.chat.parsed_chat_completion import ParsedChatCompletion
from pydantic import BaseModel
from typing_extensions import Unpack, override

from ..types.content import ContentBlock, Messages, SystemContentBlock
from ..types.event_loop import Usage
from ..types.exceptions import ContextWindowOverflowException, ModelThrottledException
from ..types.streaming import StreamEvent
from ..types.tools import ToolChoice, ToolResult, ToolSpec, ToolUse
from ._defaults import resolve_config_metadata
from ._openai_bedrock import BedrockMantleConfig, resolve_bedrock_client_args
from ._openai_cache import apply_cache_config
from ._openai_errors import classify_openai_error
from ._validation import _has_location_source, validate_config_keys
from .model import AgentMetadata, BaseModelConfig, CacheConfig, Model

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


class Client(Protocol):
    """Protocol defining the OpenAI-compatible interface for the underlying provider client."""

    @property
    # pragma: no cover
    def chat(self) -> Any:
        """Chat completions interface."""
        ...


class OpenAIModel(Model):
    """OpenAI model provider implementation."""

    client: Client

    class OpenAIConfig(BaseModelConfig, total=False):
        """Configuration options for OpenAI models.

        Attributes:
            model_id: Model ID (e.g., "gpt-4o").
                For a complete list of supported models, see https://platform.openai.com/docs/models.
            params: Model parameters (e.g., max_tokens).
                For a complete list of supported parameters, see
                https://platform.openai.com/docs/api-reference/chat/create.
            stream: Whether to use OpenAI chat completion streaming. Defaults to True.
            cache_config: Prompt-caching configuration. OpenAI routes cache reads on
                ``cache_key`` (mapped to ``prompt_cache_key``) and honors ``ttl`` only when it names
                an OpenAI retention value; other fields have no effect. An explicit
                ``prompt_cache_key``/``prompt_cache_retention`` in ``params`` takes precedence.
        """

        model_id: str
        params: dict[str, Any] | None
        stream: bool
        cache_config: CacheConfig | None

    def __init__(
        self,
        client: Client | None = None,
        client_args: dict[str, Any] | None = None,
        bedrock_mantle_config: BedrockMantleConfig | None = None,
        **model_config: Unpack[OpenAIConfig],
    ) -> None:
        """Initialize provider instance.

        Args:
            client: Pre-configured OpenAI-compatible client to reuse across requests.
                When provided, this client will be reused for all requests and will NOT be closed
                by the model. The caller is responsible for managing the client lifecycle.
                This is useful for:
                - Injecting custom client wrappers (e.g., GuardrailsAsyncOpenAI)
                - Reusing connection pools within a single event loop/worker
                - Centralizing observability, retries, and networking policy
                - Pointing to custom model gateways
                Note: The client should not be shared across different asyncio event loops.
            client_args: Arguments for the OpenAI client (legacy approach).
                For a complete list of supported arguments, see https://pypi.org/project/openai/.
                May be combined with ``bedrock_mantle_config``; when both are set,
                ``bedrock_mantle_config`` derives ``base_url`` and ``api_key`` (which must not
                appear in ``client_args``).
            bedrock_mantle_config: Route requests through Amazon Bedrock's Mantle
                (OpenAI-compatible) endpoint. See :class:`BedrockMantleConfig` for accepted
                keys. When set, a fresh bearer token is minted on every request. Cannot be
                combined with a pre-built ``client``.
            **model_config: Configuration options for the OpenAI model.

        Raises:
            ValueError: If ``client`` is combined with ``client_args`` or ``bedrock_mantle_config``.
        """
        validate_config_keys(model_config, self.OpenAIConfig)
        self.config = dict(model_config)

        # client_args + bedrock_mantle_config is allowed; the config derives base_url / api_key.
        client_args_provided = client_args is not None and len(client_args) > 0
        if client is not None and client_args_provided:
            raise ValueError("Only one of 'client' or 'client_args' should be provided, not both.")
        if bedrock_mantle_config is not None and client is not None:
            raise ValueError("'bedrock_mantle_config' cannot be combined with a pre-built 'client'.")
        if bedrock_mantle_config is not None and client_args:
            conflicting = [k for k in ("api_key", "base_url") if k in client_args]
            if conflicting:
                raise ValueError(
                    f"client_args must not contain {conflicting} when bedrock_mantle_config is set; "
                    "these are derived from the Mantle config automatically."
                )

        self._custom_client = client
        self.client_args = client_args or {}
        self._bedrock_mantle_config = bedrock_mantle_config

        logger.debug("config=<%s> | initializing", self.config)

    def _resolve_client_args(self) -> dict[str, Any]:
        """Return the kwargs to pass to ``openai.AsyncOpenAI`` for the current request.

        Delegates to :func:`resolve_bedrock_client_args` when ``bedrock_mantle_config`` is set.
        """
        if self._bedrock_mantle_config is not None:
            return resolve_bedrock_client_args(
                self._bedrock_mantle_config, self.client_args, model_id=str(self.config.get("model_id", ""))
            )
        return self.client_args

    @override
    def update_config(self, **model_config: Unpack[OpenAIConfig]) -> None:  # type: ignore[override]
        """Update the OpenAI model configuration with the provided arguments.

        Args:
            **model_config: Configuration overrides.
        """
        validate_config_keys(model_config, self.OpenAIConfig)
        self.config.update(model_config)

    @override
    def get_config(self) -> OpenAIConfig:
        """Get the OpenAI model configuration.

        Returns:
            The OpenAI model configuration.
        """
        return cast(
            OpenAIModel.OpenAIConfig, resolve_config_metadata(self.config, str(self.config.get("model_id", "")))
        )

    @classmethod
    def format_request_message_content(cls, content: ContentBlock, **kwargs: Any) -> dict[str, Any]:
        """Format an OpenAI compatible content block.

        Args:
            content: Message content.
            **kwargs: Additional keyword arguments for future extensibility.

        Returns:
            OpenAI compatible content block.

        Raises:
            TypeError: If the content block type cannot be converted to an OpenAI-compatible format.
        """
        if "document" in content:
            mime_type = mimetypes.types_map.get(f".{content['document']['format']}", "application/octet-stream")
            file_data = base64.b64encode(content["document"]["source"]["bytes"]).decode("utf-8")
            return {
                "file": {
                    "file_data": f"data:{mime_type};base64,{file_data}",
                    "filename": content["document"]["name"],
                },
                "type": "file",
            }

        if "image" in content:
            mime_type = mimetypes.types_map.get(f".{content['image']['format']}", "application/octet-stream")
            image_data = base64.b64encode(content["image"]["source"]["bytes"]).decode("utf-8")

            return {
                "image_url": {
                    "detail": "auto",
                    "format": mime_type,
                    "url": f"data:{mime_type};base64,{image_data}",
                },
                "type": "image_url",
            }

        if "text" in content:
            return {"text": content["text"], "type": "text"}

        raise TypeError(f"content_type=<{next(iter(content))}> | unsupported type")

    @classmethod
    def format_request_message_tool_call(cls, tool_use: ToolUse, **kwargs: Any) -> dict[str, Any]:
        """Format an OpenAI compatible tool call.

        Args:
            tool_use: Tool use requested by the model.
            **kwargs: Additional keyword arguments for future extensibility.

        Returns:
            OpenAI compatible tool call.
        """
        return {
            "function": {
                "arguments": json.dumps(tool_use["input"], ensure_ascii=False),
                "name": tool_use["name"],
            },
            "id": tool_use["toolUseId"],
            "type": "function",
        }

    @classmethod
    def format_request_tool_message(cls, tool_result: ToolResult, **kwargs: Any) -> dict[str, Any]:
        """Format an OpenAI compatible tool message.

        Args:
            tool_result: Tool result collected from a tool execution.
            **kwargs: Additional keyword arguments for future extensibility.

        Returns:
            OpenAI compatible tool message.
        """
        contents = cast(
            list[ContentBlock],
            [
                {"text": json.dumps(content["json"], ensure_ascii=False)} if "json" in content else content
                for content in tool_result["content"]
            ],
        )

        # Merge adjacent text blocks while preserving the order of non-text
        # (image/document) content.  When all content is text, join into a
        # single string for broad compatibility with OpenAI-compatible
        # endpoints (e.g., Kimi K2.5, vLLM, Ollama).
        # See https://github.com/strands-agents/harness-sdk/issues/1696
        merged: list[dict[str, Any]] = []
        has_non_text = False
        for content_block in contents:
            if "text" in content_block:
                # Merge with the previous entry if it is also text (adjacent)
                if merged and merged[-1].get("type") == "text":
                    merged[-1]["text"] += "\n" + content_block["text"]
                else:
                    merged.append({"type": "text", "text": content_block["text"]})
            elif "image" in content_block or "document" in content_block:
                has_non_text = True
                merged.append(cls.format_request_message_content(content_block))

        content: str | list[dict[str, Any]]
        if has_non_text:
            # Keep array format when images/documents are present so that
            # _split_tool_message_images can extract them into a user message.
            content = merged
        else:
            # All text — the loop already merged adjacent blocks with "\n",
            # so extract the single resulting entry.
            content = merged[0]["text"] if merged else ""

        return {
            "role": "tool",
            "tool_call_id": tool_result["toolUseId"],
            "content": content,
        }

    @classmethod
    def _split_tool_message_images(cls, tool_message: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any] | None]:
        """Split a tool message into text-only tool message and optional user message with images.

        OpenAI API restricts images to user role messages only. This method extracts any image
        content from a tool message and returns it separately as a user message.

        Args:
            tool_message: A formatted tool message that may contain images.

        Returns:
            A tuple of (tool_message_without_images, user_message_with_images_or_None).
        """
        if tool_message.get("role") != "tool":
            return tool_message, None

        content = tool_message.get("content", [])
        if not isinstance(content, list):
            return tool_message, None

        # Separate image and non-image content
        text_content = []
        image_content = []

        for item in content:
            if isinstance(item, dict) and item.get("type") == "image_url":
                image_content.append(item)
            else:
                text_content.append(item)

        # If no images found, return original message
        if not image_content:
            return tool_message, None

        # Let the user know that we are modifying the messages for OpenAI compatibility
        logger.warning(
            "tool_call_id=<%s> | Moving image from tool message to a new user message for OpenAI compatibility",
            tool_message["tool_call_id"],
        )

        # Append a message to the text content to inform the model about the upcoming image
        text_content.append(
            {
                "type": "text",
                "text": (
                    "Tool successfully returned an image. The image is being provided in the following user message."
                ),
            }
        )

        # Create the clean tool message with the updated text content
        tool_message_clean = {
            "role": "tool",
            "tool_call_id": tool_message["tool_call_id"],
            "content": text_content,
        }

        # Create user message with only images
        user_message_with_images = {"role": "user", "content": image_content}

        return tool_message_clean, user_message_with_images

    @classmethod
    def _format_request_tool_choice(cls, tool_choice: ToolChoice | None) -> dict[str, Any]:
        """Format a tool choice for OpenAI compatibility.

        Args:
            tool_choice: Tool choice configuration in Bedrock format.

        Returns:
            OpenAI compatible tool choice format.
        """
        if not tool_choice:
            return {}

        match tool_choice:
            case {"auto": _}:
                return {"tool_choice": "auto"}  # OpenAI SDK doesn't define constants for these values
            case {"any": _}:
                return {"tool_choice": "required"}
            case {"tool": {"name": tool_name}}:
                return {"tool_choice": {"type": "function", "function": {"name": tool_name}}}
            case _:
                # This should not happen with proper typing, but handle gracefully
                return {"tool_choice": "auto"}

    @classmethod
    def _format_system_messages(
        cls,
        system_prompt: str | None = None,
        *,
        system_prompt_content: list[SystemContentBlock] | None = None,
        **kwargs: Any,
    ) -> list[dict[str, Any]]:
        """Format system messages for OpenAI-compatible providers.

        Args:
            system_prompt: System prompt to provide context to the model.
            system_prompt_content: System prompt content blocks to provide context to the model.
            **kwargs: Additional keyword arguments for future extensibility.

        Returns:
            List of formatted system messages.
        """
        # Handle backward compatibility: if system_prompt is provided but system_prompt_content is None
        if system_prompt and system_prompt_content is None:
            system_prompt_content = [{"text": system_prompt}]

        # TODO: Handle caching blocks https://github.com/strands-agents/harness-sdk/issues/1140
        return [
            {"role": "system", "content": content["text"]}
            for content in system_prompt_content or []
            if "text" in content
        ]

    @classmethod
    def _format_regular_messages(cls, messages: Messages, **kwargs: Any) -> list[dict[str, Any]]:
        """Format regular messages for OpenAI-compatible providers.

        Args:
            messages: List of message objects to be processed by the model.
            **kwargs: Additional keyword arguments for future extensibility.

        Returns:
            List of formatted messages.
        """
        formatted_messages = []

        for message in messages:
            contents = message["content"]

            # Check for reasoningContent and warn user
            if any("reasoningContent" in content for content in contents):
                logger.warning(
                    "reasoningContent is not supported in multi-turn conversations with the Chat Completions API."
                )

            # Filter out content blocks that shouldn't be formatted
            filtered_contents = []
            for content in contents:
                if any(block_type in content for block_type in ["toolResult", "toolUse", "reasoningContent"]):
                    continue
                if _has_location_source(content):
                    logger.warning("Location sources are not supported by OpenAI | skipping content block")
                    continue
                if "cachePoint" in content:
                    logger.warning("cachePoint content block is not supported by OpenAI | skipping")
                    continue
                filtered_contents.append(content)

            formatted_contents = [cls.format_request_message_content(content) for content in filtered_contents]
            formatted_tool_calls = [
                cls.format_request_message_tool_call(content["toolUse"]) for content in contents if "toolUse" in content
            ]
            formatted_tool_messages = [
                cls.format_request_tool_message(content["toolResult"])
                for content in contents
                if "toolResult" in content
            ]

            formatted_message = {
                "role": message["role"],
                **({"content": formatted_contents} if formatted_contents else {}),
                **({"tool_calls": formatted_tool_calls} if formatted_tool_calls else {}),
            }
            formatted_messages.append(formatted_message)

            # Process tool messages to extract images into separate user messages
            # OpenAI API requires images to be in user role messages only
            # All tool messages must be grouped together before any user messages with images
            user_messages_with_images = []
            for tool_msg in formatted_tool_messages:
                tool_msg_clean, user_msg_with_images = cls._split_tool_message_images(tool_msg)
                formatted_messages.append(tool_msg_clean)
                if user_msg_with_images:
                    user_messages_with_images.append(user_msg_with_images)
            formatted_messages.extend(user_messages_with_images)

        return formatted_messages

    @classmethod
    def format_request_messages(
        cls,
        messages: Messages,
        system_prompt: str | None = None,
        *,
        system_prompt_content: list[SystemContentBlock] | None = None,
        **kwargs: Any,
    ) -> list[dict[str, Any]]:
        """Format an OpenAI compatible messages array.

        Args:
            messages: List of message objects to be processed by the model.
            system_prompt: System prompt to provide context to the model.
            system_prompt_content: System prompt content blocks to provide context to the model.
            **kwargs: Additional keyword arguments for future extensibility.

        Returns:
            An OpenAI compatible messages array.
        """
        formatted_messages = cls._format_system_messages(system_prompt, system_prompt_content=system_prompt_content)
        formatted_messages.extend(cls._format_regular_messages(messages))

        return [message for message in formatted_messages if "content" in message or "tool_calls" in message]

    def format_request(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        tool_choice: ToolChoice | None = None,
        *,
        system_prompt_content: list[SystemContentBlock] | None = None,
        agent_metadata: AgentMetadata | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Format an OpenAI compatible chat streaming request.

        Args:
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            system_prompt: System prompt to provide context to the model.
            tool_choice: Selection strategy for tool invocation.
            system_prompt_content: System prompt content blocks to provide context to the model.
            agent_metadata: Invoking agent's metadata.
            **kwargs: Additional keyword arguments for future extensibility.

        Returns:
            An OpenAI compatible chat streaming request.

        Raises:
            TypeError: If a message contains a content block type that cannot be converted to an OpenAI-compatible
                format.
        """
        params = dict(cast(dict[str, Any], self.config.get("params") or {}))
        stream = bool(self.config.get("stream", params.pop("stream", True)))
        stream_options = params.pop("stream_options", {"include_usage": True})

        request = {
            "messages": self.format_request_messages(
                messages, system_prompt, system_prompt_content=system_prompt_content
            ),
            "model": self.config["model_id"],
            "stream": stream,
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": tool_spec["name"],
                        "description": tool_spec["description"],
                        "parameters": tool_spec["inputSchema"]["json"],
                    },
                }
                for tool_spec in tool_specs or []
            ],
            **(self._format_request_tool_choice(tool_choice)),
            **params,
        }

        if stream:
            request["stream_options"] = stream_options

        apply_cache_config(request, cast(CacheConfig | None, self.config.get("cache_config")), agent_metadata)

        return request

    def format_chunk(self, event: dict[str, Any], **kwargs: Any) -> StreamEvent:
        """Format an OpenAI response event into a standardized message chunk.

        Args:
            event: A response event from the OpenAI compatible model.
            **kwargs: Additional keyword arguments for future extensibility.

        Returns:
            The formatted chunk.

        Raises:
            RuntimeError: If chunk_type is not recognized.
                This error should never be encountered as chunk_type is controlled in the stream method.
        """
        match event["chunk_type"]:
            case "message_start":
                return {"messageStart": {"role": "assistant"}}

            case "content_start":
                if event["data_type"] == "tool":
                    return {
                        "contentBlockStart": {
                            "start": {
                                "toolUse": {
                                    "name": event["data"].function.name,
                                    "toolUseId": event["data"].id,
                                }
                            }
                        }
                    }

                return {"contentBlockStart": {"start": {}}}

            case "content_delta":
                if event["data_type"] == "tool":
                    return {
                        "contentBlockDelta": {"delta": {"toolUse": {"input": event["data"].function.arguments or ""}}}
                    }

                if event["data_type"] == "reasoning_content":
                    return {"contentBlockDelta": {"delta": {"reasoningContent": {"text": event["data"]}}}}

                return {"contentBlockDelta": {"delta": {"text": event["data"]}}}

            case "content_stop":
                return {"contentBlockStop": {}}

            case "message_stop":
                match event["data"]:
                    case "tool_calls":
                        return {"messageStop": {"stopReason": "tool_use"}}
                    case "length":
                        return {"messageStop": {"stopReason": "max_tokens"}}
                    case _:
                        return {"messageStop": {"stopReason": "end_turn"}}

            case "metadata":
                usage_data: Usage = {
                    "inputTokens": event["data"].prompt_tokens,
                    "outputTokens": event["data"].completion_tokens,
                    "totalTokens": event["data"].total_tokens,
                }

                if tokens_details := getattr(event["data"], "prompt_tokens_details", None):
                    if cached := getattr(tokens_details, "cached_tokens", None):
                        usage_data["cacheReadInputTokens"] = cached

                return {
                    "metadata": {
                        "usage": usage_data,
                        "metrics": {
                            "latencyMs": 0,  # TODO
                        },
                    },
                }

            case _:
                raise RuntimeError(f"chunk_type=<{event['chunk_type']} | unknown type")

    def _format_non_streaming_response(self, response: Any) -> list[StreamEvent]:
        """Convert a non-streaming OpenAI chat completion into Strands stream events."""
        chunks = [self.format_chunk({"chunk_type": "message_start"})]
        choices = getattr(response, "choices", None) or []
        choice = choices[0] if choices else None
        message = getattr(choice, "message", None)

        reasoning_content = getattr(message, "reasoning_content", None) or getattr(message, "reasoning", None)
        if reasoning_content:
            chunks.append(self.format_chunk({"chunk_type": "content_start", "data_type": "reasoning_content"}))
            chunks.append(
                self.format_chunk(
                    {"chunk_type": "content_delta", "data_type": "reasoning_content", "data": reasoning_content}
                )
            )
            chunks.append(self.format_chunk({"chunk_type": "content_stop", "data_type": "reasoning_content"}))

        if content := getattr(message, "content", None):
            chunks.append(self.format_chunk({"chunk_type": "content_start", "data_type": "text"}))
            chunks.append(self.format_chunk({"chunk_type": "content_delta", "data_type": "text", "data": content}))
            chunks.append(self.format_chunk({"chunk_type": "content_stop", "data_type": "text"}))

        for tool_call in getattr(message, "tool_calls", None) or []:
            chunks.append(self.format_chunk({"chunk_type": "content_start", "data_type": "tool", "data": tool_call}))
            chunks.append(self.format_chunk({"chunk_type": "content_delta", "data_type": "tool", "data": tool_call}))
            chunks.append(self.format_chunk({"chunk_type": "content_stop", "data_type": "tool"}))

        chunks.append(
            self.format_chunk(
                {"chunk_type": "message_stop", "data": getattr(choice, "finish_reason", None) or "end_turn"}
            )
        )

        if usage := getattr(response, "usage", None):
            chunks.append(self.format_chunk({"chunk_type": "metadata", "data": usage}))

        return chunks

    @asynccontextmanager
    async def _get_client(self) -> AsyncIterator[Any]:
        """Get an OpenAI client for making requests.

        This context manager handles client lifecycle management:
        - If an injected client was provided during initialization, it yields that client
          without closing it (caller manages lifecycle).
        - Otherwise, creates a new AsyncOpenAI client from client_args and automatically
          closes it when the context exits.

        Note: We create a new client per request to avoid connection sharing in the underlying
        httpx client, as the asyncio event loop does not allow connections to be shared.
        For more details, see https://github.com/encode/httpx/discussions/2959.

        Yields:
            Client: An OpenAI-compatible client instance.
        """
        if self._custom_client is not None:
            # Use the injected client (caller manages lifecycle)
            yield self._custom_client
        else:
            # We initialize an OpenAI context on every request so as to avoid connection sharing in the underlying
            # httpx client. The asyncio event loop does not allow connections to be shared. For more details, please
            # refer to https://github.com/encode/httpx/discussions/2959.
            async with openai.AsyncOpenAI(**self._resolve_client_args()) as client:
                yield client

    @override
    async def stream(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        *,
        tool_choice: ToolChoice | None = None,
        agent_metadata: AgentMetadata | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Stream conversation with the OpenAI model.

        Args:
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            system_prompt: System prompt to provide context to the model.
            tool_choice: Selection strategy for tool invocation.
            agent_metadata: Invoking agent's identity, used to derive a prompt-cache routing key.
            **kwargs: Additional keyword arguments for future extensibility.

        Yields:
            Formatted message chunks from the model.

        Raises:
            ContextWindowOverflowException: If the input exceeds the model's context window.
            ModelThrottledException: If the request is throttled by OpenAI (rate limits).
        """
        logger.debug("formatting request")
        request = self.format_request(messages, tool_specs, system_prompt, tool_choice, agent_metadata=agent_metadata)
        logger.debug("formatted request=<%s>", request)

        logger.debug("invoking model")

        # We initialize an OpenAI context on every request so as to avoid connection sharing in the underlying httpx
        # client. The asyncio event loop does not allow connections to be shared. For more details, please refer to
        # https://github.com/encode/httpx/discussions/2959.
        async with self._get_client() as client:
            try:
                response = await client.chat.completions.create(**request)

                if not request["stream"]:
                    for chunk in self._format_non_streaming_response(response):
                        yield chunk
                    return

                logger.debug("got response from model")
                yield self.format_chunk({"chunk_type": "message_start"})
                tool_calls: dict[int, list[Any]] = {}
                data_type = None
                finish_reason = None  # Store finish_reason for later use
                event = None  # Initialize for scope safety

                async for event in response:
                    # Defensive: skip events with empty or missing choices
                    if not getattr(event, "choices", None):
                        continue
                    choice = event.choices[0]

                    reasoning_content = getattr(choice.delta, "reasoning_content", None)
                    if not isinstance(reasoning_content, str) or not reasoning_content:
                        reasoning_content = getattr(choice.delta, "reasoning", None)

                    if isinstance(reasoning_content, str) and reasoning_content:
                        chunks, data_type = self._stream_switch_content("reasoning_content", data_type)
                        for chunk in chunks:
                            yield chunk
                        yield self.format_chunk(
                            {
                                "chunk_type": "content_delta",
                                "data_type": data_type,
                                "data": reasoning_content,
                            }
                        )

                    if choice.delta.content:
                        chunks, data_type = self._stream_switch_content("text", data_type)
                        for chunk in chunks:
                            yield chunk
                        yield self.format_chunk(
                            {"chunk_type": "content_delta", "data_type": data_type, "data": choice.delta.content}
                        )

                    for tool_call in choice.delta.tool_calls or []:
                        tool_calls.setdefault(tool_call.index, []).append(tool_call)

                    if choice.finish_reason:
                        finish_reason = choice.finish_reason  # Store for use outside loop
                        if data_type:
                            yield self.format_chunk({"chunk_type": "content_stop", "data_type": data_type})
                        break

                for tool_deltas in tool_calls.values():
                    yield self.format_chunk(
                        {"chunk_type": "content_start", "data_type": "tool", "data": tool_deltas[0]}
                    )

                    for tool_delta in tool_deltas:
                        yield self.format_chunk(
                            {"chunk_type": "content_delta", "data_type": "tool", "data": tool_delta}
                        )

                    yield self.format_chunk({"chunk_type": "content_stop", "data_type": "tool"})

                yield self.format_chunk({"chunk_type": "message_stop", "data": finish_reason or "end_turn"})

                # Skip remaining events as we don't have use for anything except the final usage payload
                async for event in response:
                    _ = event

                if event and hasattr(event, "usage") and event.usage:
                    yield self.format_chunk({"chunk_type": "metadata", "data": event.usage})
            except openai.APIError as error:
                error_kind = classify_openai_error(error)
                if error_kind == "throttling":
                    logger.warning("OpenAI threw rate limit error")
                    raise ModelThrottledException(str(error)) from error
                if error_kind == "context_overflow":
                    logger.warning("OpenAI threw context window overflow error")
                    raise ContextWindowOverflowException(str(error)) from error
                raise
        logger.debug("finished streaming response from model")

    def _stream_switch_content(self, data_type: str, prev_data_type: str | None) -> tuple[list[StreamEvent], str]:
        """Handle switching to a new content stream.

        Args:
            data_type: The next content data type.
            prev_data_type: The previous content data type.

        Returns:
            Tuple containing:
            - Stop block for previous content and the start block for the next content.
            - Next content data type.
        """
        chunks = []
        if data_type != prev_data_type:
            if prev_data_type is not None:
                chunks.append(self.format_chunk({"chunk_type": "content_stop", "data_type": prev_data_type}))
            chunks.append(self.format_chunk({"chunk_type": "content_start", "data_type": data_type}))

        return chunks, data_type

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

        Raises:
            ContextWindowOverflowException: If the input exceeds the model's context window.
            ModelThrottledException: If the request is throttled by OpenAI (rate limits).
        """
        # We initialize an OpenAI context on every request so as to avoid connection sharing in the underlying httpx
        # client. The asyncio event loop does not allow connections to be shared. For more details, please refer to
        # https://github.com/encode/httpx/discussions/2959.
        async with self._get_client() as client:
            try:
                request = self.format_request(prompt, system_prompt=system_prompt)
                # parse() is non-streaming; stream=True would raise, so drop the streaming-only fields.
                request.pop("stream", None)
                request.pop("stream_options", None)
                response: ParsedChatCompletion = await client.beta.chat.completions.parse(
                    **request, response_format=output_model
                )
            except openai.APIError as error:
                error_kind = classify_openai_error(error)
                if error_kind == "throttling":
                    logger.warning("OpenAI threw rate limit error")
                    raise ModelThrottledException(str(error)) from error
                if error_kind == "context_overflow":
                    logger.warning("OpenAI threw context window overflow error")
                    raise ContextWindowOverflowException(str(error)) from error
                raise

        parsed: T | None = None
        # Find the first choice with tool_calls
        if len(response.choices) > 1:
            raise ValueError("Multiple choices found in the OpenAI response.")

        for choice in response.choices:
            if isinstance(choice.message.parsed, output_model):
                parsed = choice.message.parsed
                break

        if parsed:
            yield {"output": parsed}
        else:
            raise ValueError("No valid tool use or tool use input was found in the OpenAI response.")

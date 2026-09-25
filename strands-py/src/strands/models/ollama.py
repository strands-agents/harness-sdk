"""Ollama model provider.

- Docs: https://ollama.com/
"""

import json
import logging
import uuid
from collections.abc import AsyncGenerator
from typing import Any, TypeVar, cast

import ollama
from pydantic import BaseModel
from typing_extensions import Unpack, override

from ..types.content import ContentBlock, Messages
from ..types.exceptions import ContextWindowOverflowException
from ..types.streaming import StopReason, StreamEvent
from ..types.tools import ToolChoice, ToolSpec
from ._validation import (
    _has_location_source,
    validate_config_keys,
    warn_on_cache_config_not_supported,
    warn_on_tool_choice_not_supported,
)
from .model import BaseModelConfig, CacheConfig, Model

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


class OllamaModel(Model):
    """Ollama model provider implementation.

    The implementation handles Ollama-specific features such as:

    - Local model invocation
    - Streaming responses
    - Tool/function calling
    """

    OVERFLOW_MESSAGES = {
        "the prompt is longer than the context length",
        "the input length exceeds the context length",
        "exceeds the available context",
        "exceeded max context length",
    }

    class OllamaConfig(BaseModelConfig, total=False):
        """Configuration parameters for Ollama models.

        Attributes:
            additional_args: Any additional arguments to include in the request.
            cache_config: Prompt caching settings. Ollama honors no cache fields, so any set field is ignored.
            keep_alive: Controls how long the model will stay loaded into memory following the request (default: "5m").
            max_tokens: Maximum number of tokens to generate in the response.
            model_id: Ollama model ID (e.g., "llama3", "mistral", "phi3").
            options: Additional model parameters (e.g., top_k).
            stop_sequences: List of sequences that will stop generation when encountered.
            temperature: Controls randomness in generation (higher = more random).
            top_p: Controls diversity via nucleus sampling (alternative to temperature).
        """

        additional_args: dict[str, Any] | None
        cache_config: CacheConfig | None
        keep_alive: str | None
        max_tokens: int | None
        model_id: str
        options: dict[str, Any] | None
        stop_sequences: list[str] | None
        temperature: float | None
        top_p: float | None

    def __init__(
        self,
        host: str | None,
        *,
        ollama_client_args: dict[str, Any] | None = None,
        **model_config: Unpack[OllamaConfig],
    ) -> None:
        """Initialize provider instance.

        Args:
            host: The address of the Ollama server hosting the model.
            ollama_client_args: Additional arguments for the Ollama client.
            **model_config: Configuration options for the Ollama model.
        """
        self.host = host
        self.client_args = ollama_client_args or {}
        validate_config_keys(model_config, self.OllamaConfig)
        self.config = OllamaModel.OllamaConfig(**model_config)

        logger.debug("config=<%s> | initializing", self.config)

    @override
    def update_config(self, **model_config: Unpack[OllamaConfig]) -> None:  # type: ignore
        """Update the Ollama Model configuration with the provided arguments.

        Args:
            **model_config: Configuration overrides.
        """
        validate_config_keys(model_config, self.OllamaConfig)
        self.config.update(model_config)

    @override
    def get_config(self) -> OllamaConfig:
        """Get the Ollama model configuration.

        Returns:
            The Ollama model configuration.
        """
        return self.config

    def _format_request_message_contents(self, role: str, content: ContentBlock) -> list[dict[str, Any]]:
        """Format Ollama compatible message contents.

        Ollama doesn't support an array of contents, so we must flatten everything into separate message blocks.

        Args:
            role: E.g., user.
            content: Content block to format.

        Returns:
            Ollama formatted message contents.

        Raises:
            TypeError: If the content block type cannot be converted to an Ollama-compatible format.
        """
        if "text" in content:
            return [{"role": role, "content": content["text"]}]

        if "image" in content:
            return [{"role": role, "images": [content["image"]["source"]["bytes"]]}]

        if "toolUse" in content:
            return [
                {
                    "role": role,
                    "tool_calls": [
                        {
                            "function": {
                                "name": content["toolUse"]["name"],
                                "arguments": content["toolUse"]["input"],
                            }
                        }
                    ],
                }
            ]

        if "toolResult" in content:
            return [
                formatted_tool_result_content
                for tool_result_content in content["toolResult"]["content"]
                for formatted_tool_result_content in self._format_request_message_contents(
                    "tool",
                    (
                        {"text": json.dumps(tool_result_content["json"], ensure_ascii=False)}
                        if "json" in tool_result_content
                        else cast(ContentBlock, tool_result_content)
                    ),
                )
            ]

        raise TypeError(f"content_type=<{next(iter(content))}> | unsupported type")

    def _format_request_messages(self, messages: Messages, system_prompt: str | None = None) -> list[dict[str, Any]]:
        """Format an Ollama compatible messages array.

        Args:
            messages: List of message objects to be processed by the model.
            system_prompt: System prompt to provide context to the model.

        Returns:
            An Ollama compatible messages array.
        """
        system_message = [{"role": "system", "content": system_prompt}] if system_prompt else []

        formatted_messages = []
        for message in messages:
            for content in message["content"]:
                # Check for location sources and skip with warning
                if _has_location_source(content):
                    logger.warning("Location sources are not supported by Ollama | skipping content block")
                    continue
                formatted_messages.extend(self._format_request_message_contents(message["role"], content))

        return system_message + formatted_messages

    def format_request(
        self, messages: Messages, tool_specs: list[ToolSpec] | None = None, system_prompt: str | None = None
    ) -> dict[str, Any]:
        """Format an Ollama chat streaming request.

        Args:
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            system_prompt: System prompt to provide context to the model.

        Returns:
            An Ollama chat streaming request.

        Raises:
            TypeError: If a message contains a content block type that cannot be converted to an Ollama-compatible
                format.
        """
        request = {
            "messages": self._format_request_messages(messages, system_prompt),
            "model": self.config["model_id"],
            "options": {
                **(self.config.get("options") or {}),
                **{
                    key: value
                    for key, value in [
                        ("num_predict", self.config.get("max_tokens")),
                        ("temperature", self.config.get("temperature")),
                        ("top_p", self.config.get("top_p")),
                        ("stop", self.config.get("stop_sequences")),
                    ]
                    if value is not None
                },
            },
            "stream": True,
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
            **({"keep_alive": self.config["keep_alive"]} if self.config.get("keep_alive") else {}),
            **(
                self.config["additional_args"]
                if "additional_args" in self.config and self.config["additional_args"] is not None
                else {}
            ),
        }
        # Ollama applies no CacheConfig fields; warn that any set field is ignored.
        warn_on_cache_config_not_supported(self.config.get("cache_config"), "Ollama", supported=set(), stacklevel=3)
        return request

    def format_chunk(self, event: dict[str, Any]) -> StreamEvent:
        """Format the Ollama response events into standardized message chunks.

        Args:
            event: A response event from the Ollama model.

        Returns:
            The formatted chunk.

        Raises:
            RuntimeError: If chunk_type is not recognized.
                This error should never be encountered as we control chunk_type in the stream method.
        """
        match event["chunk_type"]:
            case "message_start":
                return {"messageStart": {"role": "assistant"}}

            case "content_start":
                if event["data_type"] == "text":
                    return {"contentBlockStart": {"start": {}}}

                tool_name = event["data"].function.name
                tool_use_id = f"tooluse_{uuid.uuid4().hex[:24]}"
                return {"contentBlockStart": {"start": {"toolUse": {"name": tool_name, "toolUseId": tool_use_id}}}}

            case "content_delta":
                if event["data_type"] == "text":
                    return {"contentBlockDelta": {"delta": {"text": event["data"]}}}

                tool_arguments = event["data"].function.arguments
                return {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(tool_arguments)}}}}

            case "content_stop":
                return {"contentBlockStop": {}}

            case "message_stop":
                reason: StopReason
                if event["data"] == "tool_use":
                    reason = "tool_use"
                elif event["data"] == "length":
                    reason = "max_tokens"
                else:
                    reason = "end_turn"

                return {"messageStop": {"stopReason": reason}}

            case "metadata":
                return {
                    "metadata": {
                        "usage": {
                            "inputTokens": event["data"].prompt_eval_count,
                            "outputTokens": event["data"].eval_count,
                            "totalTokens": event["data"].eval_count + event["data"].prompt_eval_count,
                        },
                        "metrics": {
                            "latencyMs": int(event["data"].total_duration / 1e6),
                        },
                    },
                }

            case _:
                raise RuntimeError(f"chunk_type=<{event['chunk_type']} | unknown type")

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
        """Stream conversation with the Ollama model.

        Args:
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            system_prompt: System prompt to provide context to the model.
            tool_choice: Selection strategy for tool invocation. **Note: This parameter is accepted for
                interface consistency but is currently ignored for this model provider.**
            **kwargs: Additional keyword arguments for future extensibility.

        Yields:
            Formatted message chunks from the model.

        Raises:
            ContextWindowOverflowException: If the input exceeds the model's context window.
        """
        warn_on_tool_choice_not_supported(tool_choice)

        logger.debug("formatting request")
        request = self.format_request(messages, tool_specs, system_prompt)
        logger.debug("request=<%s>", request)

        logger.debug("invoking model")
        tool_requested = False
        event = None

        client = ollama.AsyncClient(self.host, **self.client_args)

        # Ollama issues the request lazily, so overflow can surface at chat() or during iteration.
        try:
            response = await client.chat(**request)

            logger.debug("got response from model")
            yield self.format_chunk({"chunk_type": "message_start"})
            yield self.format_chunk({"chunk_type": "content_start", "data_type": "text"})

            async for event in response:
                for tool_call in event.message.tool_calls or []:
                    yield self.format_chunk({"chunk_type": "content_start", "data_type": "tool", "data": tool_call})
                    yield self.format_chunk({"chunk_type": "content_delta", "data_type": "tool", "data": tool_call})
                    yield self.format_chunk({"chunk_type": "content_stop", "data_type": "tool", "data": tool_call})
                    tool_requested = True

                yield self.format_chunk(
                    {"chunk_type": "content_delta", "data_type": "text", "data": event.message.content}
                )
        except ollama.ResponseError as error:
            if any(message in str(error).lower() for message in self.OVERFLOW_MESSAGES):
                raise ContextWindowOverflowException(str(error)) from error
            raise

        stop_reason = "tool_use" if tool_requested else (event.done_reason if event else None)

        yield self.format_chunk({"chunk_type": "content_stop", "data_type": "text"})
        yield self.format_chunk({"chunk_type": "message_stop", "data": stop_reason})
        if event is not None:
            yield self.format_chunk({"chunk_type": "metadata", "data": event})

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

        Raises:
            ContextWindowOverflowException: If the input exceeds the model's context window.
        """
        formatted_request = self.format_request(messages=prompt, system_prompt=system_prompt)
        formatted_request["format"] = output_model.model_json_schema()
        formatted_request["stream"] = False

        client = ollama.AsyncClient(self.host, **self.client_args)
        try:
            response = await client.chat(**formatted_request)
        except ollama.ResponseError as error:
            if any(message in str(error).lower() for message in self.OVERFLOW_MESSAGES):
                raise ContextWindowOverflowException(str(error)) from error
            raise

        try:
            content = response.message.content.strip()
            yield {"output": output_model.model_validate_json(content)}
        except Exception as e:
            raise ValueError(f"Failed to parse or load content into model: {e}") from e

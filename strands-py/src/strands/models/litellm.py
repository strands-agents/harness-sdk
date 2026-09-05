"""LiteLLM model provider.

- Docs: https://docs.litellm.ai/
"""

import contextlib
import io
import json
import logging
import uuid
from collections.abc import AsyncGenerator
from typing import Any, TypeVar, cast

import litellm
from litellm.exceptions import ContextWindowExceededError
from litellm.utils import supports_response_schema
from pydantic import BaseModel
from typing_extensions import Unpack, override

from ..tools import convert_pydantic_to_tool_spec
from ..types.content import ContentBlock, Messages, SystemContentBlock
from ..types.event_loop import Usage
from ..types.exceptions import ContextWindowOverflowException
from ..types.streaming import MetadataEvent, StreamEvent
from ..types.tools import ToolChoice, ToolSpec, ToolUse
from ._validation import validate_config_keys
from .model import BaseModelConfig, CacheConfig
from .openai import OpenAIModel

logger = logging.getLogger(__name__)

# Separator used by LiteLLM to embed thought signatures inside tool call IDs.
# See: https://ai.google.dev/gemini-api/docs/thought-signatures
_THOUGHT_SIGNATURE_SEPARATOR = "__thought__"

T = TypeVar("T", bound=BaseModel)


class LiteLLMModel(OpenAIModel):
    """LiteLLM model provider implementation."""

    class LiteLLMConfig(BaseModelConfig, total=False):
        """Configuration options for LiteLLM models.

        Attributes:
            model_id: Model ID (e.g., "openai/gpt-4o", "anthropic/claude-3-sonnet").
                For a complete list of supported models, see https://docs.litellm.ai/docs/providers.
            params: Model parameters (e.g., max_tokens).
                For a complete list of supported parameters, see
                https://docs.litellm.ai/docs/completion/input#input-params-1.
            stream: Whether to use streaming. Defaults to True.
            cache_config: Prompt-caching configuration. Consumed by LiteLLM's OpenAI-compatible
                request path exactly as by ``OpenAIModel``.
        """

        model_id: str
        params: dict[str, Any] | None
        stream: bool
        cache_config: CacheConfig | None

    def __init__(self, client_args: dict[str, Any] | None = None, **model_config: Unpack[LiteLLMConfig]) -> None:
        """Initialize provider instance.

        Args:
            client_args: Arguments for the LiteLLM client.
                For a complete list of supported arguments, see
                https://github.com/BerriAI/litellm/blob/main/litellm/main.py.
            **model_config: Configuration options for the LiteLLM model.
        """
        self.client_args = client_args or {}
        validate_config_keys(model_config, self.LiteLLMConfig)
        self.config = dict(model_config)
        self._apply_proxy_prefix()

        logger.debug("config=<%s> | initializing", self.config)

    @override
    def update_config(self, **model_config: Unpack[LiteLLMConfig]) -> None:  # type: ignore[override]
        """Update the LiteLLM model configuration with the provided arguments.

        Args:
            **model_config: Configuration overrides.
        """
        validate_config_keys(model_config, self.LiteLLMConfig)
        self.config.update(model_config)
        self._apply_proxy_prefix()

    @override
    def get_config(self) -> LiteLLMConfig:
        """Get the LiteLLM model configuration.

        Returns:
            The LiteLLM model configuration.
        """
        return cast(LiteLLMModel.LiteLLMConfig, self.config)

    @override
    @classmethod
    def format_request_message_content(cls, content: ContentBlock, **kwargs: Any) -> dict[str, Any]:
        """Format a LiteLLM content block.

        Args:
            content: Message content.
            **kwargs: Additional keyword arguments for future extensibility.

        Returns:
            LiteLLM formatted content block.

        Raises:
            TypeError: If the content block type cannot be converted to a LiteLLM-compatible format.
        """
        if "reasoningContent" in content:
            return {
                "signature": content["reasoningContent"]["reasoningText"]["signature"],
                "thinking": content["reasoningContent"]["reasoningText"]["text"],
                "type": "thinking",
            }

        if "video" in content:
            return {
                "type": "video_url",
                "video_url": {
                    "detail": "auto",
                    "url": content["video"]["source"]["bytes"],
                },
            }

        return super().format_request_message_content(content)

    @override
    @classmethod
    def format_request_message_tool_call(cls, tool_use: ToolUse, **kwargs: Any) -> dict[str, Any]:
        """Format a LiteLLM compatible tool call, encoding thought signatures into the tool call ID.

        Gemini thinking models attach a thought_signature to each function call. LiteLLM's OpenAI-compatible
        interface embeds this signature inside the tool call ID using the ``__thought__`` separator. When
        ``reasoningSignature`` is present and the tool call ID does not already contain the separator, this
        method encodes it so LiteLLM can reconstruct the Gemini-native format on the next request.

        Args:
            tool_use: Tool use requested by the model.
            **kwargs: Additional keyword arguments for future extensibility.

        Returns:
            LiteLLM compatible tool call dict with thought signature encoded in the ID when present.
        """
        tool_call = super().format_request_message_tool_call(tool_use, **kwargs)

        reasoning_signature = tool_use.get("reasoningSignature")
        if reasoning_signature and _THOUGHT_SIGNATURE_SEPARATOR not in tool_call["id"]:
            tool_call["id"] = f"{tool_call['id']}{_THOUGHT_SIGNATURE_SEPARATOR}{reasoning_signature}"

        return tool_call

    @staticmethod
    def _extract_thought_signature(data: Any) -> str | None:
        """Extract thought signature from a tool call event data.

        LiteLLM surfaces Gemini thought signatures in two ways:

        1. ``provider_specific_fields.thought_signature`` — a structured field set by LiteLLM's Gemini response
           transformer. Checked first as it doesn't depend on matching an internal string constant.
        2. ``__thought__`` separator encoded in the tool call ID. Used as fallback since it relies on a copy of
           LiteLLM's internal ``THOUGHT_SIGNATURE_SEPARATOR`` constant.

        Args:
            data: Tool call event data object.

        Returns:
            The extracted thought signature, or None if not present.
        """
        # Preferred: structured field that doesn't depend on matching an internal separator string
        psf = getattr(data, "provider_specific_fields", None) or {}
        if isinstance(psf, dict) and psf.get("thought_signature"):
            return str(psf["thought_signature"])

        # Fallback: extract from encoded ID (relies on hardcoded copy of LiteLLM's separator)
        tool_call_id = getattr(data, "id", None) or ""
        if isinstance(tool_call_id, str) and _THOUGHT_SIGNATURE_SEPARATOR in tool_call_id:
            _, signature = tool_call_id.split(_THOUGHT_SIGNATURE_SEPARATOR, 1)
            return signature

        return None

    def _compute_cost(self, usage: Any) -> float | None:
        """Estimate the USD cost of a model call from its LiteLLM usage object.

        LiteLLM prices a call from its internal pricing map, which does not cover every model
        (proxy deployments and some provider-prefixed IDs raise). Any failure degrades to ``None``
        so cost tracking never breaks the model call; a missing cost is treated as "not tracked".

        Args:
            usage: The LiteLLM usage object from the response metadata.

        Returns:
            The estimated total cost in USD, or ``None`` if the model could not be priced.
        """
        try:
            response = litellm.ModelResponse(
                usage=litellm.Usage(
                    prompt_tokens=usage.prompt_tokens,
                    completion_tokens=usage.completion_tokens,
                    total_tokens=usage.total_tokens,
                    prompt_tokens_details=getattr(usage, "prompt_tokens_details", None),
                    cache_creation_input_tokens=getattr(usage, "cache_creation_input_tokens", None),
                ),
            )
            with contextlib.redirect_stdout(io.StringIO()):
                return litellm.completion_cost(completion_response=response, model=self.get_config()["model_id"])
        except Exception as error:
            logger.debug("model_id=<%s>, error=<%s> | could not estimate cost", self.get_config()["model_id"], error)
            return None

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
    @classmethod
    def _format_system_messages(
        cls,
        system_prompt: str | None = None,
        *,
        system_prompt_content: list[SystemContentBlock] | None = None,
        **kwargs: Any,
    ) -> list[dict[str, Any]]:
        """Format system messages for LiteLLM with cache point support.

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

        system_content: list[dict[str, Any]] = []
        for block in system_prompt_content or []:
            if "text" in block:
                system_content.append({"type": "text", "text": block["text"]})
            elif "cachePoint" in block and block["cachePoint"]["type"] == "default":
                # Apply cache control to the immediately preceding content block
                # for LiteLLM/Anthropic compatibility
                if system_content:
                    cache_control: dict[str, Any] = {"type": "ephemeral"}
                    if ttl := block["cachePoint"].get("ttl"):
                        cache_control["ttl"] = ttl
                    system_content[-1]["cache_control"] = cache_control

        # Create single system message with content array rather than mulitple system messages
        return [{"role": "system", "content": system_content}] if system_content else []

    @override
    @classmethod
    def format_request_messages(
        cls,
        messages: Messages,
        system_prompt: str | None = None,
        *,
        system_prompt_content: list[SystemContentBlock] | None = None,
        **kwargs: Any,
    ) -> list[dict[str, Any]]:
        """Format a LiteLLM compatible messages array with cache point support.

        Args:
            messages: List of message objects to be processed by the model.
            system_prompt: System prompt to provide context to the model (for legacy compatibility).
            system_prompt_content: System prompt content blocks to provide context to the model.
            **kwargs: Additional keyword arguments for future extensibility.

        Returns:
            A LiteLLM compatible messages array.
        """
        formatted_messages = cls._format_system_messages(system_prompt, system_prompt_content=system_prompt_content)
        formatted_messages.extend(cls._format_regular_messages(messages))

        return [message for message in formatted_messages if "content" in message or "tool_calls" in message]

    @override
    def format_chunk(self, event: dict[str, Any], **kwargs: Any) -> StreamEvent:
        """Format a LiteLLM response event into a standardized message chunk.

        Extends OpenAI's format_chunk to:
        1. Handle metadata with prompt caching support.
        2. Extract thought signatures that LiteLLM embeds in tool call IDs for Gemini thinking models.

        Args:
            event: A response event from the LiteLLM model.
            **kwargs: Additional keyword arguments for future extensibility.

        Returns:
            The formatted chunk.

        Raises:
            RuntimeError: If chunk_type is not recognized.
        """
        # Handle metadata case with prompt caching support
        if event["chunk_type"] == "metadata":
            usage_data: Usage = {
                "inputTokens": event["data"].prompt_tokens,
                "outputTokens": event["data"].completion_tokens,
                "totalTokens": event["data"].total_tokens,
            }

            # Only LiteLLM over Anthropic supports cache write tokens
            # Waiting until a more general approach is available to set cacheWriteInputTokens
            if tokens_details := getattr(event["data"], "prompt_tokens_details", None):
                if cached := getattr(tokens_details, "cached_tokens", None):
                    usage_data["cacheReadInputTokens"] = cached
            if creation := getattr(event["data"], "cache_creation_input_tokens", None):
                usage_data["cacheWriteInputTokens"] = creation

            # Cost is left unset when the model cannot be priced, so consumers can distinguish
            # "not tracked" from a genuine zero.
            if (cost := self._compute_cost(event["data"])) is not None:
                usage_data["totalCostUsd"] = cost

            return StreamEvent(
                metadata=MetadataEvent(
                    metrics={
                        "latencyMs": 0,  # TODO
                    },
                    usage=usage_data,
                )
            )

        # Extract thought signature from tool call content_start events.
        # The full encoded ID is kept in toolUseId so that tool result messages continue to match.
        if event["chunk_type"] == "content_start" and event.get("data_type") == "tool":
            signature = self._extract_thought_signature(event.get("data"))
            chunk = super().format_chunk(event)
            if signature:
                tool_use_dict = cast(dict, chunk["contentBlockStart"]["start"]["toolUse"])
                tool_use_dict["reasoningSignature"] = signature
            return chunk

        # For all other cases, use the parent implementation
        return super().format_chunk(event)

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
        """Stream conversation with the LiteLLM model.

        Args:
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            system_prompt: System prompt to provide context to the model.
            tool_choice: Selection strategy for tool invocation.
            system_prompt_content: System prompt content blocks to provide context to the model.
            **kwargs: Additional keyword arguments for future extensibility.

        Yields:
            Formatted message chunks from the model.
        """
        logger.debug("formatting request")
        request = self.format_request(
            messages, tool_specs, system_prompt, tool_choice, system_prompt_content=system_prompt_content
        )
        logger.debug("request=<%s>", request)

        # format_request resolves streaming from the top-level `stream` config and the legacy
        # params={"stream": ...} path, recording the effective value (and stream_options) on the request.
        is_streaming = request["stream"]

        litellm_request = {**request}

        logger.debug("invoking model with stream=%s", litellm_request.get("stream"))

        try:
            if is_streaming:
                async for chunk in self._handle_streaming_response(litellm_request):
                    yield chunk
            else:
                async for chunk in self._handle_non_streaming_response(litellm_request):
                    yield chunk
        except ContextWindowExceededError as e:
            logger.warning("litellm client raised context window overflow")
            raise ContextWindowOverflowException(e) from e

        logger.debug("finished processing response from model")

    @override
    async def structured_output(
        self, output_model: type[T], prompt: Messages, system_prompt: str | None = None, **kwargs: Any
    ) -> AsyncGenerator[dict[str, T | Any], None]:
        """Get structured output from the model.

        Some models do not support native structured output via response_format.
        In cases of proxies, we may not have a way to determine support, so we
        fallback to using tool calling to achieve structured output.

        Args:
            output_model: The output model to use for the agent.
            prompt: The prompt messages to use for the agent.
            system_prompt: System prompt to provide context to the model.
            **kwargs: Additional keyword arguments for future extensibility.

        Yields:
            Model events with the last being the structured output.
        """
        if supports_response_schema(self.get_config()["model_id"]):
            logger.debug("structuring output using response schema")
            result = await self._structured_output_using_response_schema(output_model, prompt, system_prompt)
        else:
            logger.debug("model does not support response schema, structuring output using tool approach")
            result = await self._structured_output_using_tool(output_model, prompt, system_prompt)

        yield {"output": result}

    async def _structured_output_using_response_schema(
        self, output_model: type[T], prompt: Messages, system_prompt: str | None = None
    ) -> T:
        """Get structured output using native response_format support."""
        response = await litellm.acompletion(
            **self.client_args,
            model=self.get_config()["model_id"],
            messages=self.format_request(prompt, system_prompt=system_prompt)["messages"],
            response_format=output_model,
        )

        if len(response.choices) > 1:
            raise ValueError("Multiple choices found in the response.")
        if not response.choices:
            raise ValueError("No choices found in response")

        choice = response.choices[0]
        try:
            # Parse the message content as JSON
            tool_call_data = json.loads(choice.message.content)
            # Instantiate the output model with the parsed data
            return output_model(**tool_call_data)
        except ContextWindowExceededError as e:
            logger.warning("litellm client raised context window overflow in structured_output")
            raise ContextWindowOverflowException(e) from e
        except (json.JSONDecodeError, TypeError, ValueError) as e:
            raise ValueError(f"Failed to parse or load content into model: {e}") from e

    async def _structured_output_using_tool(
        self, output_model: type[T], prompt: Messages, system_prompt: str | None = None
    ) -> T:
        """Get structured output using tool calling fallback."""
        tool_spec = convert_pydantic_to_tool_spec(output_model)
        request = self.format_request(prompt, [tool_spec], system_prompt, cast(ToolChoice, {"any": {}}))
        args = {**self.client_args, **request, "stream": False}
        response = await litellm.acompletion(**args)

        if len(response.choices) > 1:
            raise ValueError("Multiple choices found in the response.")
        if not response.choices or response.choices[0].finish_reason != "tool_calls":
            raise ValueError("No tool_calls found in response")

        choice = response.choices[0]
        try:
            # Parse the tool call content as JSON
            tool_call = choice.message.tool_calls[0]
            tool_call_data = json.loads(tool_call.function.arguments)
            # Instantiate the output model with the parsed data
            return output_model(**tool_call_data)
        except ContextWindowExceededError as e:
            logger.warning("litellm client raised context window overflow in structured_output")
            raise ContextWindowOverflowException(e) from e
        except (json.JSONDecodeError, TypeError, ValueError) as e:
            raise ValueError(f"Failed to parse or load content into model: {e}") from e

    async def _process_choice_content(
        self, choice: Any, data_type: str | None, tool_calls: dict[int, list[Any]], is_streaming: bool = True
    ) -> AsyncGenerator[tuple[str | None, StreamEvent], None]:
        """Process content from a choice object (streaming or non-streaming).

        Args:
            choice: The choice object from the response.
            data_type: Current data type being processed.
            tool_calls: Dictionary to collect tool calls.
            is_streaming: Whether this is from a streaming response.

        Yields:
            Tuples of (updated_data_type, stream_event).
        """
        # Get the content source - this is the only difference between streaming/non-streaming
        # We use duck typing here: both choice.delta and choice.message have the same interface
        # (reasoning_content, content, tool_calls attributes) but different object structures
        content_source = choice.delta if is_streaming else choice.message

        # Process reasoning content
        if hasattr(content_source, "reasoning_content") and content_source.reasoning_content:
            chunks, data_type = self._stream_switch_content("reasoning_content", data_type)
            for chunk in chunks:
                yield data_type, chunk
            chunk = self.format_chunk(
                {
                    "chunk_type": "content_delta",
                    "data_type": "reasoning_content",
                    "data": content_source.reasoning_content,
                }
            )
            yield data_type, chunk

        # Process text content
        if hasattr(content_source, "content") and content_source.content:
            chunks, data_type = self._stream_switch_content("text", data_type)
            for chunk in chunks:
                yield data_type, chunk
            chunk = self.format_chunk(
                {
                    "chunk_type": "content_delta",
                    "data_type": "text",
                    "data": content_source.content,
                }
            )
            yield data_type, chunk

        # Process tool calls
        if hasattr(content_source, "tool_calls") and content_source.tool_calls:
            if is_streaming:
                # Streaming: tool calls have index attribute for out-of-order delivery
                for tool_call in content_source.tool_calls:
                    tool_calls.setdefault(tool_call.index, []).append(tool_call)
            else:
                # Non-streaming: tool calls arrive in order, use enumerated index
                for i, tool_call in enumerate(content_source.tool_calls):
                    tool_calls.setdefault(i, []).append(tool_call)

    async def _process_tool_calls(self, tool_calls: dict[int, list[Any]]) -> AsyncGenerator[StreamEvent, None]:
        """Process and yield tool call events.

        Args:
            tool_calls: Dictionary of tool calls indexed by their position.

        Yields:
            Formatted tool call chunks.
        """
        for tool_deltas in tool_calls.values():
            first_delta = tool_deltas[0]
            if not first_delta.id:
                first_delta.id = f"call_{uuid.uuid4()}"

            yield self.format_chunk({"chunk_type": "content_start", "data_type": "tool", "data": first_delta})

            for tool_delta in tool_deltas:
                yield self.format_chunk({"chunk_type": "content_delta", "data_type": "tool", "data": tool_delta})

            yield self.format_chunk({"chunk_type": "content_stop", "data_type": "tool"})

    async def _handle_non_streaming_response(
        self, litellm_request: dict[str, Any]
    ) -> AsyncGenerator[StreamEvent, None]:
        """Handle non-streaming response from LiteLLM.

        Args:
            litellm_request: The formatted request for LiteLLM.

        Yields:
            Formatted message chunks from the model.
        """
        response = await litellm.acompletion(**self.client_args, **litellm_request)

        logger.debug("got non-streaming response from model")
        yield self.format_chunk({"chunk_type": "message_start"})

        tool_calls: dict[int, list[Any]] = {}
        data_type: str | None = None
        finish_reason: str | None = None

        if hasattr(response, "choices") and response.choices and len(response.choices) > 0:
            choice = response.choices[0]

            if hasattr(choice, "message") and choice.message:
                # Process content using shared logic
                async for updated_data_type, chunk in self._process_choice_content(
                    choice, data_type, tool_calls, is_streaming=False
                ):
                    data_type = updated_data_type
                    yield chunk

            if hasattr(choice, "finish_reason"):
                finish_reason = choice.finish_reason

        # Stop the current content block if we have one
        if data_type:
            yield self.format_chunk({"chunk_type": "content_stop", "data_type": data_type})

        # Process tool calls
        async for chunk in self._process_tool_calls(tool_calls):
            yield chunk

        yield self.format_chunk({"chunk_type": "message_stop", "data": finish_reason})

        # Add usage information if available
        if hasattr(response, "usage"):
            yield self.format_chunk({"chunk_type": "metadata", "data": response.usage})

    async def _handle_streaming_response(self, litellm_request: dict[str, Any]) -> AsyncGenerator[StreamEvent, None]:
        """Handle streaming response from LiteLLM.

        Args:
            litellm_request: The formatted request for LiteLLM.

        Yields:
            Formatted message chunks from the model.
        """
        # For streaming, use the streaming API
        response = await litellm.acompletion(**self.client_args, **litellm_request)

        logger.debug("got response from model")
        yield self.format_chunk({"chunk_type": "message_start"})

        tool_calls: dict[int, list[Any]] = {}
        data_type: str | None = None
        finish_reason: str | None = None

        async for event in response:
            # Defensive: skip events with empty or missing choices
            if not getattr(event, "choices", None):
                continue
            choice = event.choices[0]

            # Process content using shared logic
            async for updated_data_type, chunk in self._process_choice_content(
                choice, data_type, tool_calls, is_streaming=True
            ):
                data_type = updated_data_type
                yield chunk

            if choice.finish_reason:
                finish_reason = choice.finish_reason
                if data_type:
                    yield self.format_chunk({"chunk_type": "content_stop", "data_type": data_type})
                break

        # Process tool calls
        async for chunk in self._process_tool_calls(tool_calls):
            yield chunk

        yield self.format_chunk({"chunk_type": "message_stop", "data": finish_reason})

        # Skip remaining events as we don't have use for anything except the final usage payload
        async for event in response:
            _ = event
            if usage := getattr(event, "usage", None):
                yield self.format_chunk({"chunk_type": "metadata", "data": usage})

        logger.debug("finished streaming response from model")

    def _apply_proxy_prefix(self) -> None:
        """Apply litellm_proxy/ prefix to model_id when use_litellm_proxy is True.

        This is a workaround for https://github.com/BerriAI/litellm/issues/13454
        where use_litellm_proxy parameter is not honored.
        """
        if self.client_args.get("use_litellm_proxy") and "model_id" in self.config:
            model_id = self.get_config()["model_id"]
            if not model_id.startswith("litellm_proxy/"):
                self.config["model_id"] = f"litellm_proxy/{model_id}"

"""LiteLLM model provider.

- Docs: https://docs.litellm.ai/
"""

import functools
import json
import logging
import uuid
import warnings
from collections import Counter
from collections.abc import AsyncGenerator
from typing import Any, TypeVar, cast

import litellm
from litellm.exceptions import BadRequestError, ContextWindowExceededError
from litellm.utils import supports_response_schema
from pydantic import BaseModel
from typing_extensions import Unpack, override

from ..agent.agent_metadata import AgentMetadata
from ..tools import convert_pydantic_to_tool_spec
from ..types.content import CachePoint, ContentBlock, Message, Messages, SystemContentBlock
from ..types.exceptions import ContextWindowOverflowException
from ..types.streaming import StreamEvent
from ..types.tools import ToolChoice, ToolSpec, ToolUse
from ._cache_points import (
    MAX_CACHE_POINTS,
    cache_control,
    cache_point,
    messages_with_cache_point,
    section_ttl,
    step_back_over_documents,
    system_with_cache_point,
    with_placed_points_normalized,
    with_point_ttls,
)
from ._model_info import ModelCapabilities, ModelInfo, lookup_model, lookup_model_info
from ._validation import _log_skipped_blocks, validate_config_keys
from .model import BaseModelConfig, CacheConfig
from .openai import OpenAIModel

logger = logging.getLogger(__name__)

# LiteLLM backends that turn an OpenAI-format ``cache_control`` part into their own cache points.
_CACHE_CONTROL_PROVIDERS = frozenset({"anthropic", "bedrock", "vertex_ai"})

# Backends known to accept a cache point directly after a non-PDF document; on any other, such as Bedrock or a proxy
# alias whose backend the id does not name, the point steps back over the document.
_AFTER_DOCUMENT_PROVIDERS = frozenset({"anthropic", "vertex_ai"})

# Gateways that route to any backend, so an id without a backend prefix may name a Claude-style one.
_GATEWAY_PROVIDERS = frozenset({"litellm_proxy", "openrouter"})

# Providers whose LiteLLM provider lookup fetches credentials, starting a device-code login when there are none.
_AUTHENTICATING_PROVIDERS = frozenset({"github_copilot", "chatgpt"})

_LITELLM_PROVIDERS = frozenset(str(getattr(provider, "value", provider)) for provider in litellm.provider_list)


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
            cache_config: Prompt-caching configuration. LiteLLM's OpenAI-compatible request path consumes it
                as ``OpenAIModel`` does, except that the routing key is sent only to models LiteLLM accepts
                ``prompt_cache_key`` for. When ``model_info`` says the backend's model takes cache points
                (Anthropic, Bedrock and Vertex AI Claude), it also places them on the system prompt and the
                latest user message. For a proxy alias, whose backend the id does not name, declare it with
                ``model_info=ModelInfo(capabilities=ModelCapabilities(prompt_caching="cache_points"))``.
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

    def _backend(self) -> tuple[str, str] | None:
        """The backend model id and LiteLLM provider the configured model id routes to."""
        return _resolve_backend(self.get_config().get("model_id") or "", self.client_args.get("custom_llm_provider"))

    @property
    @override
    def model_info(self) -> ModelInfo:
        """What the SDK knows about the backend model LiteLLM routes to.

        ``prompt_caching`` comes from the shared model info for the id without its LiteLLM provider prefix. A backend
        that does not take ``cache_control`` reports ``auto`` instead of ``cache_points``, since no cache point
        reaches it.
        """
        return ModelInfo.merge(
            super().model_info,
            _backend_model_info(self._backend()),
            self.get_config().get("model_info"),
        )

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
                    system_content[-1]["cache_control"] = cache_control(block["cachePoint"].get("ttl"))

        # Create single system message with content array rather than multiple system messages
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
        formatted_messages.extend(cls._format_cacheable_messages(messages))

        return [message for message in formatted_messages if "content" in message or "tool_calls" in message]

    @classmethod
    def _format_cacheable_messages(cls, messages: Messages) -> list[dict[str, Any]]:
        """Format messages, turning a message's first ``cachePoint`` into ``cache_control`` on the part before it."""
        if not any("cachePoint" in block for message in messages for block in message["content"]):
            return cls._format_regular_messages(messages)
        formatted: list[dict[str, Any]] = []
        for message in messages:
            cls._format_cacheable_message(message, formatted)
        return formatted

    @classmethod
    def _format_cacheable_message(cls, message: Message, formatted: list[dict[str, Any]]) -> None:
        """Append one formatted message; the content after its cache point is formatted on its own, behind the point."""
        content = message["content"]
        index = next((i for i, block in enumerate(content) if "cachePoint" in block), None)
        if index is None:
            formatted.extend(cls._format_regular_messages([message]))
            return
        point = content[index]["cachePoint"]
        tail = [block for block in content[index + 1 :] if "cachePoint" not in block]
        if any("toolResult" in block for block in tail):
            formatted.extend(cls._format_marking_tool_results(message["role"], content[:index], tail, point))
            return
        formatted.extend(cls._format_regular_messages([{"role": message["role"], "content": content[:index]}]))
        _mark_last_part(formatted, point)
        if tail:
            _append_tail(formatted, cls._format_regular_messages([{"role": message["role"], "content": tail}]))

    @classmethod
    def _format_marking_tool_results(
        cls, role: Any, durable: list[ContentBlock], tail: list[ContentBlock], point: CachePoint
    ) -> list[dict[str, Any]]:
        """Format a message whose cache point sits between tool results, marking the last durable tool result.

        The message is formatted whole, since formatting the halves apart would put a durable tool result's image
        message between tool messages. Without a durable tool result there is no part to mark, so none is.
        """
        whole = cls._format_regular_messages([{"role": role, "content": [*durable, *tail]}])
        durable_ids = {block["toolResult"]["toolUseId"] for block in durable if "toolResult" in block}
        _mark_last_part([item for item in whole if item.get("tool_call_id") in durable_ids], point)
        return whole

    @override
    def format_chunk(self, event: dict[str, Any], **kwargs: Any) -> StreamEvent:
        """Format a LiteLLM response event into a standardized message chunk.

        Extends OpenAI's format_chunk to support legacy Anthropic cache usage and extract
        thought signatures that LiteLLM embeds in tool call IDs for Gemini thinking models.

        Args:
            event: A response event from the LiteLLM model.
            **kwargs: Additional keyword arguments for future extensibility.

        Returns:
            The formatted chunk.

        Raises:
            RuntimeError: If chunk_type is not recognized.
        """
        chunk = super().format_chunk(event)

        if event["chunk_type"] == "metadata":
            # Older LiteLLM versions report Anthropic cache writes outside prompt_tokens_details.
            usage = chunk["metadata"]["usage"]
            cache_write = getattr(event["data"], "cache_creation_input_tokens", None)
            if "cacheWriteInputTokens" not in usage and isinstance(cache_write, int):
                usage["cacheWriteInputTokens"] = cache_write

        # Extract thought signature from tool call content_start events.
        # The full encoded ID is kept in toolUseId so that tool result messages continue to match.
        if event["chunk_type"] == "content_start" and event.get("data_type") == "tool":
            signature = self._extract_thought_signature(event.get("data"))
            if signature:
                tool_use_dict = cast(dict, chunk["contentBlockStart"]["start"]["toolUse"])
                tool_use_dict["reasoningSignature"] = signature

        return chunk

    @override
    def format_request(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        tool_choice: ToolChoice | None = None,
        *,
        system_prompt_content: list[SystemContentBlock] | None = None,
        agent_metadata: AgentMetadata | None = None,
        dynamic_trailing_blocks: int = 0,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Format a LiteLLM chat request.

        Builds the request as ``OpenAIModel`` does. For a backend that takes cache points, with ``cache_config`` set,
        it first places cache points on the system prompt and the latest user message, ahead of its rebuilt trailing
        blocks. It also marks the last tool when ``cache_config.tools_ttl`` asks for it and keeps the request within
        the backend's cache point limit;
        for any other backend it drops message cache points, which only those backends accept. It then leaves out
        the ``prompt_cache_key`` resolved from ``cache_config`` when LiteLLM would reject it for the model.

        Args:
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            system_prompt: System prompt to provide context to the model.
            tool_choice: Selection strategy for tool invocation.
            system_prompt_content: System prompt content blocks to provide context to the model.
            agent_metadata: Invoking agent's metadata.
            dynamic_trailing_blocks: How many trailing blocks of the latest user message are rebuilt on every call, so
                the conversation cache point stays ahead of them.
            **kwargs: Additional keyword arguments for future extensibility.

        Returns:
            A LiteLLM chat request.

        Raises:
            TypeError: If a message contains a content block type that cannot be converted to a LiteLLM-compatible
                format.
        """
        takes_cache_points = self._takes_cache_points()
        cache_config = self.get_config().get("cache_config")
        if not takes_cache_points:
            messages = _without_message_cache_points(messages)
        else:
            backend = self._backend()
            after_documents = backend is not None and backend[1] in _AFTER_DOCUMENT_PROVIDERS
            messages_ttl = section_ttl(cache_config.messages_ttl, cache_config.ttl) if cache_config else None
            messages = with_placed_points_normalized(
                messages, messages_ttl, step_back=not after_documents, align_ttl=cache_config is not None
            )
            if cache_config is not None:
                system_prompt_content, messages = _with_cache_points(
                    cache_config,
                    system_prompt,
                    system_prompt_content,
                    messages,
                    dynamic_trailing_blocks,
                    after_documents=after_documents,
                )
        request = super().format_request(
            messages,
            tool_specs,
            system_prompt,
            tool_choice,
            system_prompt_content=system_prompt_content,
            agent_metadata=agent_metadata,
            **kwargs,
        )
        if takes_cache_points:
            _add_tools_cache_point(request, cache_config)
            _limit_cache_points(request)
        self._drop_rejected_cache_key(request)
        return request

    def _takes_cache_points(self) -> bool:
        """Whether requests carry cache points: the model takes them, or ``strategy="anthropic"`` asks for them.

        ``strategy="anthropic"`` places them without the model info's say-so, as ``AnthropicModel`` and
        ``BedrockModel`` do, but only where the backend can be a Claude-style one: a Claude model, the ``anthropic``
        provider, or a gateway whose id names none of its backend. Elsewhere it would cost an OpenAI
        backend its routing key, and on Gemini LiteLLM turns a cache point into a billed cached-content resource.
        """
        prompt_caching = self.model_info.capabilities.prompt_caching
        if prompt_caching == "cache_points":
            return True
        cache_config = self.get_config().get("cache_config")
        if cache_config is None or cache_config.strategy != "anthropic" or prompt_caching == "unsupported":
            return False
        backend = self._backend()
        # A Claude id on a gateway reports auto, since the gateway route is not known to take cache_control.
        if prompt_caching == "auto" and not (backend and "claude" in backend[0].lower()):
            return False
        return _may_take_cache_points(backend)

    @override
    def _routing_cache_config(self) -> CacheConfig | None:
        """Only the routing key, for a backend that takes cache points; the other fields shape its cache points."""
        cache_config = super()._routing_cache_config()
        if cache_config is None or not self._takes_cache_points():
            return cache_config
        return CacheConfig(cache_key=cache_config.cache_key)

    def _drop_rejected_cache_key(self, request: dict[str, Any]) -> None:
        """Leave out the resolved ``prompt_cache_key`` when LiteLLM would reject it; a key set in ``params`` stays."""
        config = self.get_config()
        if (
            "prompt_cache_key" not in request
            or "prompt_cache_key" in (config.get("params") or {})
            or self._accepts_prompt_cache_key()
        ):
            return

        del request["prompt_cache_key"]
        cache_config = config.get("cache_config")
        if cache_config and cache_config.cache_key:
            warnings.warn(
                f"cache_config.cache_key has no effect on {request['model']}, which does not accept "
                "prompt_cache_key through LiteLLM; it will be ignored.",
                stacklevel=4,
            )

    def _accepts_prompt_cache_key(self) -> bool:
        """Whether LiteLLM passes ``prompt_cache_key`` for the configured model instead of raising."""
        if "prompt_cache_key" in (self.client_args.get("allowed_openai_params") or []):
            return True
        # A model that takes cache points is not an OpenAI one, even when a proxy alias hides its backend.
        if self._takes_cache_points():
            return False
        # LiteLLM versions that do not know the parameter forward it without validation.
        if not _litellm_validates_prompt_cache_key():
            return True

        supported_params = litellm.get_supported_openai_params(
            model=self.get_config()["model_id"],
            custom_llm_provider=self.client_args.get("custom_llm_provider"),
        )
        return supported_params is None or "prompt_cache_key" in supported_params

    @override
    async def stream(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        *,
        tool_choice: ToolChoice | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None,
        agent_metadata: AgentMetadata | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Stream conversation with the LiteLLM model.

        Args:
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            system_prompt: System prompt to provide context to the model.
            tool_choice: Selection strategy for tool invocation.
            system_prompt_content: System prompt content blocks to provide context to the model.
            agent_metadata: Invoking agent's metadata.
            **kwargs: Additional keyword arguments for future extensibility.

        Yields:
            Formatted message chunks from the model.
        """
        logger.debug("formatting request")
        request = self.format_request(
            messages,
            tool_specs,
            system_prompt,
            tool_choice,
            system_prompt_content=system_prompt_content,
            agent_metadata=agent_metadata,
            dynamic_trailing_blocks=kwargs.get("dynamic_trailing_blocks", 0),
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


@functools.lru_cache(maxsize=256)
def _resolve_backend(model_id: str, custom_llm_provider: str | None) -> tuple[str, str] | None:
    """The backend model id and LiteLLM provider for a LiteLLM model id, or None when LiteLLM cannot map it.

    Cached because LiteLLM prints a notice each time it fails to map an id. A ``litellm_proxy/`` id that still names
    its backend, as ``use_litellm_proxy`` produces, resolves to that backend. An id naming a provider whose lookup
    logs in is split by hand, so building a model does no I/O.
    """
    declared = custom_llm_provider or model_id.split("/", 1)[0]
    if declared in _AUTHENTICATING_PROVIDERS:
        return model_id.removeprefix(f"{declared}/"), declared
    try:
        backend_id, provider, _, _ = litellm.get_llm_provider(model_id, custom_llm_provider=custom_llm_provider)
    except BadRequestError:
        return None
    if provider == "litellm_proxy" and backend_id.split("/", 1)[0] in _LITELLM_PROVIDERS:
        return _resolve_backend(backend_id, None) or (backend_id, provider)
    return backend_id, provider


def _may_take_cache_points(backend: tuple[str, str] | None) -> bool:
    """Whether a backend can be one that takes cache points, for ``strategy="anthropic"`` to place them on.

    A Claude model can, on any provider, and so can anything on ``anthropic/``. Bedrock and Vertex AI also host models
    that can't (Gemini, Nova), so there the model must be Claude. An unknown backend can, and so can a bare gateway
    alias the shared model info doesn't know; a gateway id naming its backend can only when that is Anthropic.
    Gemini never can.
    """
    if backend is None:
        return True
    backend_id, provider = backend
    model = backend_id.lower()
    if "gemini" in model:
        return False
    if "claude" in model or provider == "anthropic":
        return True
    if provider not in _GATEWAY_PROVIDERS:
        return False
    if "/" in backend_id:
        return backend_id.split("/", 1)[0] == "anthropic"
    # A bare alias the shared model info knows is that model, not an unknown backend.
    return lookup_model(backend_id) is None


def _litellm_validates_prompt_cache_key() -> bool:
    """Whether this LiteLLM version knows ``prompt_cache_key``, and so rejects it for providers that do not list it.

    Some versions validate it before listing it in ``OPENAI_CHAT_COMPLETION_PARAMS``; their default parameter values
    already carry it.
    """
    defaults = getattr(getattr(litellm, "constants", None), "DEFAULT_CHAT_COMPLETION_PARAM_VALUES", {})
    return "prompt_cache_key" in litellm.OPENAI_CHAT_COMPLETION_PARAMS or "prompt_cache_key" in defaults


def _backend_model_info(backend: tuple[str, str] | None) -> ModelInfo | None:
    """How the backend model caches prompts, or None when the backend is unknown.

    Only ``prompt_caching`` is taken from the backend's shared model info; the other capabilities are what the
    OpenAI-compatible request path can send, which ``OpenAIModel`` already reports.
    """
    if backend is None:
        return None
    backend_id, provider = backend
    prompt_caching = lookup_model_info(backend_id).capabilities.prompt_caching
    # A Claude id the shared model info does not list yet, such as an alias or a new release, takes cache points.
    if prompt_caching is None and provider in _CACHE_CONTROL_PROVIDERS and "claude" in backend_id.lower():
        prompt_caching = "cache_points"
    if prompt_caching == "cache_points" and provider not in _CACHE_CONTROL_PROVIDERS:
        prompt_caching = "auto"
    return ModelInfo(capabilities=ModelCapabilities(prompt_caching=prompt_caching))


def _mark_last_part(formatted: list[dict[str, Any]], cache_point: CachePoint) -> None:
    """Put ``cache_control`` on the last content part of the last formatted message that has content.

    An empty tool result has no part to carry it, so the point moves back to the message before it.
    """
    message = next((message for message in reversed(formatted) if message.get("content")), None)
    if message is None:
        return
    if isinstance(message["content"], str):
        message["content"] = [{"type": "text", "text": message["content"]}]
    message["content"][-1]["cache_control"] = cache_control(cache_point.get("ttl"))


def _append_tail(formatted: list[dict[str, Any]], tail: list[dict[str, Any]]) -> None:
    """Append content formatted after a cache point, joining it to the message it was split from when it can."""
    last = formatted[-1] if formatted else None
    first = tail[0] if tail else None
    if last and first and last["role"] == first["role"] == "user" and "content" in last and "content" in first:
        last["content"] = [*last["content"], *tail.pop(0)["content"]]
    formatted.extend(tail)


def _without_message_cache_points(messages: Messages) -> Messages:
    """The messages without their cache point blocks, which only backends that take cache points accept."""
    count = sum("cachePoint" in block for message in messages for block in message["content"])
    if not count:
        return messages
    _log_skipped_blocks(
        logger, Counter({"cachePoint content block is not supported by this backend | skipping": count})
    )
    return [{**message, "content": [b for b in message["content"] if "cachePoint" not in b]} for message in messages]


def _add_tools_cache_point(request: dict[str, Any], cache_config: CacheConfig | None) -> None:
    """Mark the last tool with ``cache_control`` when ``tools_ttl`` is True or a TTL string."""
    if cache_config is None or cache_config.tools_ttl in (None, False) or not request.get("tools"):
        return
    ttl = section_ttl(cache_config.tools_ttl, cache_config.ttl)
    marked = {**request["tools"][-1], "cache_control": cache_control(ttl)}
    request["tools"] = [*request["tools"][:-1], marked]


def _limit_cache_points(request: dict[str, Any]) -> None:
    """Drop cache points over the backend's limit, keeping the first ones and the last.

    The last is the conversation point that grows each call; the first are tools and system, which every call reads.
    """
    marked = [part for part in _request_parts(request) if "cache_control" in part]
    if len(marked) <= MAX_CACHE_POINTS:
        return
    for part in marked[MAX_CACHE_POINTS - 1 : -1]:
        del part["cache_control"]
    logger.warning(
        "count=<%d>, limit=<%d> | dropped cache points over the limit, keeping the first ones and the last",
        len(marked) - MAX_CACHE_POINTS,
        MAX_CACHE_POINTS,
    )


def _request_parts(request: dict[str, Any]) -> list[dict[str, Any]]:
    """The tools, then every content part of every message, in request order."""
    parts: list[dict[str, Any]] = list(request.get("tools") or [])
    for message in request["messages"]:
        if isinstance(message.get("content"), list):
            parts.extend(message["content"])
    return parts


def _with_cache_points(
    cache_config: CacheConfig,
    system_prompt: str | None,
    system_prompt_content: list[SystemContentBlock] | None,
    messages: Messages,
    dynamic_trailing_blocks: int,
    *,
    after_documents: bool,
) -> tuple[list[SystemContentBlock] | None, Messages]:
    """Add the automatic cache points: one at the end of the system prompt and one in the latest user message.

    The conversation point goes ahead of the latest user message's rebuilt trailing blocks. A system prompt where the
    caller already placed a cache point keeps it, filled with the section's TTL when it carries none; the caller's
    message points were already normalized. Neither input is changed.

    Args:
        cache_config: The provider's cache settings.
        system_prompt: The system prompt string, used when no content blocks are given.
        system_prompt_content: The system prompt content blocks.
        messages: The messages to send.
        dynamic_trailing_blocks: How many trailing blocks of the latest user message are rebuilt on every call.
        after_documents: Whether a point may directly follow a non-PDF document. Bedrock rejects that, so elsewhere
            the point steps back over them.

    Returns:
        The system prompt content and the messages to send.
    """
    system_ttl = section_ttl(cache_config.system_prompt_ttl, cache_config.ttl)
    messages_ttl = section_ttl(cache_config.messages_ttl, cache_config.ttl)
    system_prompt_content = with_point_ttls(system_prompt_content, system_ttl)
    if cache_config.system_prompt_ttl is not False:
        system_prompt_content = system_with_cache_point(system_prompt, system_prompt_content, cache_point(system_ttl))
    if cache_config.messages_ttl is not False:
        boundary_rule = None if after_documents else step_back_over_documents
        point = cache_point(messages_ttl)
        messages = messages_with_cache_point(messages, dynamic_trailing_blocks, point, boundary_rule)
    return system_prompt_content, messages

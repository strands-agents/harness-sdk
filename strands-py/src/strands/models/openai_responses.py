"""OpenAI model provider using the Responses API.

Built-in tools (e.g. web_search, file_search, code_interpreter) can be passed via the
``params`` configuration and will be merged with any agent function tools in the request.

All built-in tools produce text responses that stream correctly. Limitations on tool-specific
metadata:

- web_search (supported): Full support including URL citations.
- file_search (partial): File citation annotations not emitted (no matching CitationLocation variant).
- code_interpreter (partial): Executed code and stdout/stderr not surfaced.
- mcp (partial): Approval flow and ``mcp_list_tools``/``mcp_call`` events not surfaced.
- shell (partial): Local (client-executed) mode not supported.
- tool_search (not supported): Requires ``defer_loading`` on function tools, which is not supported.
- image_generation (not supported): Requires image content block delta support in the event loop.
- computer_use_preview (not supported): Requires a developer-managed screenshot/action loop.

Docs: https://platform.openai.com/docs/api-reference/responses
"""

import base64
import json
import logging
import mimetypes
from collections.abc import AsyncGenerator
from importlib.metadata import version as get_package_version
from types import SimpleNamespace
from typing import Any, Protocol, TypedDict, TypeVar, cast

from packaging.version import Version
from pydantic import BaseModel
from typing_extensions import Unpack, override

# Validate OpenAI SDK version at import time - Responses API requires v2.0.0+
# A major version bump is proposed in https://github.com/strands-agents/harness-sdk/pull/1370
_MIN_OPENAI_VERSION = Version("2.0.0")

try:
    _openai_version = Version(get_package_version("openai"))
    if _openai_version < _MIN_OPENAI_VERSION:
        raise ImportError(
            f"OpenAIResponsesModel requires openai>={_MIN_OPENAI_VERSION} (found {_openai_version}). "
            "Install/upgrade with: pip install -U openai. "
            "For older SDKs, use OpenAIModel (Chat Completions)."
        )
except ImportError:
    # Re-raise ImportError as-is (covers both our explicit raise above and missing openai package)
    raise
except Exception as e:
    raise ImportError(
        f"OpenAIResponsesModel requires openai>={_MIN_OPENAI_VERSION}. Install with: pip install -U openai"
    ) from e

import openai  # noqa: E402 - must import after version check

from ..types.citations import WebLocationDict  # noqa: E402
from ..types.content import ContentBlock, Messages, Role, SystemContentBlock  # noqa: E402
from ..types.event_loop import Usage  # noqa: E402
from ..types.exceptions import ContextWindowOverflowException, ModelThrottledException  # noqa: E402
from ..types.streaming import StreamEvent  # noqa: E402
from ..types.tools import ToolChoice, ToolResult, ToolSpec, ToolUse  # noqa: E402
from ._defaults import resolve_config_metadata  # noqa: E402
from ._openai_bedrock import BedrockMantleConfig, resolve_bedrock_client_args  # noqa: E402
from ._openai_cache import apply_cache_config  # noqa: E402
from ._openai_errors import classify_openai_error  # noqa: E402
from ._validation import _has_location_source, validate_config_keys  # noqa: E402
from .model import BaseModelConfig, CacheConfig, Model  # noqa: E402

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

# Maximum file size for media content in tool results (20MB)
_MAX_MEDIA_SIZE_BYTES = 20 * 1024 * 1024
_MAX_MEDIA_SIZE_LABEL = "20MB"
_DEFAULT_MIME_TYPE = "application/octet-stream"
_CONTEXT_WINDOW_OVERFLOW_MSG = "OpenAI Responses API threw context window overflow error"
_RATE_LIMIT_MSG = "OpenAI Responses API threw rate limit error"


class _OpenAIResponsesStreamError(RuntimeError):
    """Error reported by a terminal OpenAI Responses API stream event."""

    def __init__(self, message: str | None, code: str | None) -> None:
        super().__init__(message or "OpenAI Responses API response failed")
        self.code = code


def _encode_media_to_data_url(data: bytes, format_ext: str, media_type: str = "image") -> str:
    """Encode media bytes to a base64 data URL with size validation.

    Args:
        data: Raw bytes of the media content.
        format_ext: File format extension (e.g., "png", "pdf").
        media_type: Type of media for error messages ("image" or "document").

    Returns:
        Base64-encoded data URL string.

    Raises:
        ValueError: If the media size exceeds the maximum allowed size.
    """
    if len(data) > _MAX_MEDIA_SIZE_BYTES:
        raise ValueError(
            f"{media_type.capitalize()} size {len(data)} bytes exceeds maximum of"
            f" {_MAX_MEDIA_SIZE_BYTES} bytes ({_MAX_MEDIA_SIZE_LABEL})"
        )
    mime_type = mimetypes.types_map.get(f".{format_ext}", _DEFAULT_MIME_TYPE)
    encoded_data = base64.b64encode(data).decode("utf-8")
    return f"data:{mime_type};base64,{encoded_data}"


class _ToolCallInfo(TypedDict):
    """Internal type for tracking tool call information during streaming."""

    name: str
    arguments: str
    call_id: str
    item_id: str


class Client(Protocol):
    """Protocol defining the OpenAI Responses API interface for the underlying provider client."""

    @property
    # pragma: no cover
    def responses(self) -> Any:
        """Responses interface."""
        ...


class OpenAIResponsesModel(Model):
    """OpenAI Responses API model provider implementation."""

    client: Client
    client_args: dict[str, Any]

    class OpenAIResponsesConfig(BaseModelConfig, total=False):
        """Configuration options for OpenAI Responses API models.

        Attributes:
            model_id: Model ID (e.g., "gpt-4o").
                For a complete list of supported models, see https://platform.openai.com/docs/models.
            params: Model parameters (e.g., max_output_tokens, temperature, etc.).
                For a complete list of supported parameters, see
                https://platform.openai.com/docs/api-reference/responses/create.
            stateful: Whether to enable server-side conversation state management.
                When True, the server stores conversation history and the client does not need to
                send the full message history with each request. Defaults to False.
            use_native_token_count: Whether to use the native OpenAI input_tokens.count API.
                When True, count_tokens() calls the OpenAI API for accurate counts.
                When False (default), skips the API call and uses the local estimator.
            cache_config: Prompt-caching configuration. OpenAI routes cache reads on
                ``cache_key`` (mapped to ``prompt_cache_key``) and honors ``ttl`` only when it names
                an OpenAI retention value; other fields have no effect. An explicit
                ``prompt_cache_key``/``prompt_cache_retention`` in ``params`` takes precedence.
        """

        model_id: str
        params: dict[str, Any] | None
        stateful: bool
        use_native_token_count: bool
        cache_config: CacheConfig | None

    def __init__(
        self,
        client_args: dict[str, Any] | None = None,
        bedrock_mantle_config: BedrockMantleConfig | None = None,
        **model_config: Unpack[OpenAIResponsesConfig],
    ) -> None:
        """Initialize provider instance.

        Args:
            client_args: Arguments for the OpenAI client.
                For a complete list of supported arguments, see https://pypi.org/project/openai/.
                May be combined with ``bedrock_mantle_config``; when both are set, the config
                derives ``base_url`` and ``api_key`` (which must not appear in ``client_args``).
            bedrock_mantle_config: Route requests through Amazon Bedrock's Mantle
                (OpenAI-compatible) endpoint. See :class:`BedrockMantleConfig` for accepted
                keys. When set, a fresh bearer token is minted on every request.
            **model_config: Configuration options for the OpenAI Responses API model.
        """
        validate_config_keys(model_config, self.OpenAIResponsesConfig)
        self.config = dict(model_config)

        self.client_args = client_args or {}
        self._bedrock_mantle_config = bedrock_mantle_config

        if bedrock_mantle_config is not None and client_args:
            conflicting = [k for k in ("api_key", "base_url") if k in client_args]
            if conflicting:
                raise ValueError(
                    f"client_args must not contain {conflicting} when bedrock_mantle_config is set; "
                    "these are derived from the Mantle config automatically."
                )

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

    @property
    @override
    def stateful(self) -> bool:
        """Whether server-side conversation storage is enabled.

        Derived from the ``stateful`` configuration option.
        """
        return bool(self.config.get("stateful"))

    @override
    def update_config(self, **model_config: Unpack[OpenAIResponsesConfig]) -> None:  # type: ignore[override]
        """Update the OpenAI Responses API model configuration with the provided arguments.

        Args:
            **model_config: Configuration overrides.
        """
        validate_config_keys(model_config, self.OpenAIResponsesConfig)
        self.config.update(model_config)

    @override
    def get_config(self) -> OpenAIResponsesConfig:
        """Get the OpenAI Responses API model configuration.

        Returns:
            The OpenAI Responses API model configuration.
        """
        return cast(
            OpenAIResponsesModel.OpenAIResponsesConfig,
            resolve_config_metadata(self.config, str(self.config.get("model_id", ""))),
        )

    @override
    async def count_tokens(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None,
    ) -> int:
        """Count tokens using the OpenAI Responses API input_tokens.count endpoint.

        Uses the same message format as the Responses API to get accurate token counts
        directly from the OpenAI service.

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
            request = self._format_request(messages, tool_specs, system_prompt)
            # Keep only fields accepted by input_tokens.count
            count_tokens_fields = {"model", "input", "instructions", "tools"}
            request = {k: request[k] for k in request.keys() & count_tokens_fields}

            async with openai.AsyncOpenAI(**self._resolve_client_args()) as client:
                response = await client.responses.input_tokens.count(**request)
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
        model_state: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Stream conversation with the OpenAI Responses API model.

        Args:
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            system_prompt: System prompt to provide context to the model.
            tool_choice: Selection strategy for tool invocation.
            model_state: Runtime state for model providers (e.g., server-side response ids).
            **kwargs: Additional keyword arguments for future extensibility.

        Yields:
            Formatted message chunks from the model.

        Raises:
            ContextWindowOverflowException: If the input exceeds the model's context window.
            ModelThrottledException: If the request is throttled by OpenAI (rate limits).
        """
        logger.debug("formatting request for OpenAI Responses API")
        request = self._format_request(messages, tool_specs, system_prompt, tool_choice, model_state)
        logger.debug("formatted request=<%s>", request)

        logger.debug("invoking OpenAI Responses API model")

        async with openai.AsyncOpenAI(**self._resolve_client_args()) as client:
            try:
                response = await client.responses.create(**request)

                logger.debug("streaming response from OpenAI Responses API model")

                yield self._format_chunk({"chunk_type": "message_start"})

                tool_calls: dict[str, _ToolCallInfo] = {}
                final_usage = None
                data_type: str | None = None
                stop_reason: str | None = None

                async for event in response:
                    if hasattr(event, "type"):
                        if event.type == "response.created":
                            # Capture response id for server-side conversation chaining
                            if hasattr(event, "response"):
                                response_id = getattr(event.response, "id", None)
                                if model_state is not None and response_id:
                                    model_state["response_id"] = response_id

                        elif event.type in (
                            "response.reasoning_text.delta",
                            "response.reasoning_summary_text.delta",
                        ):
                            # Reasoning content streaming:
                            # - reasoning_text: full chain-of-thought (gpt-oss models)
                            # - reasoning_summary_text: condensed summary (o-series models)
                            chunks, data_type = self._stream_switch_content("reasoning_content", data_type)
                            for chunk in chunks:
                                yield chunk
                            if hasattr(event, "delta") and isinstance(event.delta, str):
                                yield self._format_chunk(
                                    {
                                        "chunk_type": "content_delta",
                                        "data_type": "reasoning_content",
                                        "data": event.delta,
                                    }
                                )

                        elif event.type == "response.output_text.delta":
                            # Text content streaming
                            chunks, data_type = self._stream_switch_content("text", data_type)
                            for chunk in chunks:
                                yield chunk
                            if hasattr(event, "delta") and isinstance(event.delta, str):
                                yield self._format_chunk(
                                    {"chunk_type": "content_delta", "data_type": "text", "data": event.delta}
                                )

                        elif event.type == "response.output_text.annotation.added":
                            if hasattr(event, "annotation"):
                                if event.annotation.get("type") == "url_citation":
                                    yield self._format_chunk(
                                        {
                                            "chunk_type": "content_delta",
                                            "data_type": "citation",
                                            "data": event.annotation,
                                        }
                                    )
                                else:
                                    logger.warning(
                                        "annotation_type=<%s> | unsupported annotation type",
                                        event.annotation.get("type"),
                                    )

                        elif event.type == "response.output_item.added":
                            # Tool call started
                            if (
                                hasattr(event, "item")
                                and hasattr(event.item, "type")
                                and event.item.type == "function_call"
                            ):
                                call_id = getattr(event.item, "call_id", "unknown")
                                tool_calls[call_id] = {
                                    "name": getattr(event.item, "name", ""),
                                    "arguments": "",
                                    "call_id": call_id,
                                    "item_id": getattr(event.item, "id", ""),
                                }

                        elif event.type == "response.function_call_arguments.delta":
                            # Tool arguments streaming - accumulate deltas by item_id
                            if hasattr(event, "delta") and hasattr(event, "item_id"):
                                for _call_id, call_info in tool_calls.items():
                                    if call_info["item_id"] == event.item_id:
                                        call_info["arguments"] += event.delta
                                        break

                        elif event.type == "response.function_call_arguments.done":
                            # Tool arguments complete - use final arguments as source of truth
                            if hasattr(event, "arguments") and hasattr(event, "item_id"):
                                for _call_id, call_info in tool_calls.items():
                                    if call_info["item_id"] == event.item_id:
                                        call_info["arguments"] = event.arguments
                                        break

                        elif event.type == "response.failed":
                            error = getattr(event.response, "error", None)
                            raise _OpenAIResponsesStreamError(
                                getattr(error, "message", None), getattr(error, "code", None)
                            )

                        elif event.type == "error":
                            raise _OpenAIResponsesStreamError(
                                getattr(event, "message", None), getattr(event, "code", None)
                            )

                        elif event.type == "response.incomplete":
                            # Response stopped early (e.g., max tokens reached)
                            if hasattr(event, "response"):
                                if hasattr(event.response, "usage"):
                                    final_usage = event.response.usage
                                # Check if stopped due to max_output_tokens
                                if (
                                    hasattr(event.response, "incomplete_details")
                                    and event.response.incomplete_details
                                    and getattr(event.response.incomplete_details, "reason", None)
                                    == "max_output_tokens"
                                ):
                                    stop_reason = "length"
                            break

                        elif event.type == "response.completed":
                            # Response complete
                            if hasattr(event, "response") and hasattr(event.response, "usage"):
                                final_usage = event.response.usage
                            break
            except (openai.APIError, _OpenAIResponsesStreamError) as error:
                error_kind = classify_openai_error(error)
                if error_kind == "throttling":
                    logger.warning(_RATE_LIMIT_MSG)
                    raise ModelThrottledException(str(error)) from error
                if error_kind == "context_overflow":
                    logger.warning(_CONTEXT_WINDOW_OVERFLOW_MSG)
                    raise ContextWindowOverflowException(str(error)) from error
                raise

            # Close current content block if we had any
            if data_type:
                yield self._format_chunk({"chunk_type": "content_stop", "data_type": data_type})

            # Emit tool calls with complete arguments.
            # We emit a single delta per tool containing the full arguments rather than streaming
            # incremental argument deltas. The Responses API streams argument chunks via separate
            # events (response.function_call_arguments.delta) which we accumulate above, then use
            # the final arguments from response.function_call_arguments.done. This approach ensures
            # we emit valid, complete JSON arguments rather than partial fragments.
            for call_info in tool_calls.values():
                tool_call = SimpleNamespace(
                    function=SimpleNamespace(name=call_info["name"], arguments=call_info["arguments"]),
                    id=call_info["call_id"],
                )

                yield self._format_chunk({"chunk_type": "content_start", "data_type": "tool", "data": tool_call})
                yield self._format_chunk({"chunk_type": "content_delta", "data_type": "tool", "data": tool_call})
                yield self._format_chunk({"chunk_type": "content_stop", "data_type": "tool"})

            # Determine finish reason: max_tokens (length) > tool_calls > normal stop.
            # A function call that is still in flight when the response is cut off has truncated
            # arguments, so it must surface as max_tokens rather than be executed.
            if stop_reason == "length":
                finish_reason = "length"
            elif tool_calls:
                finish_reason = "tool_calls"
            else:
                finish_reason = "stop"
            yield self._format_chunk({"chunk_type": "message_stop", "data": finish_reason})

            if final_usage:
                yield self._format_chunk({"chunk_type": "metadata", "data": final_usage})

        logger.debug("finished streaming response from OpenAI Responses API model")

    @override
    async def structured_output(
        self, output_model: type[T], prompt: Messages, system_prompt: str | None = None, **kwargs: Any
    ) -> AsyncGenerator[dict[str, T | Any], None]:
        """Get structured output from the OpenAI Responses API model.

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
        async with openai.AsyncOpenAI(**self._resolve_client_args()) as client:
            try:
                request = self._format_request(prompt, system_prompt=system_prompt)
                request.pop("stream", None)
                response = await client.responses.parse(**request, text_format=output_model)
            except openai.APIError as error:
                error_kind = classify_openai_error(error)
                if error_kind == "throttling":
                    logger.warning(_RATE_LIMIT_MSG)
                    raise ModelThrottledException(str(error)) from error
                if error_kind == "context_overflow":
                    logger.warning(_CONTEXT_WINDOW_OVERFLOW_MSG)
                    raise ContextWindowOverflowException(str(error)) from error
                raise

        if response.output_parsed:
            yield {"output": response.output_parsed}
        else:
            raise ValueError("No valid parsed output found in the OpenAI Responses API response.")

    def _format_request(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        tool_choice: ToolChoice | None = None,
        model_state: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Format an OpenAI Responses API compatible response streaming request.

        Args:
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            system_prompt: System prompt to provide context to the model.
            tool_choice: Selection strategy for tool invocation.
            model_state: Runtime state for model providers (e.g., server-side response ids).

        Returns:
            An OpenAI Responses API compatible response streaming request.

        Raises:
            TypeError: If a message contains a content block type that cannot be converted to an OpenAI-compatible
                format.
        """
        input_items = self._format_request_messages(messages)
        request: dict[str, Any] = {
            "model": self.config["model_id"],
            "input": input_items,
            "stream": True,
            **cast(dict[str, Any], self.config.get("params", {})),
            "store": self.stateful,
        }

        response_id = model_state.get("response_id") if model_state else None
        if response_id and self.stateful:
            request["previous_response_id"] = response_id

        if system_prompt:
            request["instructions"] = system_prompt

        # Add tools if provided
        if tool_specs:
            # Merge function tools with any built-in tools (e.g. web_search) carried in from params.
            # Build a new list rather than extending in place: ** unpacking above aliases
            # self.config["params"]["tools"] by reference, so mutating it would duplicate every tool
            # spec into the stored config on each call.
            request["tools"] = [
                *request.get("tools", []),
                *(
                    {
                        "type": "function",
                        "name": tool_spec["name"],
                        "description": tool_spec.get("description", ""),
                        "parameters": tool_spec["inputSchema"]["json"],
                    }
                    for tool_spec in tool_specs
                ),
            ]
            request.update(self._format_request_tool_choice(tool_choice))

        apply_cache_config(request, cast(CacheConfig | None, self.config.get("cache_config")))

        return request

    @classmethod
    def _format_request_tool_choice(cls, tool_choice: ToolChoice | None) -> dict[str, Any]:
        """Format a tool choice for OpenAI Responses API compatibility.

        Args:
            tool_choice: Tool choice configuration.

        Returns:
            OpenAI Responses API compatible tool choice format.
        """
        if not tool_choice:
            return {}

        match tool_choice:
            case {"auto": _}:
                return {"tool_choice": "auto"}
            case {"any": _}:
                return {"tool_choice": "required"}
            case {"tool": {"name": tool_name}}:
                return {"tool_choice": {"type": "function", "name": tool_name}}
            case _:
                # Default to auto for unknown formats
                return {"tool_choice": "auto"}

    @classmethod
    def _format_request_messages(cls, messages: Messages) -> list[dict[str, Any]]:
        """Format an OpenAI compatible messages array.

        Args:
            messages: List of message objects to be processed by the model.

        Returns:
            An OpenAI compatible messages array.
        """
        formatted_messages: list[dict[str, Any]] = []

        for message in messages:
            role = message["role"]
            contents = message["content"]

            if any("reasoningContent" in content for content in contents):
                logger.warning(
                    "reasoningContent is not yet supported in multi-turn conversations with the Responses API"
                )

            if any("cachePoint" in content for content in contents):
                logger.warning("cachePoint content block is not supported by OpenAI Responses | skipping")

            if any(_has_location_source(content) for content in contents):
                logger.warning("Location sources are not supported by OpenAI Responses | skipping content block")

            formatted_contents = [
                cls._format_request_message_content(content, role=role)
                for content in contents
                if not any(
                    block_type in content for block_type in ["toolResult", "toolUse", "reasoningContent", "cachePoint"]
                )
                and not _has_location_source(content)
            ]

            formatted_tool_calls = [
                cls._format_request_message_tool_call(content["toolUse"])
                for content in contents
                if "toolUse" in content
            ]

            formatted_tool_messages = [
                cls._format_request_tool_message(content["toolResult"])
                for content in contents
                if "toolResult" in content
            ]

            if formatted_contents:
                if role == "assistant":
                    # Only the string EasyInputMessage form is a valid assistant *input* shape
                    # without the full output-item metadata (id/status/annotations) that has
                    # already been discarded by this point. Replaying verbatim output items is
                    # tracked in https://github.com/strands-agents/harness-sdk/issues/3389.
                    dropped_types = [
                        part.get("type", "unknown") for part in formatted_contents if part.get("type") != "output_text"
                    ]
                    if dropped_types:
                        logger.warning(
                            "content_type=<%s> | non-text assistant history content has no valid "
                            "Responses API input shape | dropping",
                            ", ".join(dropped_types),
                        )
                    text = "\n".join(part["text"] for part in formatted_contents if part.get("type") == "output_text")
                    if text:
                        formatted_messages.append({"role": "assistant", "content": text})
                else:
                    formatted_messages.append(
                        {
                            "role": role,  # "user"
                            "content": formatted_contents,
                        }
                    )

            formatted_messages.extend(formatted_tool_calls)
            formatted_messages.extend(formatted_tool_messages)

        return [
            message
            for message in formatted_messages
            if message.get("content") or message.get("type") in ["function_call", "function_call_output"]
        ]

    @classmethod
    def _format_request_message_content(cls, content: ContentBlock, *, role: Role = "user") -> dict[str, Any]:
        """Format an OpenAI compatible content block.

        Args:
            content: Message content.
            role: Message role ("user" or "assistant"). Controls text content
                type: "input_text" for user, "output_text" for assistant.

        Returns:
            OpenAI compatible content block.

        Raises:
            TypeError: If the content block type cannot be converted to an OpenAI-compatible format.
            ValueError: If the image or document size exceeds the maximum allowed size (20MB).
        """
        if "document" in content:
            doc = content["document"]
            data_url = _encode_media_to_data_url(doc["source"]["bytes"], doc["format"], "document")
            name = doc.get("name", "document")
            suffix = f".{doc['format']}"
            filename = name if name.endswith(suffix) else f"{name}{suffix}"
            return {"type": "input_file", "filename": filename, "file_data": data_url}

        if "image" in content:
            img = content["image"]
            data_url = _encode_media_to_data_url(img["source"]["bytes"], img["format"], "image")
            return {"type": "input_image", "image_url": data_url}

        if "text" in content:
            text_type = "output_text" if role == "assistant" else "input_text"
            return {"type": text_type, "text": content["text"]}

        if "citationsContent" in content:
            text = "".join(c["text"] for c in content["citationsContent"].get("content", []) if "text" in c)
            text_type = "output_text" if role == "assistant" else "input_text"
            return {"type": text_type, "text": text}

        raise TypeError(f"content_type=<{next(iter(content))}> | unsupported type")

    @classmethod
    def _format_request_message_tool_call(cls, tool_use: ToolUse) -> dict[str, Any]:
        """Format an OpenAI compatible tool call.

        Args:
            tool_use: Tool use requested by the model.

        Returns:
            OpenAI compatible tool call.
        """
        return {
            "type": "function_call",
            "call_id": tool_use["toolUseId"],
            "name": tool_use["name"],
            "arguments": json.dumps(tool_use["input"], ensure_ascii=False),
        }

    @classmethod
    def _format_request_tool_message(cls, tool_result: ToolResult) -> dict[str, Any]:
        """Format an OpenAI compatible tool message.

        Args:
            tool_result: Tool result collected from a tool execution.

        Returns:
            OpenAI compatible tool message.

        Raises:
            ValueError: If the image or document size exceeds the maximum allowed size (20MB).

        Note:
            The Responses API's function_call_output can be either a string (typically JSON encoded)
            or an array of content objects when returning images/files.
            See: https://platform.openai.com/docs/guides/function-calling
        """
        output_parts: list[dict[str, Any]] = []
        has_media = False

        for content in tool_result["content"]:
            if _has_location_source(cast(ContentBlock, content)):
                logger.warning("Location sources are not supported by OpenAI Responses | skipping content block")
                continue
            if "json" in content:
                output_parts.append({"type": "input_text", "text": json.dumps(content["json"], ensure_ascii=False)})
            elif "text" in content:
                output_parts.append({"type": "input_text", "text": content["text"]})
            elif "image" in content:
                has_media = True
                img = content["image"]
                data_url = _encode_media_to_data_url(img["source"]["bytes"], img["format"], "image")
                output_parts.append({"type": "input_image", "image_url": data_url})
            elif "document" in content:
                has_media = True
                doc = content["document"]
                data_url = _encode_media_to_data_url(doc["source"]["bytes"], doc["format"], "document")
                name = doc.get("name", "document")
                suffix = f".{doc['format']}"
                filename = name if name.endswith(suffix) else f"{name}{suffix}"
                output_parts.append({"type": "input_file", "filename": filename, "file_data": data_url})

        # Return array if has media content, otherwise join as string for simpler text-only cases
        output: list[dict[str, Any]] | str
        if has_media:
            output = output_parts
        else:
            output = "\n".join(part.get("text", "") for part in output_parts) if output_parts else ""

        return {
            "type": "function_call_output",
            "call_id": tool_result["toolUseId"],
            "output": output,
        }

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
        chunks: list[StreamEvent] = []
        if data_type != prev_data_type:
            if prev_data_type is not None:
                chunks.append(self._format_chunk({"chunk_type": "content_stop", "data_type": prev_data_type}))
            chunks.append(self._format_chunk({"chunk_type": "content_start", "data_type": data_type}))

        return chunks, data_type

    def _format_chunk(self, event: dict[str, Any]) -> StreamEvent:
        """Format an OpenAI response event into a standardized message chunk.

        Args:
            event: A response event from the OpenAI compatible model.

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

                if event["data_type"] == "citation":
                    web_location: WebLocationDict = {"web": {"url": event["data"].get("url", "")}}
                    return {
                        "contentBlockDelta": {
                            "delta": {
                                "citation": {
                                    "title": event["data"].get("title", ""),
                                    "location": web_location,
                                }
                            }
                        }
                    }

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
                # Responses API uses input_tokens/output_tokens naming convention
                usage_data: Usage = {
                    "inputTokens": getattr(event["data"], "input_tokens", 0),
                    "outputTokens": getattr(event["data"], "output_tokens", 0),
                    "totalTokens": getattr(event["data"], "total_tokens", 0),
                }

                if tokens_details := getattr(event["data"], "input_tokens_details", None):
                    cached = getattr(tokens_details, "cached_tokens", None)
                    if isinstance(cached, int) and cached:
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
                raise RuntimeError(f"chunk_type=<{event['chunk_type']}> | unknown type")

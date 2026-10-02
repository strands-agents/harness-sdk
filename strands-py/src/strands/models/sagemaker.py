"""Amazon SageMaker model provider."""

import json
import logging
import os
from collections.abc import AsyncGenerator, Iterable, Iterator
from dataclasses import dataclass
from typing import Any, Literal, TypedDict, TypeVar

import boto3
from botocore.config import Config as BotocoreConfig
from mypy_boto3_sagemaker_runtime import SageMakerRuntimeClient
from pydantic import BaseModel
from typing_extensions import Unpack, override

from ..types.content import ContentBlock, Messages
from ..types.streaming import StreamEvent
from ..types.tools import ToolChoice, ToolResult, ToolSpec
from ._validation import validate_config_keys, warn_on_cache_config_not_supported, warn_on_tool_choice_not_supported
from .model import BaseModelConfig, CacheConfig
from .openai import OpenAIModel

T = TypeVar("T", bound=BaseModel)

logger = logging.getLogger(__name__)


@dataclass
class UsageMetadata:
    """Usage metadata for the model.

    Attributes:
        total_tokens: Total number of tokens used in the request
        completion_tokens: Number of tokens used in the completion
        prompt_tokens: Number of tokens used in the prompt
        prompt_tokens_details: Additional information about the prompt tokens (optional)
    """

    total_tokens: int
    completion_tokens: int
    prompt_tokens: int
    prompt_tokens_details: int | None = 0


@dataclass
class FunctionCall:
    """Function call for the model.

    Attributes:
        name: Name of the function to call
        arguments: Arguments to pass to the function
    """

    name: str | dict[Any, Any]
    arguments: str | dict[Any, Any]

    def __init__(self, **kwargs: dict[str, str]):
        """Initialize function call.

        Args:
            **kwargs: Keyword arguments for the function call.
        """
        self.name = kwargs.get("name", "")
        self.arguments = kwargs.get("arguments", "")


@dataclass
class ToolCall:
    """Tool call for the model object.

    Attributes:
        id: Tool call ID
        type: Tool call type
        function: Tool call function
    """

    id: str
    type: Literal["function"]
    function: FunctionCall

    def __init__(self, **kwargs: dict):
        """Initialize tool call object.

        Args:
            **kwargs: Keyword arguments for the tool call.
        """
        self.id = str(kwargs.get("id", ""))
        self.type = "function"
        self.function = FunctionCall(**kwargs.get("function", {"name": "", "arguments": ""}))


def _strip_sse_framing(line: str) -> str | None:
    """Return the JSON payload of one SSE line, or None if the line carries no event.

    Strips an optional ``data:`` field prefix and skips blank lines, comment lines
    (``:`` prefix), non-data SSE fields (``event:``, ``id:``, ``retry:``), and the
    ``[DONE]`` sentinel.

    Args:
        line: A single line from the event stream, without its terminating newline.

    Returns:
        The payload to decode as JSON, or None if the line is not a data event.
    """
    line = line.strip()
    if line.startswith("data:"):
        line = line[len("data:") :].strip()
    elif line.startswith(("event:", "id:", "retry:")):
        return None
    if not line or line.startswith(":") or line == "[DONE]":
        return None
    return line


def _parse_event_stream(body: Iterable[Any]) -> Iterator[dict[str, Any]]:
    """Yield decoded JSON events from a SageMaker response stream.

    A ``PayloadPart`` is an arbitrary byte chunk that is not aligned to event
    boundaries: a container such as vLLM or TGI may flush several ``data:`` SSE
    events in one part, or split a single event across parts. Bytes are buffered;
    each complete newline-delimited line is decoded as an independent event and any
    trailing partial line is retained until the next part completes it. A malformed
    ``data:``-framed line is dropped with a warning, while a bare line that does not
    decode on its own defers to the whole-buffer decode, so a payload that is not
    newline-framed (multi-line bare JSON) is decoded once the buffer parses whole.

    Args:
        body: The ``response["Body"]`` event stream of ``PayloadPart`` chunks.

    Yields:
        One decoded JSON object per event.
    """
    buffer = ""
    for part in body:
        buffer += part["PayloadPart"]["Bytes"].decode("utf-8")
        logger.debug("buffer=<%s> | accumulated payload part", buffer)
        while "\n" in buffer:
            line, rest = buffer.split("\n", 1)
            payload = _strip_sse_framing(line)
            if payload is None:
                buffer = rest
                continue
            try:
                event = json.loads(payload)
            except json.JSONDecodeError:
                if not line.lstrip().startswith("data:"):
                    # Not SSE-framed: likely one line of a bare JSON document that only
                    # decodes as a whole. Stop line-splitting and let the whole-buffer
                    # decode below retry once more bytes arrive.
                    break
                logger.warning("line=<%s> | skipping malformed event", line)
                buffer = rest
                continue
            buffer = rest
            yield event
        payload = _strip_sse_framing(buffer)
        if payload is None:
            continue
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            continue
        buffer = ""
        yield parsed
    if _strip_sse_framing(buffer) is not None:
        logger.warning("buffer=<%s> | stream ended with an undecoded partial event", buffer)


class SageMakerAIModel(OpenAIModel):
    """Amazon SageMaker model provider implementation."""

    client: SageMakerRuntimeClient  # type: ignore[assignment]

    class SageMakerAIPayloadSchema(TypedDict, total=False):
        """Payload schema for the Amazon SageMaker AI model.

        Attributes:
            max_tokens: Maximum number of tokens to generate in the completion
            stream: Whether to stream the response
            temperature: Sampling temperature to use for the model (optional)
            top_p: Nucleus sampling parameter (optional)
            top_k: Top-k sampling parameter (optional)
            stop: List of stop sequences to use for the model (optional)
            tool_results_as_user_messages: Convert tool result to user messages (optional)
            additional_args: Additional request parameters, as supported by https://bit.ly/djl-lmi-request-schema
        """

        max_tokens: int
        stream: bool
        temperature: float | None
        top_p: float | None
        top_k: int | None
        stop: list[str] | None
        tool_results_as_user_messages: bool | None
        additional_args: dict[str, Any] | None

    class SageMakerAIEndpointConfig(BaseModelConfig, total=False):
        """Configuration options for SageMaker models.

        Attributes:
            endpoint_name: The name of the SageMaker endpoint to invoke
            inference_component_name: The name of the inference component to use
            cache_config: Prompt caching settings. SageMaker honors no cache fields, so any set field is ignored.

            additional_args: Other request parameters, as supported by https://bit.ly/sagemaker-invoke-endpoint-params
        """

        endpoint_name: str
        region_name: str
        inference_component_name: str | None
        target_model: str | None | None
        target_variant: str | None | None
        cache_config: CacheConfig | None
        additional_args: dict[str, Any] | None

    def __init__(
        self,
        endpoint_config: SageMakerAIEndpointConfig,
        payload_config: SageMakerAIPayloadSchema,
        boto_session: boto3.Session | None = None,
        boto_client_config: BotocoreConfig | None = None,
    ):
        """Initialize provider instance.

        Args:
            endpoint_config: Endpoint configuration for SageMaker.
            payload_config: Payload configuration for the model.
            boto_session: Boto Session to use when calling the SageMaker Runtime.
            boto_client_config: Configuration to use when creating the SageMaker-Runtime Boto Client.
        """
        validate_config_keys(endpoint_config, self.SageMakerAIEndpointConfig)
        validate_config_keys(payload_config, self.SageMakerAIPayloadSchema)
        payload_config.setdefault("stream", True)
        payload_config.setdefault("tool_results_as_user_messages", False)
        self.endpoint_config = self.SageMakerAIEndpointConfig(**endpoint_config)
        self.payload_config = self.SageMakerAIPayloadSchema(**payload_config)
        logger.debug(
            "endpoint_config=<%s> payload_config=<%s> | initializing", self.endpoint_config, self.payload_config
        )

        region = self.endpoint_config.get("region_name") or os.getenv("AWS_REGION") or "us-west-2"
        session = boto_session or boto3.Session(region_name=str(region))

        # Add strands-agents to the request user agent
        if boto_client_config:
            existing_user_agent = getattr(boto_client_config, "user_agent_extra", None)

            # Append 'strands-agents' to existing user_agent_extra or set it if not present
            new_user_agent = f"{existing_user_agent} strands-agents" if existing_user_agent else "strands-agents"

            client_config = boto_client_config.merge(BotocoreConfig(user_agent_extra=new_user_agent))
        else:
            client_config = BotocoreConfig(user_agent_extra="strands-agents")

        self.client = session.client(
            service_name="sagemaker-runtime",
            config=client_config,
        )

    @override
    def update_config(self, **endpoint_config: Unpack[SageMakerAIEndpointConfig]) -> None:  # type: ignore[override]
        """Update the Amazon SageMaker model configuration with the provided arguments.

        Args:
            **endpoint_config: Configuration overrides.
        """
        validate_config_keys(endpoint_config, self.SageMakerAIEndpointConfig)
        self.endpoint_config.update(endpoint_config)

    @override
    def get_config(self) -> "SageMakerAIModel.SageMakerAIEndpointConfig":  # type: ignore[override]
        """Get the Amazon SageMaker model configuration.

        Returns:
            The Amazon SageMaker model configuration.
        """
        return self.endpoint_config

    @override
    def format_request(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        tool_choice: ToolChoice | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Format an Amazon SageMaker chat streaming request.

        Args:
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            system_prompt: System prompt to provide context to the model.
            tool_choice: Selection strategy for tool invocation. **Note: This parameter is accepted for
                interface consistency but is currently ignored for this model provider.**
            **kwargs: Additional keyword arguments for future extensibility.

        Returns:
            An Amazon SageMaker chat streaming request.
        """
        formatted_messages = self.format_request_messages(messages, system_prompt)

        payload = {
            "messages": formatted_messages,
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
            # Add payload configuration parameters
            **{
                k: v
                for k, v in self.payload_config.items()
                if k not in ["additional_args", "tool_results_as_user_messages"]
            },
        }

        payload_additional_args = self.payload_config.get("additional_args")
        if payload_additional_args:
            payload.update(payload_additional_args)

        # Remove tools and tool_choice if tools = []
        if not payload["tools"]:
            payload.pop("tools")
            payload.pop("tool_choice", None)
        else:
            # Ensure the model can use tools when available
            payload["tool_choice"] = "auto"

        for message in payload["messages"]:  # type: ignore
            # Assistant message must have either content or tool_calls, but not both
            if message.get("role", "") == "assistant" and message.get("tool_calls", []) != []:
                message.pop("content", None)
            if message.get("role") == "tool" and self.payload_config.get("tool_results_as_user_messages", False):
                # Convert tool message to user message
                tool_call_id = message.get("tool_call_id", "ABCDEF")
                content = message.get("content", "")
                message.clear()
                message.update(role="user", content=f"Tool call ID '{tool_call_id}' returned: {content}")
            # Cannot have both reasoning_text and text - if "text", content becomes an array of content["text"]
            for c in message.get("content", []):
                if "text" in c:
                    message["content"] = [c]
                    break
            # Cast message content to string for TGI compatibility
            # message["content"] = str(message.get("content", ""))

        logger.info("payload=<%s>", json.dumps(payload, indent=2))
        # Format the request according to the SageMaker Runtime API requirements
        request = {
            "EndpointName": self.endpoint_config["endpoint_name"],
            "Body": json.dumps(payload),
            "ContentType": "application/json",
            "Accept": "application/json",
        }

        # Add optional SageMaker parameters if provided
        inf_component_name = self.endpoint_config.get("inference_component_name")
        if inf_component_name:
            request["InferenceComponentName"] = inf_component_name
        target_model = self.endpoint_config.get("target_model")
        if target_model:
            request["TargetModel"] = target_model
        target_variant = self.endpoint_config.get("target_variant")
        if target_variant:
            request["TargetVariant"] = target_variant

        # Add additional request args if provided
        additional_args = self.endpoint_config.get("additional_args")
        if additional_args:
            request.update(additional_args)

        # SageMaker applies no CacheConfig fields; warn that any set field is ignored.
        warn_on_cache_config_not_supported(
            self.endpoint_config.get("cache_config"), "SageMaker", supported=set(), stacklevel=3
        )
        return request

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
        """Stream conversation with the SageMaker model.

        Args:
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            system_prompt: System prompt to provide context to the model.
            tool_choice: Selection strategy for tool invocation. **Note: This parameter is accepted for
                interface consistency but is currently ignored for this model provider.**
            **kwargs: Additional keyword arguments for future extensibility.

        Yields:
            Formatted message chunks from the model.
        """
        warn_on_tool_choice_not_supported(tool_choice)

        logger.debug("formatting request")
        request = self.format_request(messages, tool_specs, system_prompt)
        logger.debug("formatted request=<%s>", request)

        logger.debug("invoking model")

        try:
            if self.payload_config.get("stream", True):
                response = self.client.invoke_endpoint_with_response_stream(**request)

                # Message start
                yield self.format_chunk({"chunk_type": "message_start"})

                # Parse the content
                finish_reason = ""
                tool_calls: dict[int, list[Any]] = {}
                has_text_content = False
                text_content_started = False
                reasoning_content_started = False

                for content in _parse_event_stream(response["Body"]):
                    choices = content.get("choices")
                    if not choices:
                        if usage := content.get("usage"):
                            yield self.format_chunk({"chunk_type": "metadata", "data": UsageMetadata(**usage)})
                        continue
                    if finish_reason:
                        continue

                    choice = choices[0]
                    logger.debug("choice=<%s>", json.dumps(choice, indent=2))

                    # Handle text content
                    if choice["delta"].get("content"):
                        if not text_content_started:
                            yield self.format_chunk({"chunk_type": "content_start", "data_type": "text"})
                            text_content_started = True
                        has_text_content = True
                        yield self.format_chunk(
                            {
                                "chunk_type": "content_delta",
                                "data_type": "text",
                                "data": choice["delta"]["content"],
                            }
                        )

                    # Handle reasoning content
                    # vLLM v0.16.0+ uses "reasoning" instead of "reasoning_content"
                    reasoning_text = choice["delta"].get("reasoning_content") or choice["delta"].get("reasoning")
                    if reasoning_text:
                        if not reasoning_content_started:
                            yield self.format_chunk({"chunk_type": "content_start", "data_type": "reasoning_content"})
                            reasoning_content_started = True
                        yield self.format_chunk(
                            {
                                "chunk_type": "content_delta",
                                "data_type": "reasoning_content",
                                "data": reasoning_text,
                            }
                        )

                    # Handle tool calls
                    generated_tool_calls = choice["delta"].get("tool_calls", [])
                    if not isinstance(generated_tool_calls, list):
                        generated_tool_calls = [generated_tool_calls]
                    for tool_call in generated_tool_calls:
                        tool_calls.setdefault(tool_call["index"], []).append(tool_call)

                    usage = content.get("usage") or choice.get("usage")
                    if usage:
                        yield self.format_chunk({"chunk_type": "metadata", "data": UsageMetadata(**usage)})

                    if choice["finish_reason"] is not None:
                        finish_reason = choice["finish_reason"]

                # Close reasoning content if it was started
                if reasoning_content_started:
                    yield self.format_chunk({"chunk_type": "content_stop", "data_type": "reasoning_content"})

                # Close text content if it was started
                if text_content_started:
                    yield self.format_chunk({"chunk_type": "content_stop", "data_type": "text"})

                # Handle tool calling
                logger.info("tool_calls=<%s>", json.dumps(tool_calls, indent=2))
                for tool_deltas in tool_calls.values():
                    if not tool_deltas[0]["function"].get("name"):
                        raise Exception("The model did not provide a tool name.")
                    yield self.format_chunk(
                        {"chunk_type": "content_start", "data_type": "tool", "data": ToolCall(**tool_deltas[0])}
                    )
                    for tool_delta in tool_deltas:
                        yield self.format_chunk(
                            {"chunk_type": "content_delta", "data_type": "tool", "data": ToolCall(**tool_delta)}
                        )
                    yield self.format_chunk({"chunk_type": "content_stop", "data_type": "tool"})

                # If no content was generated at all, ensure we have empty text content
                if not has_text_content and not tool_calls:
                    yield self.format_chunk({"chunk_type": "content_start", "data_type": "text"})
                    yield self.format_chunk({"chunk_type": "content_stop", "data_type": "text"})

                # Message close
                yield self.format_chunk({"chunk_type": "message_stop", "data": finish_reason})

            else:
                # Not all SageMaker AI models support streaming!
                response = self.client.invoke_endpoint(**request)  # type: ignore[assignment]
                final_response_json = json.loads(response["Body"].read().decode("utf-8"))  # type: ignore[attr-defined]
                logger.info("response=<%s>", json.dumps(final_response_json, indent=2))

                # Obtain the key elements from the response
                message = final_response_json["choices"][0]["message"]
                message_stop_reason = final_response_json["choices"][0]["finish_reason"]

                # Message start
                yield self.format_chunk({"chunk_type": "message_start"})

                # Handle text
                if message.get("content", ""):
                    yield self.format_chunk({"chunk_type": "content_start", "data_type": "text"})
                    yield self.format_chunk(
                        {"chunk_type": "content_delta", "data_type": "text", "data": message["content"]}
                    )
                    yield self.format_chunk({"chunk_type": "content_stop", "data_type": "text"})

                # Handle reasoning content
                # vLLM v0.16.0+ uses "reasoning" instead of "reasoning_content"
                reasoning_text = message.get("reasoning_content") or message.get("reasoning")
                if reasoning_text:
                    yield self.format_chunk({"chunk_type": "content_start", "data_type": "reasoning_content"})
                    yield self.format_chunk(
                        {
                            "chunk_type": "content_delta",
                            "data_type": "reasoning_content",
                            "data": reasoning_text,
                        }
                    )
                    yield self.format_chunk({"chunk_type": "content_stop", "data_type": "reasoning_content"})

                # Handle the tool calling, if any
                if message.get("tool_calls") or message_stop_reason == "tool_calls":
                    if not isinstance(message["tool_calls"], list):
                        message["tool_calls"] = [message["tool_calls"]]
                    for tool_call in message["tool_calls"]:
                        # if arguments of tool_call is not str, cast it
                        if not isinstance(tool_call["function"]["arguments"], str):
                            tool_call["function"]["arguments"] = json.dumps(tool_call["function"]["arguments"])
                        yield self.format_chunk(
                            {"chunk_type": "content_start", "data_type": "tool", "data": ToolCall(**tool_call)}
                        )
                        yield self.format_chunk(
                            {"chunk_type": "content_delta", "data_type": "tool", "data": ToolCall(**tool_call)}
                        )
                        yield self.format_chunk({"chunk_type": "content_stop", "data_type": "tool"})
                    message_stop_reason = "tool_calls"

                # Message close
                yield self.format_chunk({"chunk_type": "message_stop", "data": message_stop_reason})
                # Handle usage metadata
                if final_response_json.get("usage"):
                    yield self.format_chunk(
                        {"chunk_type": "metadata", "data": UsageMetadata(**final_response_json.get("usage"))}
                    )
        except (
            self.client.exceptions.InternalFailure,
            self.client.exceptions.ServiceUnavailable,
            self.client.exceptions.ValidationError,
            self.client.exceptions.ModelError,
            self.client.exceptions.InternalDependencyException,
            self.client.exceptions.ModelNotReadyException,
        ) as e:
            logger.error("SageMaker error: %s", str(e))
            raise e

        logger.debug("finished streaming response from model")

    @override
    @classmethod
    def format_request_tool_message(cls, tool_result: ToolResult, **kwargs: Any) -> dict[str, Any]:
        """Format a SageMaker compatible tool message.

        Args:
            tool_result: Tool result collected from a tool execution.
            **kwargs: Additional keyword arguments for future extensibility.

        Returns:
            SageMaker compatible tool message with content as a string.
        """
        # Convert content blocks to a simple string for SageMaker compatibility
        content_parts = []
        for content in tool_result["content"]:
            if "json" in content:
                content_parts.append(json.dumps(content["json"], ensure_ascii=False))
            elif "text" in content:
                content_parts.append(content["text"])
            else:
                # Handle other content types by converting to string
                content_parts.append(str(content))

        content_string = " ".join(content_parts)

        return {
            "role": "tool",
            "tool_call_id": tool_result["toolUseId"],
            "content": content_string,  # String instead of list
        }

    @override
    @classmethod
    def format_request_message_content(cls, content: ContentBlock, **kwargs: Any) -> dict[str, Any]:
        """Format a content block.

        Args:
            content: Message content.
            **kwargs: Additional keyword arguments for future extensibility.

        Returns:
            Formatted content block.

        Raises:
            TypeError: If the content block type cannot be converted to a SageMaker-compatible format.
        """
        # if "text" in content and not isinstance(content["text"], str):
        #     return {"type": "text", "text": str(content["text"])}

        if "reasoningContent" in content and content["reasoningContent"]:
            return {
                "signature": content["reasoningContent"].get("reasoningText", {}).get("signature", ""),
                "thinking": content["reasoningContent"].get("reasoningText", {}).get("text", ""),
                "type": "thinking",
            }
        elif not content.get("reasoningContent"):
            content.pop("reasoningContent", None)

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
        # Format the request for structured output
        request = self.format_request(prompt, system_prompt=system_prompt)

        # Parse the payload to add response format
        payload = json.loads(request["Body"])
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": output_model.__name__, "schema": output_model.model_json_schema(), "strict": True},
        }
        request["Body"] = json.dumps(payload)

        try:
            # Use non-streaming mode for structured output
            response = self.client.invoke_endpoint(**request)
            final_response_json = json.loads(response["Body"].read().decode("utf-8"))

            # Extract the structured content
            message = final_response_json["choices"][0]["message"]

            if message.get("content"):
                try:
                    # Parse the JSON content and create the output model instance
                    content_data = json.loads(message["content"])
                    parsed_output = output_model(**content_data)
                    yield {"output": parsed_output}
                except (json.JSONDecodeError, TypeError, ValueError) as e:
                    raise ValueError(f"Failed to parse structured output: {e}") from e
            else:
                raise ValueError("No content found in SageMaker response")

        except (
            self.client.exceptions.InternalFailure,
            self.client.exceptions.ServiceUnavailable,
            self.client.exceptions.ValidationError,
            self.client.exceptions.ModelError,
            self.client.exceptions.InternalDependencyException,
            self.client.exceptions.ModelNotReadyException,
        ) as e:
            logger.error("SageMaker structured output error: %s", str(e))
            raise ValueError(f"SageMaker structured output error: {str(e)}") from e

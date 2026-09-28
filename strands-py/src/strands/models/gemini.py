"""Google Gemini model provider.

- Docs: https://ai.google.dev/api
"""

import base64
import json
import logging
import mimetypes
import secrets
from collections.abc import AsyncGenerator
from typing import Any, TypeVar, cast

import pydantic
from google import genai
from typing_extensions import Required, Unpack, override

from ..types.content import ContentBlock, ContentBlockStartToolUse, Messages, SystemContentBlock
from ..types.event_loop import Usage
from ..types.exceptions import ContextWindowOverflowException, ModelThrottledException, ProviderTokenCountError
from ..types.streaming import StreamEvent
from ..types.tools import ToolChoice, ToolChoiceToolDict, ToolSpec
from ._defaults import resolve_config_metadata
from ._validation import _has_location_source, validate_config_keys
from .model import BaseModelConfig, Model

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=pydantic.BaseModel)


class GeminiModel(Model):
    """Google Gemini model provider implementation.

    - Docs: https://ai.google.dev/api
    """

    class GeminiConfig(BaseModelConfig, total=False):
        """Configuration options for Gemini models.

        Attributes:
            model_id: Gemini model ID (e.g., "gemini-2.5-flash").
                For a complete list of supported models, see
                https://ai.google.dev/gemini-api/docs/models
            params: Additional model parameters (e.g., temperature).
                For a complete list of supported parameters, see
                https://ai.google.dev/api/generate-content#generationconfig.
            gemini_tools: Gemini-specific tools that are not FunctionDeclarations
                (e.g., GoogleSearch, CodeExecution, ComputerUse, UrlContext, FileSearch).
                Use the standard tools interface for function calling tools.
                For a complete list of supported tools, see
                https://ai.google.dev/api/caching#Tool
            use_native_token_count: Whether to use the native Gemini count_tokens API.
                When True, count_tokens() calls the Gemini API for accurate counts.
                When False (default), skips the API call and uses the local estimator.
        """

        model_id: Required[str]
        params: dict[str, Any]
        gemini_tools: list[genai.types.Tool]
        use_native_token_count: bool

    def __init__(
        self,
        *,
        client: genai.Client | None = None,
        client_args: dict[str, Any] | None = None,
        **model_config: Unpack[GeminiConfig],
    ) -> None:
        """Initialize provider instance.

        Args:
            client: Pre-configured Gemini client to reuse across requests.
                When provided, this client will be reused for all requests and will NOT be closed
                by the model. The caller is responsible for managing the client lifecycle.
                This is useful for:
                - Injecting custom client wrappers
                - Reusing connection pools within a single event loop/worker
                - Centralizing observability, retries, and networking policy
                Note: The client should not be shared across different asyncio event loops.
            client_args: Arguments for the underlying Gemini client (e.g., api_key).
                For a complete list of supported arguments, see https://googleapis.github.io/python-genai/.
            **model_config: Configuration options for the Gemini model.

        Raises:
            ValueError: If both `client` and `client_args` are provided.
        """
        validate_config_keys(model_config, GeminiModel.GeminiConfig)
        self.config = GeminiModel.GeminiConfig(**model_config)

        # Validate that only one client configuration method is provided
        if client is not None and client_args is not None and len(client_args) > 0:
            raise ValueError("Only one of 'client' or 'client_args' should be provided, not both.")

        self._custom_client = client
        self.client_args = client_args or {}

        # Validate gemini_tools if provided
        if "gemini_tools" in self.config:
            self._validate_gemini_tools(self.config["gemini_tools"])

        logger.debug("config=<%s> | initializing", self.config)

    @override
    def update_config(self, **model_config: Unpack[GeminiConfig]) -> None:  # type: ignore[override]
        """Update the Gemini model configuration with the provided arguments.

        Args:
            **model_config: Configuration overrides.
        """
        # Validate gemini_tools if provided
        if "gemini_tools" in model_config:
            self._validate_gemini_tools(model_config["gemini_tools"])

        self.config.update(model_config)

    @override
    def get_config(self) -> GeminiConfig:
        """Get the Gemini model configuration.

        Returns:
            The Gemini model configuration.
        """
        return resolve_config_metadata(self.config, self.config["model_id"])

    def _get_client(self) -> genai.Client:
        """Get a Gemini client for making requests.

        This method handles client lifecycle management:
        - If an injected client was provided during initialization, it returns that client
          without managing its lifecycle (caller is responsible for cleanup).
        - Otherwise, creates a new genai.Client from client_args.

        Returns:
            genai.Client: A Gemini client instance.
        """
        if self._custom_client is not None:
            # Use the injected client (caller manages lifecycle)
            return self._custom_client
        else:
            # Create a new client from client_args
            return genai.Client(**self.client_args)

    def _format_request_content_part(
        self, content: ContentBlock, tool_use_id_to_name: dict[str, str]
    ) -> genai.types.Part:
        """Format content block into a Gemini part instance.

        - Docs: https://googleapis.github.io/python-genai/genai.html#genai.types.Part

        Args:
            content: Message content to format.
            tool_use_id_to_name: Mapping of tool use id to tool name.
                Store the mapping from toolUseId to name for later use in toolResult formatting. This mapping is built
                as we format the request, ensuring that when we encounter toolResult blocks (which come after toolUse
                blocks in the message history), we can look up the function name.

        Returns:
            Gemini part.
        """
        if "document" in content:
            return genai.types.Part(
                inline_data=genai.types.Blob(
                    data=content["document"]["source"]["bytes"],
                    mime_type=mimetypes.types_map.get(f".{content['document']['format']}", "application/octet-stream"),
                ),
            )

        if "image" in content:
            return genai.types.Part(
                inline_data=genai.types.Blob(
                    data=content["image"]["source"]["bytes"],
                    mime_type=mimetypes.types_map.get(f".{content['image']['format']}", "application/octet-stream"),
                ),
            )

        if "reasoningContent" in content:
            thought_signature = content["reasoningContent"]["reasoningText"].get("signature")

            return genai.types.Part(
                text=content["reasoningContent"]["reasoningText"]["text"],
                thought=True,
                thought_signature=base64.b64decode(thought_signature) if thought_signature else None,
            )

        if "text" in content:
            return genai.types.Part(text=content["text"])

        if "toolResult" in content:
            tool_use_id = content["toolResult"]["toolUseId"]
            function_name = tool_use_id_to_name.get(tool_use_id, tool_use_id)

            return genai.types.Part(
                function_response=genai.types.FunctionResponse(
                    id=tool_use_id,
                    name=function_name,
                    response={
                        "output": [
                            tool_result_content
                            if "json" in tool_result_content
                            else self._format_request_content_part(
                                cast(ContentBlock, tool_result_content),
                                tool_use_id_to_name,
                            ).to_json_dict()
                            for tool_result_content in content["toolResult"]["content"]
                        ],
                    },
                ),
            )

        if "toolUse" in content:
            tool_use_id = content["toolUse"]["toolUseId"]
            tool_use_id_to_name[tool_use_id] = content["toolUse"]["name"]

            reasoning_signature = content["toolUse"].get("reasoningSignature")

            return genai.types.Part(
                function_call=genai.types.FunctionCall(
                    args=content["toolUse"]["input"],
                    id=tool_use_id,
                    name=content["toolUse"]["name"],
                ),
                thought_signature=base64.b64decode(reasoning_signature) if reasoning_signature else None,
            )

        raise TypeError(f"content_type=<{next(iter(content))}> | unsupported type")

    def _format_request_content(self, messages: Messages) -> list[genai.types.Content]:
        """Format message content into Gemini content instances.

        - Docs: https://googleapis.github.io/python-genai/genai.html#genai.types.Content

        Args:
            messages: List of message objects to be processed by the model.

        Returns:
            Gemini content list.
        """
        # Gemini FunctionResponses are constructed from tool result blocks. Function name is required but is not
        # available in tool result blocks, hence the mapping.
        tool_use_id_to_name: dict[str, str] = {}

        contents = []
        for message in messages:
            parts = []
            for content in message["content"]:
                # Check for location sources and skip with warning
                if _has_location_source(content):
                    logger.warning("Location sources are not supported by Gemini | skipping content block")
                    continue
                if "cachePoint" in content:
                    logger.warning("cachePoint content block is not supported by Gemini | skipping")
                    continue
                parts.append(self._format_request_content_part(content, tool_use_id_to_name))

            contents.append(
                genai.types.Content(
                    parts=parts,
                    role="user" if message["role"] == "user" else "model",
                )
            )

        return contents

    def _format_request_tools(self, tool_specs: list[ToolSpec] | None) -> list[genai.types.Tool | Any] | None:
        """Format tool specs into Gemini tools.

        - Docs: https://googleapis.github.io/python-genai/genai.html#genai.types.Tool

        Args:
            tool_specs: List of tool specifications to make available to the model.

        Return:
            Gemini tool list, or None when no tools are configured (Vertex AI rejects empty arrays).
        """
        if not tool_specs and not self.config.get("gemini_tools"):
            return None
        tools = [
            genai.types.Tool(
                function_declarations=[
                    genai.types.FunctionDeclaration(
                        description=tool_spec["description"],
                        name=tool_spec["name"],
                        parameters_json_schema=tool_spec["inputSchema"]["json"],
                    )
                    for tool_spec in tool_specs or []
                ],
            ),
        ]
        if self.config.get("gemini_tools"):
            tools.extend(self.config["gemini_tools"])
        return tools

    @staticmethod
    def _format_tool_choice(tool_choice: ToolChoice | None) -> genai.types.ToolConfig | None:
        """Format a tool choice into a Gemini tool config.

        - Docs: https://googleapis.github.io/python-genai/genai.html#genai.types.ToolConfig

        Args:
            tool_choice: Selection strategy for tool invocation.

        Returns:
            Gemini tool config, or None when no recognized strategy is requested.
        """
        if tool_choice is None:
            return None

        allowed_function_names: list[str] | None = None
        if "auto" in tool_choice:
            mode = genai.types.FunctionCallingConfigMode.AUTO
        elif "any" in tool_choice:
            mode = genai.types.FunctionCallingConfigMode.ANY
        elif "tool" in tool_choice:
            # Gemini has no single-tool mode, so a specific tool is ANY narrowed to that one function.
            mode = genai.types.FunctionCallingConfigMode.ANY
            allowed_function_names = [cast(ToolChoiceToolDict, tool_choice)["tool"]["name"]]
        else:
            return None

        return genai.types.ToolConfig(
            function_calling_config=genai.types.FunctionCallingConfig(
                mode=mode,
                allowed_function_names=allowed_function_names,
            ),
        )

    def _format_request_config(
        self,
        tool_specs: list[ToolSpec] | None,
        system_prompt: str | None,
        params: dict[str, Any] | None,
        tool_choice: ToolChoice | None = None,
    ) -> genai.types.GenerateContentConfig:
        """Format Gemini request config.

        - Docs: https://googleapis.github.io/python-genai/genai.html#genai.types.GenerateContentConfig

        Args:
            tool_specs: List of tool specifications to make available to the model.
            system_prompt: System prompt to provide context to the model.
            params: Additional model parameters (e.g., temperature).
            tool_choice: Selection strategy for tool invocation.

        Returns:
            Gemini request config.
        """
        config_params = dict(params or {})

        tool_config = self._format_tool_choice(tool_choice) if tool_specs else None
        if tool_config is not None:
            # A tool config set in params wins, matching the other providers and the TypeScript SDK. A tool
            # config expresses more than a ToolChoice can, so the explicit one is left whole rather than
            # merged with, or replaced by, the narrower per-request choice.
            config_params.setdefault("tool_config", tool_config)

        return genai.types.GenerateContentConfig(
            system_instruction=system_prompt,
            tools=self._format_request_tools(tool_specs),
            **config_params,
        )

    def _format_request(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None,
        system_prompt: str | None,
        params: dict[str, Any] | None,
        tool_choice: ToolChoice | None = None,
    ) -> dict[str, Any]:
        """Format a Gemini streaming request.

        - Docs: https://ai.google.dev/api/generate-content#endpoint_1

        Args:
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            system_prompt: System prompt to provide context to the model.
            params: Additional model parameters (e.g., temperature).
            tool_choice: Selection strategy for tool invocation.

        Returns:
            A Gemini streaming request.
        """
        return {
            "config": self._format_request_config(tool_specs, system_prompt, params, tool_choice).to_json_dict(),
            "contents": [content.to_json_dict() for content in self._format_request_content(messages)],
            "model": self.config["model_id"],
        }

    def _format_chunk(self, event: dict[str, Any]) -> StreamEvent:
        """Format the Gemini response events into standardized message chunks.

        Args:
            event: A response event from the Gemini model.

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
                match event["data_type"]:
                    case "tool":
                        function_call = event["data"].function_call
                        # Use Gemini's provided ID or generate one if missing
                        tool_use_id = function_call.id or f"tooluse_{secrets.token_urlsafe(16)}"

                        tool_use_start: ContentBlockStartToolUse = {
                            "name": function_call.name,
                            "toolUseId": tool_use_id,
                        }
                        if event["data"].thought_signature:
                            tool_use_start["reasoningSignature"] = base64.b64encode(
                                event["data"].thought_signature
                            ).decode("ascii")
                        return {
                            "contentBlockStart": {
                                "start": {
                                    "toolUse": tool_use_start,
                                },
                            },
                        }

                    case _:
                        return {"contentBlockStart": {"start": {}}}

            case "content_delta":
                match event["data_type"]:
                    case "tool":
                        return {
                            "contentBlockDelta": {
                                "delta": {"toolUse": {"input": json.dumps(event["data"].function_call.args)}}
                            }
                        }

                    case "reasoning_content":
                        return {
                            "contentBlockDelta": {
                                "delta": {
                                    "reasoningContent": {
                                        "text": event["data"].text,
                                    },
                                },
                            },
                        }

                    case "reasoning_signature":
                        return {
                            "contentBlockDelta": {
                                "delta": {
                                    "reasoningContent": {
                                        "signature": base64.b64encode(event["data"].thought_signature).decode("ascii"),
                                    },
                                },
                            },
                        }

                    case _:
                        return {"contentBlockDelta": {"delta": {"text": event["data"].text}}}

            case "content_stop":
                return {"contentBlockStop": {}}

            case "message_stop":
                match event["data"]:
                    case "TOOL_USE":
                        return {"messageStop": {"stopReason": "tool_use"}}
                    case "MAX_TOKENS":
                        return {"messageStop": {"stopReason": "max_tokens"}}
                    case "SAFETY":
                        return {"messageStop": {"stopReason": "guardrail_intervened"}}
                    case _:
                        return {"messageStop": {"stopReason": "end_turn"}}

            case "metadata":
                usage_metadata = event["data"]
                prompt_tokens = usage_metadata.prompt_token_count or 0
                tool_use_prompt_tokens = usage_metadata.tool_use_prompt_token_count or 0
                input_tokens = prompt_tokens + tool_use_prompt_tokens
                total_tokens = usage_metadata.total_token_count or 0
                candidates_tokens = usage_metadata.candidates_token_count
                thoughts_tokens = usage_metadata.thoughts_token_count or 0
                # Gemini's total_token_count folds four disjoint buckets (prompt + candidates +
                # tool_use_prompt + thoughts). tool_use_prompt is input and thoughts are billed as output,
                # so deriving output by subtraction miscounts tool_use_prompt as output; sum each side from
                # its own fields, falling back to subtraction only when candidates is absent.
                usage_data: Usage = {
                    "inputTokens": input_tokens,
                    "outputTokens": (
                        candidates_tokens + thoughts_tokens
                        if candidates_tokens is not None
                        else max(0, total_tokens - input_tokens)
                    ),
                    "totalTokens": total_tokens,
                }

                if cached := usage_metadata.cached_content_token_count:
                    usage_data["cacheReadInputTokens"] = cached

                return {
                    "metadata": {
                        "usage": usage_data,
                        "metrics": {
                            "latencyMs": 0,  # TODO
                        },
                    },
                }

            case _:  # pragma: no cover
                raise RuntimeError(f"chunk_type=<{event['chunk_type']} | unknown type")

    @override
    async def count_tokens(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None,
    ) -> int:
        """Count tokens using Gemini's native count_tokens API.

        Uses the Gemini count_tokens API for message contents. The Gemini API does not support
        counting system_instruction or tools, so those are estimated via the base class heuristic.

        Args:
            messages: List of message objects to count tokens for.
            tool_specs: List of tool specifications to include in the count.
            system_prompt: Plain string system prompt.
            system_prompt_content: Structured system prompt content blocks.

        Returns:
            Total input token count.
        """
        if self.config.get("use_native_token_count") is not True:
            return await super().count_tokens(messages, tool_specs, system_prompt, system_prompt_content)

        try:
            contents = list(self._format_request_content(messages))

            client = self._get_client().aio
            response = await client.models.count_tokens(
                model=self.config["model_id"],
                contents=contents,
            )
            if response.total_tokens is None:
                raise ProviderTokenCountError("Gemini count_tokens returned None for total_tokens")
            total_tokens: int = response.total_tokens

            # The google-genai SDK explicitly raises ValueError for system_instruction, tools, and
            # generation_config in CountTokensConfig on the non-Vertex (mldev) backend.
            # Use heuristic for these.
            extra = await super().count_tokens(
                messages=[],
                tool_specs=tool_specs,
                system_prompt=system_prompt,
                system_prompt_content=system_prompt_content,
            )
            total_tokens += extra

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

    async def stream(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        *,
        tool_choice: ToolChoice | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Stream conversation with the Gemini model.

        Args:
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            system_prompt: System prompt to provide context to the model.
            tool_choice: Selection strategy for tool invocation. Applied only when tool specs are provided,
                since there is nothing to choose from without them, and only when params sets no tool config of
                its own - an explicit tool config takes precedence.
            **kwargs: Additional keyword arguments for future extensibility.

        Yields:
            Formatted message chunks from the model.

        Raises:
            ModelThrottledException: If the request is throttled by Gemini.
        """
        request = self._format_request(
            messages, tool_specs, system_prompt, self.config.get("params"), tool_choice=tool_choice
        )

        client = self._get_client().aio

        try:
            response = await client.models.generate_content_stream(**request)

            yield self._format_chunk({"chunk_type": "message_start"})

            data_type: str | None = None
            tool_used = False
            candidate = None
            event = None
            async for event in response:
                candidates = event.candidates
                candidate = candidates[0] if candidates else None
                content = candidate.content if candidate else None
                parts = content.parts if content and content.parts else []

                for part in parts:
                    if part.function_call:
                        if data_type is not None:
                            yield self._format_chunk({"chunk_type": "content_stop", "data_type": data_type})
                            data_type = None

                        yield self._format_chunk({"chunk_type": "content_start", "data_type": "tool", "data": part})
                        yield self._format_chunk({"chunk_type": "content_delta", "data_type": "tool", "data": part})
                        yield self._format_chunk({"chunk_type": "content_stop", "data_type": "tool", "data": part})
                        tool_used = True

                    if part.text:
                        new_data_type = "reasoning_content" if part.thought else "text"
                        if new_data_type != data_type:
                            if data_type is not None:
                                yield self._format_chunk({"chunk_type": "content_stop", "data_type": data_type})
                            yield self._format_chunk({"chunk_type": "content_start", "data_type": new_data_type})
                            data_type = new_data_type
                        yield self._format_chunk(
                            {
                                "chunk_type": "content_delta",
                                "data_type": data_type,
                                "data": part,
                            },
                        )

                    # A thought signature can arrive on a part carrying no text of its own (Gemini
                    # attaches it to a trailing empty part), so emit it independently of part.text;
                    # gating on part.text drops those signatures during aggregation. Function-call
                    # parts carry their signature on the tool-use block start instead (see above).
                    if part.thought_signature and not part.function_call:
                        if data_type != "reasoning_content":
                            if data_type is not None:
                                yield self._format_chunk({"chunk_type": "content_stop", "data_type": data_type})
                            yield self._format_chunk({"chunk_type": "content_start", "data_type": "reasoning_content"})
                            data_type = "reasoning_content"
                        yield self._format_chunk(
                            {
                                "chunk_type": "content_delta",
                                "data_type": "reasoning_signature",
                                "data": part,
                            },
                        )

            if data_type is not None:
                yield self._format_chunk({"chunk_type": "content_stop", "data_type": data_type})
            yield self._format_chunk(
                {
                    "chunk_type": "message_stop",
                    "data": "TOOL_USE" if tool_used else (candidate.finish_reason if candidate else "STOP"),
                }
            )
            if event:
                yield self._format_chunk({"chunk_type": "metadata", "data": event.usage_metadata})

        except genai.errors.ClientError as error:
            match error.status:
                case "RESOURCE_EXHAUSTED" | "UNAVAILABLE":
                    raise ModelThrottledException(error.message or str(error)) from error
                case "INVALID_ARGUMENT":
                    if error.message and "exceeds the maximum number of tokens" in error.message:
                        raise ContextWindowOverflowException(error.message) from error
                    raise error
                case _:
                    raise error

    @override
    async def structured_output(
        self, output_model: type[T], prompt: Messages, system_prompt: str | None = None, **kwargs: Any
    ) -> AsyncGenerator[dict[str, T | Any], None]:
        """Get structured output from the model using Gemini's native structured output.

        - Docs: https://ai.google.dev/gemini-api/docs/structured-output

        Args:
            output_model: The output model to use for the agent.
            prompt: The prompt messages to use for the agent.
            system_prompt: System prompt to provide context to the model.
            **kwargs: Additional keyword arguments for future extensibility.

        Yields:
            Model events with the last being the structured output.
        """
        params = {
            **(self.config.get("params") or {}),
            "response_mime_type": "application/json",
            "response_schema": output_model.model_json_schema(),
        }
        request = self._format_request(prompt, None, system_prompt, params)
        client = self._get_client().aio
        response = await client.models.generate_content(**request)
        yield {"output": output_model.model_validate(response.parsed)}

    @staticmethod
    def _validate_gemini_tools(gemini_tools: list[genai.types.Tool]) -> None:
        """Validate that gemini_tools does not contain FunctionDeclarations.

        Gemini-specific tools should only include tools that cannot be represented
        as FunctionDeclarations (e.g., GoogleSearch, CodeExecution, ComputerUse).
        Standard function calling tools should use the tools interface instead.

        Args:
            gemini_tools: List of Gemini tools to validate

        Raises:
            ValueError: If any tool contains function_declarations
        """
        for tool in gemini_tools:
            # Check if the tool has function_declarations attribute and it's not empty
            if hasattr(tool, "function_declarations") and tool.function_declarations:
                raise ValueError(
                    "gemini_tools should not contain FunctionDeclarations. "
                    "Use the standard tools interface for function calling tools. "
                    "gemini_tools is reserved for Gemini-specific tools like "
                    "GoogleSearch, CodeExecution, ComputerUse, UrlContext, and FileSearch."
                )

"""AWS Bedrock model provider.

- Docs: https://aws.amazon.com/bedrock/
"""

import asyncio
import json
import logging
import os
import threading
import warnings
from collections.abc import AsyncGenerator, Callable, Iterable, ValuesView
from typing import Any, Literal, TypeVar, cast

import boto3
from botocore import UNSIGNED
from botocore.config import Config as BotocoreConfig
from botocore.exceptions import ClientError
from pydantic import BaseModel
from typing_extensions import Unpack, override

from strands.types.media import S3Location, SourceLocation

from .._exception_notes import add_exception_note
from ..event_loop import streaming
from ..tools import convert_pydantic_to_tool_spec
from ..tools._tool_helpers import noop_tool
from ..types.content import CachePoint, ContentBlock, GuardContent, Messages, SystemContentBlock
from ..types.exceptions import (
    ContextWindowOverflowException,
    ModelThrottledException,
    ProviderTokenCountError,
)
from ..types.streaming import CitationsDelta, StreamEvent
from ..types.tools import ToolChoice, ToolSpec
from ._defaults import resolve_config_metadata
from ._strict_schema import ensure_strict_json_schema
from ._validation import _warn_on_deprecated_cache_tools, validate_config_keys
from .model import BaseModelConfig, CacheConfig, CacheToolsConfig, Model

logger = logging.getLogger(__name__)

# See: `BedrockModel._get_default_model_with_warning` for why we need both
DEFAULT_BEDROCK_MODEL_ID = "global.anthropic.claude-sonnet-4-6"
_DEFAULT_BEDROCK_MODEL_ID = "{}.anthropic.claude-sonnet-4-6"
DEFAULT_BEDROCK_REGION = "us-west-2"

_BEDROCK_VIDEO_FORMAT_ALIASES = {
    "3gp": "three_gp",
    "3g2": "three_gp",
    "3gpp": "three_gp",
}

BEDROCK_CONTEXT_WINDOW_OVERFLOW_MESSAGES = [
    "Input is too long for requested model",
    "input length and `max_tokens` exceed context limit",
    "too many total text bytes",
    "prompt is too long",
    "This model's maximum context length is",
]

# Bedrock reports this exact substring for the Converse incompatibility tracked in #1223.
_TOOL_RESULT_TURN_VALIDATION_MESSAGE = "Conversation blocks and tool result blocks cannot be provided in the same turn."

# Models that should include tool result status (include_tool_result_status = True)
_MODELS_INCLUDE_STATUS = [
    "anthropic.claude",
]

# Models that hallucinate when receiving JSON content blocks in tool results
_MODELS_CONVERT_JSON_TO_TEXT = [
    "amazon.nova",
]

# Cache of model IDs for which CountTokens API calls should be skipped.
_SKIP_COUNT_TOKENS_MODELS: set[str] = set()


def _clear_skip_count_tokens_cache() -> None:
    """Clear the cache of model IDs for which CountTokens API calls should be skipped."""
    _SKIP_COUNT_TOKENS_MODELS.clear()


def _suppress_task_exception(task: "asyncio.Task[None]") -> None:
    """Consume exception from orphaned stream task to silence 'never retrieved' warning."""
    if not task.cancelled():
        task.exception()


async def _poll_cancel_signal(cancel_signal: threading.Event) -> None:
    """Complete once the cancellation signal is set."""
    # threading.Event has no async notification hook. Poll on this loop rather than running
    # Event.wait() in an executor: cancelling that await cannot stop a worker already blocked
    # in Event.wait(), so completed streams could strand worker threads.
    while not cancel_signal.is_set():
        await asyncio.sleep(_CANCEL_POLL_INTERVAL)


async def _next_stream_event(
    queue: "asyncio.Queue[StreamEvent | None]", cancel_poll: "asyncio.Future[None] | None"
) -> "StreamEvent | None":
    """Wait for the worker thread's next event, giving up if cancellation gets there first.

    Args:
        queue: Queue the worker thread publishes events to.
        cancel_poll: Future that completes on cancellation, or None when the caller supplied no
            cancellation signal.

    Returns:
        The next event, or None when the worker is done or cancellation won the race.
    """
    if cancel_poll is None:
        return await queue.get()

    # Fast path: skip the race machinery whenever an event is already available.
    try:
        return queue.get_nowait()
    except asyncio.QueueEmpty:
        pass

    get_event = asyncio.ensure_future(queue.get())
    pending: set[asyncio.Future[Any]] = {get_event, cancel_poll}
    try:
        await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
    except BaseException:
        get_event.cancel()
        raise

    if get_event.done():
        return get_event.result()

    get_event.cancel()
    return None


T = TypeVar("T", bound=BaseModel)

DEFAULT_READ_TIMEOUT = 120

# How often the consumer side checks a cancellation signal while waiting for the next event.
_CANCEL_POLL_INTERVAL = 0.05


class BedrockModel(Model):
    """AWS Bedrock model provider implementation.

    The implementation handles Bedrock-specific features such as:

    - Tool configuration for function calling
    - Guardrails integration
    - Caching points for system prompts and tools
    - Streaming responses
    - Context window overflow detection
    """

    class BedrockConfig(BaseModelConfig, total=False):
        """Configuration options for Bedrock models.

        Attributes:
            additional_args: Any additional arguments to include in the request
            additional_request_fields: Additional fields to include in the Bedrock request
            additional_response_field_paths: Additional response field paths to extract
            cache_prompt: Cache point type for the system prompt (deprecated, use cache_config)
            cache_config: Configuration for prompt caching. Use CacheConfig(strategy="auto") for automatic caching.
            cache_tools: Cache point type for tools (deprecated, use CacheConfig(tools_ttl=...)). Pass a string
                (e.g. "default") to cache the tools with no explicit TTL, or a CacheToolsConfig instance to set
                both type and TTL (e.g. "1h"). Inherits cache_config.ttl if specified, otherwise it takes the
                Bedrock default. Superseded by an explicitly set cache_config.tools_ttl.
            guardrail_id: ID of the guardrail to apply
            guardrail_trace: Guardrail trace mode. Defaults to enabled.
            guardrail_version: Version of the guardrail to apply
            guardrail_stream_processing_mode: The guardrail processing mode
            guardrail_redact_input: Flag to redact input if a guardrail is triggered. Defaults to True.
            guardrail_redact_input_message: If a Bedrock Input guardrail triggers, replace the input with this message.
            guardrail_redact_output: Flag to redact output if guardrail is triggered. Defaults to False.
            guardrail_redact_output_message: If a Bedrock Output guardrail triggers, replace output with this message.
            guardrail_latest_message: Flag to send only the lastest user message to guardrails.
                Defaults to False.
            max_tokens: Maximum number of tokens to generate in the response
            model_id: The Bedrock model ID (e.g., "global.anthropic.claude-sonnet-4-6")
            include_tool_result_status: Flag to include status field in tool results.
                True includes status, False removes status, "auto" determines based on model_id. Defaults to "auto".
            service_tier: Service tier for the request, controlling the trade-off between latency and cost.
                Valid values: "default" (standard), "priority" (faster, premium), "flex" (cheaper, slower).
                Please check https://docs.aws.amazon.com/bedrock/latest/userguide/service-tiers-inference.html for
                supported service tiers, models, and regions
            stop_sequences: List of sequences that will stop generation when encountered
            streaming: Flag to enable/disable streaming. Defaults to True.
            strict_tools: Flag to enable structured output enforcement on tool definitions.
                When True, adds strict: true to each tool spec and automatically injects
                "additionalProperties": false into all object types in tool input schemas.
                Bedrock's strict mode compiles tool schemas into a constrained-decoding grammar and
                restricts which JSON Schema features tool input schemas may use (for example, "oneOf"
                is unsupported and optional parameters are capped across all tools in the request).
                A schema that uses an unsupported feature fails at request time with a
                ValidationException.
                See https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html
            temperature: Controls randomness in generation (higher = more random)
            top_p: Controls diversity via nucleus sampling (alternative to temperature)
            use_native_token_count: Whether to use the native Bedrock CountTokens API.
                When True, count_tokens() calls the Bedrock API for accurate counts.
                When False (default), skips the API call and uses the local estimator.
        """

        additional_args: dict[str, Any] | None
        additional_request_fields: dict[str, Any] | None
        additional_response_field_paths: list[str] | None
        cache_prompt: str | None
        cache_config: CacheConfig | None
        cache_tools: str | CacheToolsConfig | None
        guardrail_id: str | None
        guardrail_trace: Literal["enabled", "disabled", "enabled_full"] | None
        guardrail_stream_processing_mode: Literal["sync", "async"] | None
        guardrail_version: str | None
        guardrail_redact_input: bool | None
        guardrail_redact_input_message: str | None
        guardrail_redact_output: bool | None
        guardrail_redact_output_message: str | None
        guardrail_latest_message: bool | None
        max_tokens: int | None
        model_id: str
        include_tool_result_status: Literal["auto"] | bool | None
        service_tier: str | None
        stop_sequences: list[str] | None
        streaming: bool | None
        strict_tools: bool | None
        temperature: float | None
        top_p: float | None
        use_native_token_count: bool

    def __init__(
        self,
        *,
        boto_session: boto3.Session | None = None,
        boto_client_config: BotocoreConfig | None = None,
        region_name: str | None = None,
        endpoint_url: str | None = None,
        api_key: str | None = None,
        **model_config: Unpack[BedrockConfig],
    ):
        """Initialize provider instance.

        Args:
            boto_session: Boto Session to use when calling the Bedrock Model.
            boto_client_config: Configuration to use when creating the Bedrock-Runtime Boto Client.
            region_name: AWS region to use for the Bedrock service.
                Defaults to the AWS_REGION environment variable if set, or "us-west-2" if not set.
            endpoint_url: Custom endpoint URL for VPC endpoints (PrivateLink)
            api_key: Amazon Bedrock API key for bearer token authentication.
                When provided, requests use the API key instead of SigV4 signing.
            **model_config: Configuration options for the Bedrock model.
        """
        if region_name and boto_session:
            raise ValueError("Cannot specify both `region_name` and `boto_session`.")

        session = boto_session or boto3.Session()
        resolved_region = region_name or session.region_name or os.environ.get("AWS_REGION") or DEFAULT_BEDROCK_REGION
        self.config = BedrockModel.BedrockConfig(
            model_id=BedrockModel._get_default_model_with_warning(resolved_region, model_config),
            include_tool_result_status="auto",
        )
        self._tool_result_turn_separation_model_id: str | None = None
        self.update_config(**model_config)

        logger.debug("config=<%s> | initializing", self.config)

        # Add strands-agents to the request user agent
        if boto_client_config:
            existing_user_agent = getattr(boto_client_config, "user_agent_extra", None)

            # Append 'strands-agents' to existing user_agent_extra or set it if not present
            if existing_user_agent:
                new_user_agent = f"{existing_user_agent} strands-agents"
            else:
                new_user_agent = "strands-agents"

            client_config = boto_client_config.merge(
                BotocoreConfig(
                    user_agent_extra=new_user_agent,
                    **({"signature_version": UNSIGNED} if api_key else {}),
                )
            )
        else:
            client_config = BotocoreConfig(
                user_agent_extra="strands-agents",
                read_timeout=DEFAULT_READ_TIMEOUT,
                **({"signature_version": UNSIGNED} if api_key else {}),
            )

        self.client = session.client(
            service_name="bedrock-runtime",
            config=client_config,
            endpoint_url=endpoint_url,
            region_name=resolved_region,
        )

        if api_key:

            def set_bearer_auth(request: Any, **_: Any) -> None:
                request.headers["Authorization"] = f"Bearer {api_key}"

            self.client.meta.events.register("before-send.bedrock-runtime.*", set_bearer_auth)

        logger.debug("region=<%s> | bedrock client created", self.client.meta.region_name)

    @property
    def _cache_strategy(self) -> str | None:
        """The effective cache strategy for this request, or None when caching is off or unsupported.

        Resolves ``cache_config.strategy``: an explicit strategy is returned as written, while ``"auto"``
        maps to ``"anthropic"`` for Claude/Anthropic model IDs and None for models without automatic
        caching support.
        """
        cache_config = self.config.get("cache_config")
        if not cache_config:
            return None
        if cache_config.strategy != "auto":
            return cache_config.strategy
        model_id = self.config.get("model_id", "").lower()
        if "claude" in model_id or "anthropic" in model_id:
            return "anthropic"
        return None

    @override
    def update_config(self, **model_config: Unpack[BedrockConfig]) -> None:  # type: ignore
        """Update the Bedrock Model configuration with the provided arguments.

        Args:
            **model_config: Configuration overrides.
        """
        validate_config_keys(model_config, self.BedrockConfig)
        # __init__ delegates here, so the caller sits at stacklevel 4 on the constructor path.
        _warn_on_deprecated_cache_tools(model_config, stacklevel=4)
        self.config.update(model_config)

    @override
    def get_config(self) -> BedrockConfig:
        """Get the current Bedrock Model configuration.

        Returns:
            The Bedrock model configuration.
        """
        return resolve_config_metadata(self.config, self.config.get("model_id", ""))

    def format_request(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None,
        tool_choice: ToolChoice | None = None,
        dynamic_trailing_blocks: int = 0,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Format a Bedrock converse stream request.

        Args:
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            tool_choice: Selection strategy for tool invocation.
            system_prompt_content: System prompt content blocks to provide context to the model.
            dynamic_trailing_blocks: How many trailing blocks of the last user message are rebuilt on every
                call, so the cache point goes ahead of them.
            **kwargs: Additional keyword arguments for future extensibility.

        Returns:
            A Bedrock converse stream request.
        """
        if not tool_specs:
            has_tool_content = any(
                any("toolUse" in block or "toolResult" in block for block in msg.get("content", [])) for msg in messages
            )
            if has_tool_content:
                tool_specs = [noop_tool.tool_spec]

        # Use system_prompt_content directly (copy for mutability)
        system_blocks: list[SystemContentBlock] = system_prompt_content.copy() if system_prompt_content else []

        # Add cache point if configured (backwards compatibility)
        if cache_prompt := self.config.get("cache_prompt"):
            warnings.warn(
                "cache_prompt is deprecated. Use SystemContentBlock with cachePoint instead.", UserWarning, stacklevel=3
            )
            system_blocks.append({"cachePoint": {"type": cache_prompt}})

        # Built ahead of the request so the tools cache point is known to the system cache point behind it.
        tools_cache_point = self._build_tools_cache_point() if tool_specs else []

        if self._should_cache_system(system_blocks):
            system_blocks.append({"cachePoint": {"type": "default"}})

        formatted_messages = self._format_bedrock_messages(messages, dynamic_trailing_blocks)
        if self._tool_result_turn_separation_model_id == self.config["model_id"]:
            formatted_messages = self._separate_tool_result_turns(formatted_messages)

        return {
            "modelId": self.config["model_id"],
            "messages": formatted_messages,
            "system": self._apply_system_cache_ttl(system_blocks, tools_cache_point),
            **({"serviceTier": {"type": self.config["service_tier"]}} if self.config.get("service_tier") else {}),
            **(
                {
                    "toolConfig": {
                        "tools": [
                            *[
                                {
                                    "toolSpec": {
                                        "name": tool_spec["name"],
                                        "description": tool_spec["description"],
                                        "inputSchema": (
                                            {"json": ensure_strict_json_schema(tool_spec["inputSchema"]["json"])}
                                            if self.config.get("strict_tools")
                                            else tool_spec["inputSchema"]
                                        ),
                                        **({"strict": True} if self.config.get("strict_tools") else {}),
                                    }
                                }
                                for tool_spec in tool_specs
                            ],
                            *tools_cache_point,
                        ],
                        **({"toolChoice": tool_choice if tool_choice else {"auto": {}}}),
                    }
                }
                if tool_specs
                else {}
            ),
            **(self._get_additional_request_fields(tool_choice)),
            **(
                {"additionalModelResponseFieldPaths": self.config["additional_response_field_paths"]}
                if self.config.get("additional_response_field_paths")
                else {}
            ),
            **(
                {
                    "guardrailConfig": {
                        "guardrailIdentifier": self.config["guardrail_id"],
                        "guardrailVersion": self.config["guardrail_version"],
                        "trace": self.config.get("guardrail_trace", "enabled"),
                        **(
                            {"streamProcessingMode": self.config.get("guardrail_stream_processing_mode")}
                            if self.config.get("guardrail_stream_processing_mode")
                            else {}
                        ),
                    }
                }
                if self.config.get("guardrail_id") and self.config.get("guardrail_version")
                else {}
            ),
            "inferenceConfig": {
                key: value
                for key, value in [
                    ("maxTokens", self.config.get("max_tokens")),
                    ("temperature", self.config.get("temperature")),
                    ("topP", self.config.get("top_p")),
                    ("stopSequences", self.config.get("stop_sequences")),
                ]
                if value is not None
            },
            **(
                self.config["additional_args"]
                if "additional_args" in self.config and self.config["additional_args"] is not None
                else {}
            ),
        }

    def _get_additional_request_fields(self, tool_choice: ToolChoice | None) -> dict[str, Any]:
        """Get additional request fields, removing thinking if tool_choice forces tool use.

        Bedrock's API does not allow thinking mode when tool_choice forces tool use.
        When forcing a tool (e.g., for structured_output retry), we temporarily disable thinking.

        Args:
            tool_choice: The tool choice configuration.

        Returns:
            A dict containing additionalModelRequestFields if configured, or empty dict.
        """
        additional_fields = self.config.get("additional_request_fields")
        if not additional_fields:
            return {}

        # Check if tool_choice is forcing tool use ("any" or specific "tool")
        is_forcing_tool = tool_choice is not None and ("any" in tool_choice or "tool" in tool_choice)

        if is_forcing_tool and "thinking" in additional_fields:
            # Create a copy without the thinking key
            fields_without_thinking = {k: v for k, v in additional_fields.items() if k != "thinking"}
            if fields_without_thinking:
                return {"additionalModelRequestFields": fields_without_thinking}
            return {}

        return {"additionalModelRequestFields": additional_fields}

    def _apply_system_cache_ttl(
        self, system_blocks: list[SystemContentBlock], tools_cache_point: list[dict[str, Any]]
    ) -> list[SystemContentBlock]:
        """Apply ``cache_config.ttl`` to a caller-placed system cache point that carries no TTL of its own.

        Bedrock rejects a TTL that exceeds an earlier cache point's, in the order toolConfig, system,
        messages. Filling the system point in keeps it from sitting at the default between two configured
        points. A TTL the caller wrote on the point is left as written. An explicit ``cache_config.system_prompt_ttl``
        string is honored as written.

        Args:
            system_blocks: System content blocks for the request.
            tools_cache_point: The toolConfig cache point emitted for this request, if any.

        Returns:
            The blocks, with a cache point replaced rather than mutated since the caller owns the block.
        """
        ttl: str | None = None
        cache_config = self.config.get("cache_config")
        if cache_config and self._cache_strategy == "anthropic":
            system_prompt_ttl = cache_config.system_prompt_ttl
            section_ttl = system_prompt_ttl if isinstance(system_prompt_ttl, str) else cache_config.ttl
            if section_ttl:
                tools_ttl_differs = bool(tools_cache_point) and (
                    tools_cache_point[0]["cachePoint"].get("ttl") != section_ttl
                )
                if isinstance(system_prompt_ttl, str) or not tools_ttl_differs:
                    ttl = section_ttl

        normalized: list[SystemContentBlock] = []
        for block in system_blocks:
            cache_point = block.get("cachePoint")
            # A TTL the caller wrote is theirs, so only a falsy one is rewritten.
            if cache_point is None or cache_point.get("ttl"):
                normalized.append(block)
                continue

            point: CachePoint = {**cache_point}
            # pop() rather than a conditional write, exactly as the message path does, so both paths drop
            # a falsy TTL by the same rule.
            point.pop("ttl", None)
            if ttl:
                point["ttl"] = ttl
            normalized.append(SystemContentBlock(**{**block, "cachePoint": point}))

        return normalized

    def _should_cache_system(self, system_blocks: list[SystemContentBlock]) -> bool:
        """Whether to auto-inject a cache point at the end of the system prompt.

        Args:
            system_blocks: The system content blocks that will be sent to Bedrock.

        Returns:
            True if a cache point should be appended.
        """
        if self._cache_strategy != "anthropic":
            return False

        cache_config = self.config.get("cache_config")
        if not cache_config or cache_config.system_prompt_ttl is False:
            return False

        if not system_blocks:
            return False

        return not any("cachePoint" in block for block in system_blocks)

    def _build_tools_cache_point(self) -> list[dict[str, Any]]:
        """Build the cache point block appended to ``toolConfig.tools`` when tool caching is configured.

        An explicitly set ``cache_config.tools_ttl`` drives the point, mirroring ``system_prompt_ttl`` - a TTL
        string sets the tools section's own duration, True derives it from ``cache_config.ttl``, and False
        disables it; a section that carries no TTL of its own inherits ``cache_config.ttl``. When ``tools_ttl``
        is left unset (None), the deprecated model-level ``cache_tools`` drives the point instead so existing
        configurations keep working unchanged.

        Returns:
            A single-element list containing the cache point block, or an empty list when tool caching is off.
        """
        cache_config = self.config.get("cache_config")
        if cache_config is None or cache_config.tools_ttl is None:
            return self._build_deprecated_cache_tools_point(cache_config)

        tools_ttl = cache_config.tools_ttl
        if tools_ttl is False or self._cache_strategy != "anthropic":
            return []

        ttl = tools_ttl if isinstance(tools_ttl, str) else cache_config.ttl
        cache_point: dict[str, Any] = {"type": "default"}
        if ttl:
            cache_point["ttl"] = ttl

        return [{"cachePoint": cache_point}]

    def _build_deprecated_cache_tools_point(self, cache_config: CacheConfig | None) -> list[dict[str, Any]]:
        """Build the tools cache point from the deprecated model-level ``cache_tools`` option.

        Reached only when ``cache_config.tools_ttl`` is unset; an explicit ``tools_ttl`` supersedes this path.

        Returns:
            A single-element list containing the cache point block, or an empty list when ``cache_tools`` is off.
        """
        cache_tools = self.config.get("cache_tools")
        if not cache_tools:
            return []

        if cache_config is not None and self._cache_strategy != "anthropic":
            return []

        if isinstance(cache_tools, CacheToolsConfig):
            cache_type, ttl = cache_tools.type, cache_tools.ttl
        else:
            cache_type, ttl = cache_tools, None

        if not ttl and cache_config and cache_config.ttl and self._cache_strategy == "anthropic":
            ttl = cache_config.ttl

        cache_point: dict[str, Any] = {"type": cache_type}
        if ttl:
            cache_point["ttl"] = ttl

        return [{"cachePoint": cache_point}]

    def _honor_placed_cache_point(
        self,
        content: list[dict[str, Any]],
        placed_idx: int,
        msg_idx: int,
        cache_config: CacheConfig | None,
    ) -> bool:
        """Keep a caller-placed cache point, taking the configured TTL and the document rule.

        The caller's *position* is honored; their TTL is not. Bedrock processes cache points in the
        order toolConfig, system, messages and rejects a longer TTL that follows a shorter one, so a
        TTL written here can turn a working configuration into a rejected request - verified against
        the API: tools at 5m with a hand-placed 1h on the message is rejected, the same shape at 5m is
        accepted. Normalizing to ``cache_config.ttl`` is what makes the honored path TTL-identical to
        the automatic one, which is the only behaviour this method should be changing.

        Args:
            content: Content blocks of the last user message (modified in place).
            placed_idx: Index of the caller-placed cache point.
            msg_idx: Index of the message, for logging.
            cache_config: The configured cache settings, if any.

        Returns:
            True when the point was kept, possibly relocated. False when nothing cacheable precedes it,
            so the point was removed: Bedrock rejects a cache point with no content ahead of it ("There
            is nothing available to cache"). The caller then retries automatic placement, which lands a
            point only if the remaining content allows one - for a leading document it declines too, so
            the message ends up with no cache point at all.
        """
        placed = content[placed_idx]

        if placed_idx == 0:
            del content[placed_idx]
            logger.warning(
                "msg_idx=<%s> | removed cache point with no content ahead of it, falling back to automatic placement",
                msg_idx,
            )
            return False

        cache_point = placed["cachePoint"]
        # Dropping it unconditionally also handles a caller TTL of None or "", which botocore and
        # Bedrock respectively reject before the request can even be judged on placement. The
        # non-increasing rule itself is documented on CacheConfig.
        cache_point.pop("ttl", None)
        if cache_config and cache_config.ttl:
            cache_point["ttl"] = cache_config.ttl

        # Bedrock only rejects a cache point *directly* preceded by a non-PDF document, so step back
        # over the adjacent run of them. Moving further would evict durable content - usually the
        # document itself, the expensive part - from the cached prefix for no reason.
        target_idx = placed_idx
        while target_idx > 0:
            previous = content[target_idx - 1]
            if "document" not in previous or previous["document"].get("format", "") == "pdf":
                break
            target_idx -= 1

        if target_idx != placed_idx:
            del content[placed_idx]
            if target_idx == 0:
                # Nothing precedes the documents, so there is no prefix to cache. Automatic placement
                # declines for the same reason, leaving the message with no cache point.
                logger.warning("msg_idx=<%s> | dropped cache point ahead of a leading document", msg_idx)
                return False
            content.insert(target_idx, placed)
            logger.debug("msg_idx=<%s>, block_idx=<%s> | relocated caller-placed cache point", msg_idx, target_idx)
            return True

        logger.debug("msg_idx=<%s>, block_idx=<%s> | honored caller-placed cache point", msg_idx, placed_idx)
        return True

    def _inject_cache_point(self, messages: list[dict[str, Any]], dynamic_trailing_blocks: int = 0) -> None:
        """Ensure the last user message carries exactly one cache point.

        A cache point already present in the last user message is honored where it sits rather than
        replaced: a caller places one to mark where its reusable prefix ends, ahead of content that is
        rebuilt every call. Moving it to the end of the message would put that per-call content inside
        the cached prefix, so every request would write a new entry and none would ever read one.

        Cache points in earlier messages are still removed, so they cannot accumulate one per turn
        against the provider's cache-point budget.

        Args:
            messages: List of messages to inject cache point into (modified in place).
            dynamic_trailing_blocks: How many trailing blocks of the last user message are rebuilt on every call.
                The point goes ahead of them, for the same reason a caller-placed one is honored.
        """
        if not messages:
            return

        last_user_idx: int | None = None
        for msg_idx, msg in enumerate(messages):
            if msg.get("role") == "user":
                last_user_idx = msg_idx

        for msg_idx, msg in enumerate(messages):
            if msg_idx == last_user_idx:
                continue
            content = msg.get("content", [])
            for block_idx, block in reversed(list(enumerate(content))):
                if "cachePoint" in block:
                    del content[block_idx]
                    logger.warning(
                        "msg_idx=<%s>, block_idx=<%s> | stripped existing cache point (auto mode manages cache points)",
                        msg_idx,
                        block_idx,
                    )

        if last_user_idx is not None and messages[last_user_idx].get("content"):
            cache_point: dict[str, Any] = {"type": "default"}
            cache_config = self.config.get("cache_config")
            if cache_config and cache_config.ttl:
                cache_point["ttl"] = cache_config.ttl

            content = messages[last_user_idx]["content"]

            placed_idxs = [idx for idx, block in enumerate(content) if "cachePoint" in block]
            if placed_idxs:
                # One boundary per message, so this message contributes a single cache point to the budget.
                # Extras are not worthless - a second point ahead of the per-call tail doubles the cached
                # prefix - but Bedrock allows only four cache points per request and the budget is shared
                # across toolConfig, system and messages. The SDK already spends up to two of them via
                # cache_tools and cache_prompt, so honoring a caller's extras needs that arithmetic
                # first, or three caller points become a hard rejection rather than weaker caching.
                for extra_idx in reversed(placed_idxs[1:]):
                    del content[extra_idx]
                    logger.warning(
                        "msg_idx=<%s>, block_idx=<%s> | stripped existing cache point (auto mode manages cache points)",
                        last_user_idx,
                        extra_idx,
                    )
                if self._honor_placed_cache_point(content, placed_idxs[0], last_user_idx, cache_config):
                    return
                if not content:
                    # Removing the point emptied the message, so there is nothing left to cache and
                    # re-adding one would rebuild the request Bedrock just refused. Bedrock rejects an
                    # empty message too, exactly as the pre-existing strip path already did.
                    logger.debug("msg_idx=<%s> | no content left to cache", last_user_idx)
                    return
                # The point could not legally stay, so fall through to automatic placement below.

            if dynamic_trailing_blocks:
                # Routed through the honor path so the document rule and configured TTL still apply.
                boundary_idx = max(0, len(content) - dynamic_trailing_blocks)
                if boundary_idx == 0:
                    logger.debug("msg_idx=<%s> | skipped cache point, no durable prefix", last_user_idx)
                    return
                content.insert(boundary_idx, {"cachePoint": cache_point})
                # A False here means a leading document left no prefix to cache; automatic placement
                # declines for the same reason, so there is nothing to fall back to.
                self._honor_placed_cache_point(content, boundary_idx, last_user_idx, cache_config)
                return

            # Insert before non-PDF document blocks to avoid Bedrock ValidationException
            first_non_pdf_doc_idx: int | None = None
            for i, block in enumerate(content):
                if "document" in block and block["document"].get("format", "") != "pdf":
                    first_non_pdf_doc_idx = i
                    break

            # Insert the cache point before the first non-PDF document so it is not directly
            # preceded by that block, which Bedrock rejects with a ValidationException
            if first_non_pdf_doc_idx is None:
                content.append({"cachePoint": cache_point})
            elif first_non_pdf_doc_idx > 0:
                content.insert(first_non_pdf_doc_idx, {"cachePoint": cache_point})
            else:
                # A leading non-PDF document leaves no prefix to cache and Bedrock rejects it
                logger.debug("msg_idx=<%s> | skipped cache point for leading non-PDF document", last_user_idx)
                return

            logger.debug("msg_idx=<%s> | added cache point to last user message", last_user_idx)

    def _find_last_user_text_message_index(self, messages: Messages) -> int | None:
        """Find the index of the last user message containing text or image content.

        This is used for guardrail_latest_message to ensure that guardContent wrapping
        targets the correct message even when toolResult messages follow.

        Args:
            messages: List of messages to search

        Returns:
            Index of the last user message with text/image content, or None if not found
        """
        for idx, msg in reversed(list(enumerate(messages))):
            if msg["role"] == "user" and any("text" in cb or "image" in cb for cb in msg.get("content", [])):
                return idx
        return None

    def _format_bedrock_messages(self, messages: Messages, dynamic_trailing_blocks: int = 0) -> list[dict[str, Any]]:
        """Format messages for Bedrock API compatibility.

        This function ensures messages conform to Bedrock's expected format by:
        - Filtering out SDK_UNKNOWN_MEMBER content blocks
        - Eagerly filtering content blocks to only include Bedrock-supported fields
        - Ensuring all message content blocks are properly formatted for the Bedrock API
        - Optionally wrapping the last user message in guardrailConverseContent blocks
        - Injecting cache points when cache_config is set with strategy="auto"

        Args:
            messages: List of messages to format
            dynamic_trailing_blocks: How many trailing blocks of the last user message are rebuilt on every
                call, so the cache point goes ahead of them.

        Returns:
            Messages formatted for Bedrock API compatibility

        Note:
            Unlike other APIs that ignore unknown fields, Bedrock only accepts a strict
            subset of fields for each content block type and throws validation exceptions
            when presented with unexpected fields. Therefore, we must eagerly filter all
            content blocks to remove any additional fields before sending to Bedrock.
            https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ContentBlock.html
        """
        cleaned_messages: list[dict[str, Any]] = []

        filtered_unknown_members = False
        dropped_deepseek_reasoning_content = False

        # Pre-compute the index of the last user message containing text or image content.
        # This ensures guardContent wrapping is maintained across tool execution cycles, where
        # the final message in the list is a toolResult (role=user) rather than text/image content.
        last_user_text_idx = None
        if self.config.get("guardrail_latest_message", False):
            last_user_text_idx = self._find_last_user_text_message_index(messages)

        for idx, message in enumerate(messages):
            cleaned_content: list[dict[str, Any]] = []

            for content_block in message["content"]:
                # Filter out SDK_UNKNOWN_MEMBER content blocks
                if "SDK_UNKNOWN_MEMBER" in content_block:
                    filtered_unknown_members = True
                    continue

                # DeepSeek models have issues with reasoningContent
                # TODO: Replace with systematic model configuration registry (https://github.com/strands-agents/harness-sdk/issues/780)
                if "deepseek" in self.config["model_id"].lower() and "reasoningContent" in content_block:
                    dropped_deepseek_reasoning_content = True
                    continue

                # Format content blocks for Bedrock API compatibility
                formatted_content = self._format_request_message_content(content_block)
                if formatted_content is None:
                    continue

                # Wrap text or image content in guardContent if this is the last user text/image message.
                # Bedrock guardContent supports a narrower set of image formats than image content.
                if idx == last_user_text_idx and ("text" in formatted_content or "image" in formatted_content):
                    if "text" in formatted_content:
                        formatted_content = {"guardContent": {"text": {"text": formatted_content["text"]}}}
                    elif "image" in formatted_content:
                        guard_image = formatted_content["image"]
                        image_format = guard_image.get("format", "")
                        supported_formats = self.client.meta.service_model.shape_for(
                            "GuardrailConverseImageFormat"
                        ).enum
                        if image_format not in supported_formats:
                            logger.warning(
                                "image_format=<%s> | format not supported by bedrock guardrails | "
                                "skipping guardContent wrap",
                                image_format,
                            )
                        elif "bytes" not in guard_image.get("source", {}):
                            logger.warning(
                                "source_type=<non-bytes> | image source must be bytes for bedrock guardrails | "
                                "skipping guardContent wrap"
                            )
                        else:
                            formatted_content = {"guardContent": {"image": guard_image}}

                cleaned_content.append(formatted_content)

            # Create new message with cleaned content (skip if empty)
            if cleaned_content:
                cleaned_messages.append({"content": cleaned_content, "role": message["role"]})

        if filtered_unknown_members:
            logger.warning(
                "Filtered out SDK_UNKNOWN_MEMBER content blocks from messages, consider upgrading boto3 version"
            )
        if dropped_deepseek_reasoning_content:
            logger.debug(
                "Filtered DeepSeek reasoningContent content blocks from messages - https://api-docs.deepseek.com/guides/reasoning_model#multi-round-conversation"
            )

        # Inject cache point into cleaned_messages (not original messages) if cache_config is set
        cache_config = self.config.get("cache_config")
        if cache_config:
            cache_strategy = self._cache_strategy
            if cache_config.strategy == "auto" and not cache_strategy:
                logger.warning(
                    "model_id=<%s> | cache_config is enabled but this model does not support automatic caching",
                    self.config.get("model_id"),
                )
            if cache_strategy == "anthropic":
                self._inject_cache_point(cleaned_messages, dynamic_trailing_blocks)

        return cleaned_messages

    @staticmethod
    def _separate_tool_result_turns(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Separate adjacent user turns rejected by some Bedrock models.

        A neutral assistant turn separates a tool-result-only user turn from the
        next conversation turn described in #1223. The transformation is
        request-local and idempotent, so persisted conversation history is not
        mutated and repeated application does not add more separators.
        """
        separated_messages: list[dict[str, Any]] = []

        for message in messages:
            if separated_messages and separated_messages[-1].get("role") == "user" and message.get("role") == "user":
                previous_content = separated_messages[-1].get("content", [])
                current_content = message.get("content", [])
                if (
                    previous_content
                    and all("toolResult" in block for block in previous_content)
                    and current_content
                    and all("toolResult" not in block for block in current_content)
                ):
                    separated_messages.append({"role": "assistant", "content": [{"text": "Tool result received."}]})

            separated_messages.append(message)

        return separated_messages

    def _should_include_tool_result_status(self) -> bool:
        """Determine whether to include tool result status based on current config."""
        include_status = self.config.get("include_tool_result_status", "auto")

        if include_status is True:
            return True
        elif include_status is False:
            return False
        else:  # "auto"
            return any(model in self.config["model_id"] for model in _MODELS_INCLUDE_STATUS)

    def _should_convert_json_to_text(self) -> bool:
        """Determine whether JSON content blocks in tool results should be converted to text.

        Some models (e.g., Amazon Nova) hallucinate when tool results contain JSON content
        blocks. Converting them to their text representation avoids this issue.
        """
        return any(model in self.config["model_id"] for model in _MODELS_CONVERT_JSON_TO_TEXT)

    def _handle_location(self, location: SourceLocation) -> dict[str, Any] | None:
        """Convert location content block to Bedrock format if its an S3Location."""
        if location["type"] == "s3":
            s3_location = cast(S3Location, location)
            formatted_document_s3: dict[str, Any] = {"uri": s3_location["uri"]}
            if "bucketOwner" in s3_location:
                formatted_document_s3["bucketOwner"] = s3_location["bucketOwner"]
            return {"s3Location": formatted_document_s3}
        else:
            logger.warning("Non s3 location sources are not supported by Bedrock | skipping content block")
            return None

    def _format_guard_content(self, guard: GuardContent) -> dict[str, Any]:
        """Convert a guard content block to Bedrock format.

        Args:
            guard: Guard content to format.

        Returns:
            Bedrock formatted guard content.

        Raises:
            ValueError: If the guard content carries neither text nor image.
        """
        if "text" in guard:
            guard_text = guard["text"]
            text_block: dict[str, Any] = {"text": guard_text["text"]}
            if "qualifiers" in guard_text:
                text_block["qualifiers"] = guard_text["qualifiers"]
            return {"text": text_block}

        if "image" in guard:
            guard_image = guard["image"]
            return {"image": {"format": guard_image["format"], "source": {"bytes": guard_image["source"]["bytes"]}}}

        raise ValueError("content_type=<guardContent> | guard content must have either text or image")

    def _format_request_message_content(self, content: ContentBlock) -> dict[str, Any] | None:
        """Format a Bedrock content block.

        Bedrock strictly validates content blocks and throws exceptions for unknown fields.
        This function extracts only the fields that Bedrock supports for each content type.

        Args:
            content: Content block to format.

        Returns:
            Bedrock formatted content block.

        Raises:
            TypeError: If the content block type is not supported by Bedrock.
            ValueError: If a guard content block carries neither text nor image.
        """
        # https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_CachePointBlock.html
        if "cachePoint" in content:
            cache_point = content["cachePoint"]
            result: dict[str, Any] = {"type": cache_point["type"]}
            if cache_point.get("ttl"):
                result["ttl"] = cache_point["ttl"]
            return {"cachePoint": result}

        # https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_AudioBlock.html
        if "audio" in content:
            audio = content["audio"]
            source = audio["source"]
            formatted_audio_source: dict[str, Any] | None
            if "location" in source:
                formatted_audio_source = self._handle_location(source["location"])
                if formatted_audio_source is None:
                    return None
            elif "bytes" in source:
                formatted_audio_source = {"bytes": source["bytes"]}

            result = {"format": audio["format"], "source": formatted_audio_source}
            return {"audio": result}

        # https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_DocumentBlock.html
        if "document" in content:
            document = content["document"]
            result = {}

            # Handle required fields (all optional due to total=False)
            if "name" in document:
                result["name"] = document["name"]
            if "format" in document:
                result["format"] = document["format"]

            # Handle source - supports bytes or location
            if "source" in document:
                source = document["source"]
                formatted_document_source: dict[str, Any] | None
                if "location" in source:
                    formatted_document_source = self._handle_location(source["location"])
                    if formatted_document_source is None:
                        return None
                elif "bytes" in source:
                    formatted_document_source = {"bytes": source["bytes"]}
                result["source"] = formatted_document_source

            # Handle optional fields
            if "citations" in document and document["citations"] is not None:
                result["citations"] = {"enabled": document["citations"]["enabled"]}
            if "context" in document:
                result["context"] = document["context"]

            return {"document": result}

        # https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_GuardrailConverseContentBlock.html
        if "guardContent" in content:
            return {"guardContent": self._format_guard_content(content["guardContent"])}

        # https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ImageBlock.html
        if "image" in content:
            image = content["image"]
            source = image["source"]
            formatted_image_source: dict[str, Any] | None
            if "location" in source:
                formatted_image_source = self._handle_location(source["location"])
                if formatted_image_source is None:
                    return None
            elif "bytes" in source:
                formatted_image_source = {"bytes": source["bytes"]}
            result = {"format": image["format"], "source": formatted_image_source}
            return {"image": result}

        # https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ReasoningContentBlock.html
        if "reasoningContent" in content:
            reasoning = content["reasoningContent"]
            result = {}

            if "reasoningText" in reasoning:
                reasoning_text = reasoning["reasoningText"]
                result["reasoningText"] = {}
                if "text" in reasoning_text:
                    result["reasoningText"]["text"] = reasoning_text["text"]
                # Only include signature if truthy (avoid empty strings)
                if reasoning_text.get("signature"):
                    result["reasoningText"]["signature"] = reasoning_text["signature"]

            if "redactedContent" in reasoning:
                result["redactedContent"] = reasoning["redactedContent"]

            return {"reasoningContent": result}

        # Pass through text and other simple content types
        if "text" in content:
            return {"text": content["text"]}

        # https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolResultBlock.html
        if "toolResult" in content:
            tool_result = content["toolResult"]
            # Normalize empty toolResult content arrays.
            # Some model providers (e.g., Nemotron) reject toolResult blocks with
            # content: [] via the Converse API, while others (e.g., Claude) accept
            # them. Replace empty content with a minimal text block to ensure
            # cross-model compatibility. This follows the same pattern as the
            # TypeScript SDK's _formatMessages in bedrock.ts.
            tool_result_content_list = tool_result.get("content") or [{"text": ""}]
            formatted_content: list[dict[str, Any]] = []
            for tool_result_content in tool_result_content_list:
                if "json" in tool_result_content:
                    if self._should_convert_json_to_text():
                        formatted_content.append({"text": json.dumps(tool_result_content["json"])})
                    else:
                        # Handle json field since not in ContentBlock but valid in ToolResultContent
                        formatted_content.append({"json": tool_result_content["json"]})
                else:
                    formatted_message_content = self._format_request_message_content(
                        cast(ContentBlock, tool_result_content)
                    )
                    if formatted_message_content is None:
                        continue
                    formatted_content.append(formatted_message_content)

            result = {
                "content": formatted_content,
                "toolUseId": tool_result["toolUseId"],
            }
            if "status" in tool_result and self._should_include_tool_result_status():
                result["status"] = tool_result["status"]
            return {"toolResult": result}

        # https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolUseBlock.html
        if "toolUse" in content:
            tool_use = content["toolUse"]
            return {
                "toolUse": {
                    "input": tool_use["input"],
                    "name": tool_use["name"],
                    "toolUseId": tool_use["toolUseId"],
                }
            }

        # https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_VideoBlock.html
        if "video" in content:
            video = content["video"]
            source = video["source"]
            formatted_video_source: dict[str, Any] | None
            if "location" in source:
                formatted_video_source = self._handle_location(source["location"])
                if formatted_video_source is None:
                    return None
            elif "bytes" in source:
                formatted_video_source = {"bytes": source["bytes"]}
            video_format = _BEDROCK_VIDEO_FORMAT_ALIASES.get(video["format"], video["format"])
            result = {"format": video_format, "source": formatted_video_source}
            return {"video": result}

        # https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_CitationsContentBlock.html
        if "citationsContent" in content:
            citations = content["citationsContent"]
            result = {}

            if "citations" in citations:
                result["citations"] = []
                for citation in citations["citations"]:
                    filtered_citation: dict[str, Any] = {}
                    if "location" in citation:
                        filtered_citation["location"] = citation["location"]
                    if "sourceContent" in citation:
                        filtered_source_content: list[dict[str, Any]] = []
                        for source_content in citation["sourceContent"]:
                            if "text" in source_content:
                                filtered_source_content.append({"text": source_content["text"]})
                        if filtered_source_content:
                            filtered_citation["sourceContent"] = filtered_source_content
                    if "title" in citation:
                        filtered_citation["title"] = citation["title"]
                    result["citations"].append(filtered_citation)

            if "content" in citations:
                filtered_content: list[dict[str, Any]] = []
                for generated_content in citations["content"]:
                    if "text" in generated_content:
                        filtered_content.append({"text": generated_content["text"]})
                if filtered_content:
                    result["content"] = filtered_content

            return {"citationsContent": result}

        content_type = next(iter(content), None)
        raise TypeError(f"content_type=<{content_type}> | unsupported type")

    def _should_redact_guardrail_content(self, guardrail_data: dict[str, Any] | None, stop_reason: str | None) -> bool:
        """Check whether a guardrail blocked content and redaction should occur.

        Bedrock reports stop_reason=guardrail_intervened for both blocked and masked content, so the
        stop reason alone cannot distinguish the two. When Bedrock carries a trace we defer to it:
        redact only when a policy's action is BLOCKED. ANONYMIZED (masked) spans are already
        substituted in place server-side and the surrounding message must be preserved. When the
        trace is absent (typically guardrail_trace='disabled'), we fall back to the stop reason.

        Args:
            guardrail_data: Guardrail assessment from trace information, if any.
            stop_reason: The stop reason reported by Bedrock, if any.

        Returns:
            True if blocked content should be redacted, False otherwise.
        """
        if guardrail_data is not None:
            input_assessment = guardrail_data.get("inputAssessment", {})
            output_assessments = guardrail_data.get("outputAssessments", {})

            if any(self._find_detected_and_blocked_policy(assessment) for assessment in input_assessment.values()):
                return True
            if any(self._find_detected_and_blocked_policy(assessment) for assessment in output_assessments.values()):
                return True
            return False

        return stop_reason == "guardrail_intervened"

    def _generate_redaction_events(self) -> list[StreamEvent]:
        """Generate redaction events based on configuration.

        Returns:
            List of redaction events to yield.
        """
        events: list[StreamEvent] = []

        if self.config.get("guardrail_redact_input", True):
            logger.debug("Redacting user input due to guardrail.")
            events.append(
                {
                    "redactContent": {
                        "redactUserContentMessage": self.config.get(
                            "guardrail_redact_input_message", "[User input redacted.]"
                        )
                    }
                }
            )

        if self.config.get("guardrail_redact_output", False):
            logger.debug("Redacting assistant output due to guardrail.")
            events.append(
                {
                    "redactContent": {
                        "redactAssistantContentMessage": self.config.get(
                            "guardrail_redact_output_message",
                            "[Assistant output redacted.]",
                        )
                    }
                }
            )

        return events

    @override
    async def count_tokens(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None,
    ) -> int:
        """Count tokens using Bedrock's native CountTokens API.

        Uses the same message format as the Converse API to get accurate token counts
        directly from the Bedrock service.

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

        model_id: str = self.config["model_id"]

        if model_id in _SKIP_COUNT_TOKENS_MODELS:
            return await super().count_tokens(messages, tool_specs, system_prompt, system_prompt_content)

        try:
            if system_prompt and system_prompt_content is None:
                system_prompt_content = [{"text": system_prompt}]

            request = self.format_request(messages, tool_specs, system_prompt_content)
            converse_input: dict[str, Any] = {}
            if "messages" in request:
                converse_input["messages"] = request["messages"]
            if "system" in request:
                converse_input["system"] = request["system"]
            if "toolConfig" in request:
                converse_input["toolConfig"] = request["toolConfig"]

            response = await asyncio.to_thread(
                self.client.count_tokens,
                modelId=self.config["model_id"],
                input={"converse": converse_input},
            )
            input_tokens = response.get("inputTokens")
            if input_tokens is None:
                raise ProviderTokenCountError("Bedrock count_tokens returned None for inputTokens")
            total_tokens: int = input_tokens

            logger.debug("model_id=<%s>, total_tokens=<%d> | native token count", self.config["model_id"], total_tokens)
            return total_tokens
        except Exception as e:
            if isinstance(e, ClientError) and e.response.get("Error", {}).get("Code") == "AccessDeniedException":
                logger.warning(
                    "model_id=<%s> | bedrock:CountTokens permission denied, falling back to heuristic estimation: %s",
                    model_id,
                    e,
                )
                _SKIP_COUNT_TOKENS_MODELS.add(model_id)
            elif (
                isinstance(e, ClientError)
                and e.response.get("Error", {}).get("Code") == "ValidationException"
                and "doesn't support counting tokens" in str(e)
            ):
                logger.debug(
                    "model_id=<%s> | model does not support CountTokens, caching for future calls,"
                    " falling back to estimation",
                    model_id,
                )
                _SKIP_COUNT_TOKENS_MODELS.add(model_id)
            else:
                logger.debug(
                    "model_id=<%s>, error=<%s> | native token counting failed, falling back to estimation",
                    model_id,
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
        cancel_signal: threading.Event | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Stream conversation with the Bedrock model.

        This method calls either the Bedrock converse_stream API or the converse API
        based on the streaming parameter in the configuration.

        Args:
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            system_prompt: System prompt to provide context to the model.
            tool_choice: Selection strategy for tool invocation.
            system_prompt_content: System prompt content blocks to provide context to the model.
            cancel_signal: Event that aborts an in-flight streaming request. The caller stops
                receiving events as soon as it is set, and the HTTP response is closed at the next
                chunk boundary. A non-streaming request (``streaming=False``) is not abortable.
            **kwargs: Additional keyword arguments for future extensibility.

        Yields:
            Model events.

        Raises:
            ContextWindowOverflowException: If the input exceeds the model's context window.
            ModelThrottledException: If the model service is throttling requests.
        """

        def callback(event: StreamEvent | None = None) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, event)
            if event is None:
                return

        loop = asyncio.get_event_loop()
        queue: asyncio.Queue[StreamEvent | None] = asyncio.Queue()

        # Handle backward compatibility: if system_prompt is provided but system_prompt_content is None
        if system_prompt and system_prompt_content is None:
            system_prompt_content = [{"text": system_prompt}]

        thread = asyncio.to_thread(
            self._stream,
            callback,
            messages,
            tool_specs,
            system_prompt_content,
            tool_choice,
            kwargs.get("dynamic_trailing_blocks", 0),
            cancel_signal,
        )
        task = asyncio.create_task(thread)
        cancel_poll = asyncio.ensure_future(_poll_cancel_signal(cancel_signal)) if cancel_signal else None

        try:
            while True:
                event = await _next_stream_event(queue, cancel_poll)
                if event is None:
                    break

                yield event

            if cancel_poll is not None and cancel_poll.done():
                # The worker thread owns the event stream and closes it at its next chunk boundary.
                # Detaching it rather than awaiting keeps a stalled read from delaying the caller.
                task.add_done_callback(_suppress_task_exception)
                return

            await task
        except BaseException:
            task.add_done_callback(_suppress_task_exception)
            raise
        finally:
            if cancel_poll is not None:
                cancel_poll.cancel()

    def _stream(
        self,
        callback: Callable[..., None],
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None,
        tool_choice: ToolChoice | None = None,
        dynamic_trailing_blocks: int = 0,
        cancel_signal: threading.Event | None = None,
    ) -> None:
        """Stream conversation with the Bedrock model.

        This method operates in a separate thread to avoid blocking the async event loop with the call to
        Bedrock's converse_stream.

        Args:
            callback: Function to send events to the main thread.
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            system_prompt_content: System prompt content blocks to provide context to the model.
            tool_choice: Selection strategy for tool invocation.
            dynamic_trailing_blocks: How many trailing blocks of the last user message are rebuilt on every
                call, so the cache point goes ahead of them.
            cancel_signal: Event that stops the transfer at the next chunk boundary.

        Raises:
            ContextWindowOverflowException: If the input exceeds the model's context window.
            ModelThrottledException: If the model service is throttling requests.
        """
        try:
            logger.debug("formatting request")
            request = self.format_request(
                messages, tool_specs, system_prompt_content, tool_choice, dynamic_trailing_blocks
            )
            model_id = request["modelId"]
            logger.debug("request=<%s>", request)

            logger.debug("invoking model")
            streaming = self.config.get("streaming", True)
            converse_method = self.client.converse_stream if streaming else self.client.converse

            try:
                response = converse_method(**request)
            except ClientError as error:
                error_details = error.response.get("Error", {})
                if error_details.get(
                    "Code"
                ) != "ValidationException" or _TOOL_RESULT_TURN_VALIDATION_MESSAGE not in error_details.get(
                    "Message", ""
                ):
                    raise

                separated_messages = self._separate_tool_result_turns(request["messages"])
                if separated_messages == request["messages"]:
                    raise

                logger.debug("model_id=<%s> | separating tool result and conversation turns", model_id)
                request = {**request, "messages": separated_messages}
                response = converse_method(**request)
                self._tool_result_turn_separation_model_id = model_id

            logger.debug("got response from model")
            if streaming:
                redaction_emitted = False
                saw_guardrail_trace = False
                last_stop_reason: str | None = None
                for chunk in response["stream"]:
                    if cancel_signal is not None and cancel_signal.is_set():
                        # Closing from this thread only: botocore's teardown is not safe against a
                        # read in flight, and this thread is the one reading.
                        response["stream"].close()
                        break

                    if "messageStop" in chunk:
                        last_stop_reason = chunk["messageStop"].get("stopReason")

                    # Wait for a metadata chunk before deciding: the guardrail trace arrives there
                    # and is authoritative for BLOCKED vs ANONYMIZED (masking).
                    if not redaction_emitted and "metadata" in chunk:
                        guardrail_data = chunk["metadata"].get("trace", {}).get("guardrail")
                        if guardrail_data is not None:
                            saw_guardrail_trace = True
                        if self._should_redact_guardrail_content(guardrail_data, last_stop_reason):
                            for event in self._generate_redaction_events():
                                callback(event)
                            redaction_emitted = True

                    callback(chunk)

                # Safety net: guardrail_intervened but no metadata chunk arrived.
                if not redaction_emitted and not saw_guardrail_trace and last_stop_reason == "guardrail_intervened":
                    for event in self._generate_redaction_events():
                        callback(event)

            else:
                for event in self.convert_non_streaming_to_streaming(response):
                    callback(event)

                guardrail_data = response.get("trace", {}).get("guardrail")
                if self._should_redact_guardrail_content(guardrail_data, response.get("stopReason")):
                    for event in self._generate_redaction_events():
                        callback(event)

        except ClientError as e:
            error_message = str(e)

            if (
                e.response["Error"]["Code"] == "ThrottlingException"
                or e.response["Error"]["Code"] == "throttlingException"
            ):
                raise ModelThrottledException(error_message) from e

            if any(overflow_message in error_message for overflow_message in BEDROCK_CONTEXT_WINDOW_OVERFLOW_MESSAGES):
                logger.warning("bedrock threw context window overflow error")
                raise ContextWindowOverflowException(e) from e

            region = self.client.meta.region_name

            # Aid in debugging by adding more information
            add_exception_note(e, f"└ Bedrock region: {region}")
            add_exception_note(e, f"└ Model id: {self.config.get('model_id')}")

            if (
                e.response["Error"]["Code"] == "AccessDeniedException"
                and "You don't have access to the model" in error_message
            ):
                add_exception_note(
                    e,
                    "└ For more information see "
                    "https://strandsagents.com/docs/user-guide/concepts/model-providers/amazon-bedrock/#required-iam-permissions",
                )

            if (
                e.response["Error"]["Code"] == "ValidationException"
                and "The provided model identifier is invalid" in error_message
            ):
                add_exception_note(
                    e,
                    "└ For more information see "
                    "https://strandsagents.com/docs/user-guide/concepts/model-providers/amazon-bedrock/#model-identifier-is-invalid",
                )

            if (
                e.response["Error"]["Code"] == "ValidationException"
                and "with on-demand throughput isn’t supported" in error_message
            ):
                add_exception_note(
                    e,
                    "└ For more information see "
                    "https://strandsagents.com/docs/user-guide/concepts/model-providers/amazon-bedrock/#on-demand-throughput-isnt-supported",
                )

            raise e

        finally:
            callback()
            logger.debug("finished streaming response from model")

    def convert_non_streaming_to_streaming(self, response: dict[str, Any], **kwargs: Any) -> Iterable[StreamEvent]:
        """Convert a non-streaming response to the streaming format.

        Args:
            response: The non-streaming response from the Bedrock model.
            **kwargs: Additional keyword arguments for future extensibility.

        Returns:
            An iterable of response events in the streaming format.
        """
        # Yield messageStart event
        yield {"messageStart": {"role": response["output"]["message"]["role"]}}

        # Process content blocks
        for content in cast(list[ContentBlock], response["output"]["message"]["content"]):
            # Yield contentBlockStart event if needed
            if "toolUse" in content:
                yield {
                    "contentBlockStart": {
                        "start": {
                            "toolUse": {
                                "toolUseId": content["toolUse"]["toolUseId"],
                                "name": content["toolUse"]["name"],
                            }
                        },
                    }
                }

                # For tool use, we need to yield the input as a delta
                input_value = json.dumps(content["toolUse"]["input"])

                yield {"contentBlockDelta": {"delta": {"toolUse": {"input": input_value}}}}
            elif "text" in content:
                # Then yield the text as a delta
                yield {
                    "contentBlockDelta": {
                        "delta": {"text": content["text"]},
                    }
                }
            elif "reasoningContent" in content:
                reasoning = content["reasoningContent"]
                if "reasoningText" in reasoning:
                    reasoning_text = reasoning["reasoningText"]
                    if "text" in reasoning_text:
                        yield {
                            "contentBlockDelta": {
                                "delta": {"reasoningContent": {"text": reasoning_text["text"]}}
                            }
                        }
                    if reasoning_text.get("signature"):
                        yield {
                            "contentBlockDelta": {
                                "delta": {
                                    "reasoningContent": {
                                        "signature": reasoning_text["signature"]
                                    }
                                }
                            }
                        }
                if "redactedContent" in reasoning:
                    yield {
                        "contentBlockDelta": {
                            "delta": {"reasoningContent": {"redactedContent": reasoning["redactedContent"]}}
                        }
                    }
            elif "citationsContent" in content:
                # For non-streaming citations, emit text and metadata deltas in sequence
                # to match streaming behavior where they flow naturally
                if "content" in content["citationsContent"]:
                    text_content = "".join([content["text"] for content in content["citationsContent"]["content"]])
                    yield {
                        "contentBlockDelta": {"delta": {"text": text_content}},
                    }

                for citation in content["citationsContent"]["citations"]:
                    # Emit citation metadata, only including fields that are present
                    # Nova grounding may omit title/sourceContent
                    citation_metadata: CitationsDelta = {}
                    if "title" in citation:
                        citation_metadata["title"] = citation["title"]
                    if "location" in citation:
                        citation_metadata["location"] = citation["location"]
                    if "sourceContent" in citation:
                        citation_metadata["sourceContent"] = citation["sourceContent"]
                    yield {"contentBlockDelta": {"delta": {"citation": citation_metadata}}}

            # Yield contentBlockStop event
            yield {"contentBlockStop": {}}

        # Yield messageStop event
        yield {
            "messageStop": {
                "stopReason": response["stopReason"],
                "additionalModelResponseFields": response.get("additionalModelResponseFields"),
            }
        }

        # Yield metadata event
        if "usage" in response or "metrics" in response or "trace" in response:
            metadata: StreamEvent = {"metadata": {}}
            if "usage" in response:
                metadata["metadata"]["usage"] = response["usage"]
            if "metrics" in response:
                metadata["metadata"]["metrics"] = response["metrics"]
            if "trace" in response:
                metadata["metadata"]["trace"] = response["trace"]
            yield metadata

    def _find_detected_and_blocked_policy(self, input: Any) -> bool:
        """Recursively checks if the assessment contains a detected and blocked guardrail.

        Args:
            input: The assessment to check.

        Returns:
            True if the input contains a detected and blocked guardrail, False otherwise.

        """
        # Check if input is a dictionary
        if isinstance(input, dict):
            # Check if current dictionary has action: BLOCKED and detected: true
            if input.get("action") == "BLOCKED" and input.get("detected") and isinstance(input.get("detected"), bool):
                return True

            # Otherwise, recursively check all values in the dictionary
            return self._find_detected_and_blocked_policy(input.values())

        elif isinstance(input, (list, ValuesView)):
            # Handle case where input is a list or dict_values
            return any(self._find_detected_and_blocked_policy(item) for item in input)
        # Otherwise return False
        return False

    @override
    async def structured_output(
        self,
        output_model: type[T],
        prompt: Messages,
        system_prompt: str | None = None,
        **kwargs: Any,
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
        async for event in streaming.process_stream(response):
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
            raise ValueError("No valid tool use or tool use input was found in the Bedrock response.")

        yield {"output": output_model(**output_response)}

    @staticmethod
    def _get_default_model_with_warning(region_name: str, model_config: BedrockConfig | None = None) -> str:
        """Get the default Bedrock modelId based on region.

        If the region is not **known** to support inference then we show a helpful warning
        that compliments the exception that Bedrock will throw.
        If the customer provided a model_id in their config or they overrode the `DEFAULT_BEDROCK_MODEL_ID`
        then we should not process further.

        Args:
            region_name (str): region for bedrock model
            model_config (Optional[dict[str, Any]]): Model Config that caller passes in on init
        """
        model_config = model_config or {}
        if model_config.get("model_id"):
            return model_config["model_id"]

        if DEFAULT_BEDROCK_MODEL_ID != _DEFAULT_BEDROCK_MODEL_ID.format("us"):
            return DEFAULT_BEDROCK_MODEL_ID

        prefix_inference_map = {"ap": "apac"}  # some inference endpoints can be a bit different than the region prefix

        prefix = "-".join(region_name.split("-")[:-2]).lower()  # handles `us-east-1` or `us-gov-east-1`
        if prefix not in {"us", "eu", "ap", "us-gov"}:
            warnings.warn(
                f"""
            ================== WARNING ==================

                This region {region_name} does not support
                our default inference endpoint: {_DEFAULT_BEDROCK_MODEL_ID.format(prefix)}.
                Update the agent to pass in a 'model_id' like so:
                ```
                Agent(..., model='valid_model_id', ...)
                ````
                Documentation: https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html

            ==================================================
            """,
                stacklevel=2,
            )

        default_model_id = _DEFAULT_BEDROCK_MODEL_ID.format(prefix_inference_map.get(prefix, prefix))
        warnings.warn(
            f"You're using default model '{default_model_id}', which is subject to change. "
            "Specify a model explicitly to pin the model target.",
            stacklevel=2,
        )
        return default_model_id

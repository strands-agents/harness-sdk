"""Abstract base class for Agent model providers."""

import abc
import json
import logging
import math
import threading
from collections.abc import AsyncGenerator, AsyncIterable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, TypedDict, TypeVar

from pydantic import BaseModel

from ..hooks.events import AfterInvocationEvent
from ..plugins.plugin import Plugin
from ..types.content import ContentBlock, Messages, SystemContentBlock
from ..types.streaming import StreamEvent
from ..types.tools import ToolChoice, ToolSpec
from ._defaults import DEFAULT_CONTEXT_WINDOW_LIMIT

if TYPE_CHECKING:
    from ..agent.agent import Agent

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


def _heuristic_estimate_text(text: str) -> int:
    """Estimate token count from text using characters / 4 heuristic."""
    return math.ceil(len(text) / 4)


def _heuristic_estimate_json(obj: Any) -> int:
    """Estimate token count from a JSON-serializable object using characters / 2 heuristic."""
    try:
        return math.ceil(len(json.dumps(obj)) / 2)
    except (TypeError, ValueError):
        return 0


def _count_content_block_tokens(
    block: ContentBlock, count_text: Callable[[str], int], count_json: Callable[[Any], int]
) -> int:
    """Count tokens for a single content block.

    Args:
        block: The content block to count tokens for.
        count_text: Function that returns token count for a text string.
        count_json: Function that returns token count for a JSON-serializable object.
    """
    total = 0

    if "text" in block:
        total += count_text(block["text"])

    if "toolUse" in block:
        tool_use = block["toolUse"]
        total += count_text(tool_use.get("name", ""))
        total += count_json(tool_use.get("input", {}))

    if "toolResult" in block:
        tool_result = block["toolResult"]
        # image/document items are binary and intentionally not counted by the heuristic
        for item in tool_result.get("content", []):
            if "text" in item:
                total += count_text(item["text"])
            if "json" in item:
                total += count_json(item["json"])

    if "reasoningContent" in block:
        reasoning = block["reasoningContent"]
        if "reasoningText" in reasoning:
            reasoning_text = reasoning["reasoningText"]
            if "text" in reasoning_text:
                total += count_text(reasoning_text["text"])

    if "guardContent" in block:
        guard = block["guardContent"]
        if "text" in guard and "text" in guard["text"]:
            total += count_text(guard["text"]["text"])

    if "citationsContent" in block:
        citations = block["citationsContent"]
        if "content" in citations:
            for citation_item in citations["content"]:
                if "text" in citation_item:
                    total += count_text(citation_item["text"])

    return total


def _estimate_tokens_with_heuristic(
    messages: Messages,
    tool_specs: list[ToolSpec] | None = None,
    system_prompt: str | None = None,
    system_prompt_content: list[SystemContentBlock] | None = None,
) -> int:
    """Estimate tokens using character-based heuristics (text: chars/4, JSON: chars/2).

    Dependency-free fallback when tiktoken is not installed.
    """
    total = 0

    if system_prompt_content:
        for block in system_prompt_content:
            if "text" in block:
                total += _heuristic_estimate_text(block["text"])
    elif system_prompt:
        total += _heuristic_estimate_text(system_prompt)

    for message in messages:
        for block in message["content"]:
            total += _count_content_block_tokens(block, _heuristic_estimate_text, _heuristic_estimate_json)

    if tool_specs:
        for spec in tool_specs:
            total += _heuristic_estimate_json(spec)

    return total


class BaseModelConfig(TypedDict, total=False):
    """Base configuration shared by all model providers.

    Attributes:
        context_window_limit: Maximum context window size in tokens for the model.
            This value represents the total token capacity shared between input and output.
    """

    context_window_limit: int | None


@dataclass
class CacheConfig:
    """Configuration for prompt caching.

    Providers consume only the fields they support.

    Attributes:
        strategy: Caching strategy to use.
            - "auto": Automatically detect model support and inject cachePoint to maximize cache coverage
            - "anthropic": Inject cachePoint in Anthropic-compatible format without model support check
        ttl: Optional TTL duration for cache entries (e.g. "5m", "1h").
            When specified, auto-injected cache points will include this TTL value. Bedrock requires
            checkpoint TTLs to be non-increasing across toolConfig, system and messages, and rejects a
            longer TTL that follows a shorter one. This TTL also fills in for a cache point that carries
            none of its own.
        system_prompt_ttl: Cache the system prompt, auto-injecting a cache point at its end so repeated calls with
            the same static system prefix hit the cache. A TTL string (e.g. "1h") sets this section's own
            duration and is honored as written; True derives the duration from ``ttl``; False disables it.
            A hand-placed system cache point is honored rather than doubled.
        cache_key: Stable identity a provider can use to route its cache. Defaults to None.
        tools_ttl: Cache the tool definitions, auto-injecting a cache point on the tool block so repeated calls
            with the same tools hit the cache. A TTL string (e.g. "1h") sets this section's own
            duration and is honored as written; True derives the duration from ``ttl``; False disables it.
            None (the default) leaves it unset, deferring to the deprecated model-level ``cache_tools``;
            any explicit value — including False — takes precedence over ``cache_tools``.
    """

    strategy: Literal["auto", "anthropic"] = "auto"
    ttl: str | None = None
    system_prompt_ttl: bool | str = True
    cache_key: str | None = None
    tools_ttl: bool | str | None = None


@dataclass
class CacheToolsConfig:
    """Configuration for the toolConfig cache point.

    Attributes:
        type: Cache point type (e.g. "default").
        ttl: Optional TTL duration for the cache entry (e.g. "5m", "1h").
    """

    type: str = "default"
    ttl: str | None = None


class Model(abc.ABC):
    """Abstract base class for Agent model providers.

    This class defines the interface for all model implementations in the Strands Agents SDK. It provides a
    standardized way to configure and process requests for different AI model providers.
    """

    @property
    def stateful(self) -> bool:
        """Whether the model manages conversation state server-side.

        Returns:
            False by default. Model providers that support server-side state should override this.
        """
        return False

    @property
    def context_window_limit(self) -> int | None:
        """Maximum context window size in tokens, or None if not configured."""
        config = self.get_config()
        return (
            config.get("context_window_limit")
            if isinstance(config, dict)
            else getattr(config, "context_window_limit", None)
        )

    @abc.abstractmethod
    # pragma: no cover
    def update_config(self, **model_config: Any) -> None:
        """Update the model configuration with the provided arguments.

        Args:
            **model_config: Configuration overrides.
        """
        pass

    @abc.abstractmethod
    # pragma: no cover
    def get_config(self) -> Any:
        """Return the model configuration.

        Returns:
            The model's configuration.
        """
        pass

    @abc.abstractmethod
    # pragma: no cover
    def structured_output(
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
            ValidationException: The response format from the model does not match the output_model
        """
        pass

    @abc.abstractmethod
    # pragma: no cover
    def stream(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        *,
        tool_choice: ToolChoice | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None,
        invocation_state: dict[str, Any] | None = None,
        cancel_signal: threading.Event | None = None,
        **kwargs: Any,
    ) -> AsyncIterable[StreamEvent]:
        """Stream conversation with the model.

        This method handles the full lifecycle of conversing with the model:

        1. Format the messages, tool specs, and configuration into a streaming request
        2. Send the request to the model
        3. Yield the formatted message chunks

        Args:
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            system_prompt: System prompt to provide context to the model.
            tool_choice: Selection strategy for tool invocation.
            system_prompt_content: System prompt content blocks for advanced features like caching.
            invocation_state: Caller-provided state/context that was passed to the agent when it was invoked.
            cancel_signal: Event a provider can observe to abort an in-flight request. Support is
                provider-dependent; a provider that ignores it still cancels at the SDK's
                between-chunk checkpoint.
            **kwargs: Additional keyword arguments for future extensibility.

        Yields:
            Formatted message chunks from the model.

        Raises:
            ModelThrottledException: When the model service is throttling requests from the client.
        """
        pass

    async def count_tokens(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None,
    ) -> int:
        """Estimate token count for the given input before sending to the model.

        Used for proactive context management (e.g., triggering compression at a threshold).
        Uses tiktoken's cl100k_base encoding when available, otherwise falls back to a
        heuristic (characters / 4 for text, characters / 2 for JSON). Accuracy varies by
        model provider. Not intended for billing or precise quota calculations.

        Subclasses may override this method to provide model-specific token counting
        using native APIs for improved accuracy.

        Args:
            messages: List of message objects to estimate tokens for.
            tool_specs: List of tool specifications to include in the estimate.
            system_prompt: Plain string system prompt. Ignored if system_prompt_content is provided.
            system_prompt_content: Structured system prompt content blocks. Takes priority over system_prompt.

        Returns:
            Estimated total input tokens.
        """
        return _estimate_tokens_with_heuristic(messages, tool_specs, system_prompt, system_prompt_content)

    def estimate_utilization(self, input_tokens: int) -> float:
        """Estimate the fraction of the model's context window consumed by the given input token count.

        Resolves the model's context window limit (falling back to :data:`DEFAULT_CONTEXT_WINDOW_LIMIT`
        with a warning when not configured) and returns ``input_tokens / context_window_limit``.

        Args:
            input_tokens: Total input token count (e.g. from a model event's projected input tokens).

        Returns:
            Token usage ratio (0–1+; above 1.0 means overflow).
        """
        context_window_limit = self.context_window_limit
        if not context_window_limit:
            context_window_limit = DEFAULT_CONTEXT_WINDOW_LIMIT
            if not getattr(self, "_utilization_limit_warned", False):
                self._utilization_limit_warned = True
                logger.warning(
                    "context_window_limit=<%s> | context_window_limit not set on model, using default"
                    " for utilization estimate | set context_window_limit in your model config for accurate results",
                    DEFAULT_CONTEXT_WINDOW_LIMIT,
                )

        return input_tokens / context_window_limit


def _config_model_id(config: Any) -> str | None:
    """Read ``model_id`` off a model config, which may be a dict or an object with attributes."""
    model_id = config.get("model_id") if isinstance(config, dict) else getattr(config, "model_id", None)
    return model_id if isinstance(model_id, str) else None


def _get_model_id(model: Model) -> str | None:
    """Return the model id a provider reports, or None when it reports none.

    ``get_config()`` is the accessor the :class:`Model` interface declares, so it is read first. The
    public ``config`` attribute is a convention of the built-in providers rather than part of the
    interface, so it only serves as a fallback.

    Args:
        model: The model to read the id from.

    Returns:
        The configured model id, or None when neither accessor reports one.
    """
    try:
        declared = _config_model_id(model.get_config())
    except Exception:
        # The id only labels a span, so a provider that raises from get_config (or a router that
        # forwards such a provider's error) must not fail the call being traced.
        declared = None

    return declared or _config_model_id(getattr(model, "config", None))


class _ModelPlugin(Plugin):
    """Plugin that manages model-related lifecycle hooks."""

    @property
    def name(self) -> str:
        """A stable string identifier for this plugin."""
        return "strands:model"

    @staticmethod
    def _on_after_invocation(event: AfterInvocationEvent) -> None:
        """Handle post-invocation model management tasks.

        Performs the following:
        - Clears messages when the model is managing conversation state server-side.
        """
        if event.agent.model.stateful:
            event.agent.messages.clear()
            logger.debug(
                "response_id=<%s> | cleared messages for server-managed conversation",
                event.agent._model_state.get("response_id"),
            )

    def init_agent(self, agent: "Agent") -> None:
        """Register model lifecycle hooks with the agent.

        Args:
            agent: The agent instance to register hooks with.
        """
        agent.add_hook(self._on_after_invocation, AfterInvocationEvent)

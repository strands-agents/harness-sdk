"""Abstract base class for Agent model providers."""

import abc
import json
import logging
import math
import threading
import warnings
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
from ._model_info import ModelInfo, ModelLimits, lookup_model_info

if TYPE_CHECKING:
    from ..agent.agent import Agent
    from ..agent.agent_metadata import AgentMetadata

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
            The same fact as ``model_info.limits.context_window``; setting it here is shorthand for
            setting it through ``model_info``, and it wins over the shared model info. When both are
            set, ``model_info`` wins. When not provided, vended providers still populate it from the
            shared model info for callers that read ``get_config()``; ``model_info`` is the resolved
            view to read.
        model_info: Overrides for what the SDK knows about the model. Fields set here win over the
            shared model info and the provider; ``capabilities.stateful`` changes how the agent loop
            sends history, so set it only for a provider that keeps state server-side.
            ``update_config(model_info=...)`` replaces the previous override entirely, it does not
            merge into it.
    """

    context_window_limit: int | None
    model_info: ModelInfo | None


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
        cache_key: Stable identity a prompt-cache-routing provider (OpenAI, LiteLLM, Mistral) uses as its
            cache key. Left unset, it is derived per request as ``strands-<session_id>`` if the agent has
            a session manager, so repeat runs of a session share a cache prefix with no key management.
            Set it to a string to pin your own key, or ``False`` to opt out of routing entirely. The
            resolved key (whether set or derived from the session id) is transmitted to the provider.
        tools_ttl: Cache the tool definitions, auto-injecting a cache point on the tool block so repeated calls
            with the same tools hit the cache. A TTL string (e.g. "1h") sets this section's own
            duration and is honored as written; True derives the duration from ``ttl``; False disables it.
            None (the default) leaves it unset, deferring to the deprecated model-level ``cache_tools``;
            any explicit value — including False — takes precedence over ``cache_tools``.
    """

    strategy: Literal["auto", "anthropic"] = "auto"
    ttl: str | None = None
    system_prompt_ttl: bool | str = True
    cache_key: str | Literal[False] | None = None
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

    # A provider that sets this enforces structured output itself: on the structured output retry it receives
    # structured_output_model and the full tool list, instead of only the forced tool.
    _supports_structured_output: bool = False

    @property
    def stateful(self) -> bool:
        """Whether the model manages conversation state server-side.

        Reads ``model_info.capabilities.stateful``, so a provider that keeps state server-side sets
        it there (see :attr:`model_info`) and a ``model_info`` config override can change it.

        Returns:
            False when unknown.
        """
        return bool(self.model_info.capabilities.stateful)

    @property
    def model_info(self) -> ModelInfo:
        """Everything the SDK knows about the configured model, resolved on each read.

        Layers, later ones winning: the shared model info for the configured model id, the
        ``context_window_limit`` config value, and the ``model_info`` config override. Each read
        returns a new record, so do not compare reads by identity.

        A provider that knows better than the shared model info overrides this property: put its
        facts over ``super().model_info``, then the user's ``self.get_config().get("model_info")``
        over those so the override still wins::

            from strands.models import ModelCapabilities, ModelInfo

            ModelInfo.merge(
                super().model_info,
                ModelInfo(capabilities=ModelCapabilities(prompt_caching="auto")),
                self.get_config().get("model_info"),
            )

        Do not read :attr:`stateful` inside the override; it reads this property.

        Returns:
            What the SDK knows about the model; empty when it knows nothing.
        """
        config = self.get_config()
        if isinstance(config, dict):
            model_id = config.get("model_id")
            context_window_limit = config.get("context_window_limit")
            override = config.get("model_info")
        else:
            model_id = getattr(config, "model_id", None)
            context_window_limit = getattr(config, "context_window_limit", None)
            override = getattr(config, "model_info", None)

        return ModelInfo.merge(
            lookup_model_info(model_id),
            ModelInfo(limits=ModelLimits(context_window=context_window_limit)),
            override,
        )

    @property
    def context_window_limit(self) -> int | None:
        """Maximum context window size in tokens, or None if not known."""
        return self.model_info.limits.context_window

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
        agent_metadata: "AgentMetadata | None" = None,
        structured_output_model: type[BaseModel] | None = None,
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
            agent_metadata: Stable identity of the invoking agent (e.g. its session id), supplied per
                request. A provider may consult it to derive a prompt-cache routing key; None when the
                model is streamed directly without an agent.
            structured_output_model: Output model this call must produce, passed by the agent on its structured
                output retry to providers that enforce structured output themselves. The response must then be
                either a call to the tool named in ``tool_choice`` or a final text response whose text is exactly one
                JSON object that validates against this model.
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
            # Caller depth varies, so stacklevel=1 pins dedup to this line (once per process).
            warnings.warn(
                f"context_window_limit is not set on the model, using default of"
                f" {DEFAULT_CONTEXT_WINDOW_LIMIT} for the utilization estimate; set context_window_limit"
                " in your model config for accurate results",
                stacklevel=1,
            )

        return input_tokens / context_window_limit


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

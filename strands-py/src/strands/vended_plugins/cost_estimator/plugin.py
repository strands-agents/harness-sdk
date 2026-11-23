"""Estimate what a request cost in USD from its token usage per model and the list prices in genai-prices.

The estimate is tokens times list price. It is not a bill: it knows nothing about regions, service tiers,
batch or provisioned pricing, negotiated discounts, or long-context price tiers.
"""

from __future__ import annotations

import contextlib
import logging
import math
import sys
from collections.abc import AsyncGenerator, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

try:
    from genai_prices import Usage as _PricedUsage
    from genai_prices import calc_price
    from genai_prices.types import TieredPrices
except ImportError as error:
    if sys.version_info < (3, 11):
        reason = "requires Python 3.11 or later; InvocationContext.usage_by_model works without it"
    elif isinstance(error, ModuleNotFoundError) and error.name == "genai_prices":
        reason = "requires the genai-prices package. Install with: pip install 'strands-agents[cost-estimator]'"
    else:
        reason = "supports genai-prices>=0.2.4,<0.3; the installed version is not compatible"
    raise ImportError(f"strands.vended_plugins.cost_estimator {reason}") from error

from ...agent.invocation_context import InvocationContext, ModelUsage
from ...middleware import InvokeModelStage, ModelStopReason, TypedEvent
from ...models._provider_name import _model_key
from ...plugins import Plugin
from ...types.event_loop import Usage

if TYPE_CHECKING:
    from ...agent.agent import Agent
    from ...agent.agent_result import AgentResult
    from ...middleware import InvokeModelContext, MiddlewareNext
    from ...multiagent.base import MultiAgentResult

logger = logging.getLogger(__name__)

# Strands provider name -> genai-prices provider id. A provider that is not listed has no prices there.
_PROVIDER_IDS = {
    "anthropic": "anthropic",
    "bedrock": "aws",
    "google": "google",
    "mistral": "mistral",
    "openai": "openai",
}
_GENAI_RATE_FIELDS = ("input_mtok", "output_mtok", "cache_read_mtok", "cache_write_mtok")


@dataclass(frozen=True, kw_only=True)
class ModelPrice:
    """List price of a model in USD per one million tokens.

    Attributes:
        model_id: The model the price is for, compared as a whole string.
        input_per_million: Price of uncached input tokens.
        output_per_million: Price of output tokens.
        cache_read_per_million: Price of input tokens read from cache; ``None`` uses the input price.
        cache_write_per_million: Price of input tokens written to cache; ``None`` uses the input price.
        provider_name: The provider the price is for, compared as a whole string with the ``provider_name`` of
            the usage; ``None`` matches the model id on any provider.

    Raises:
        ValueError: If ``model_id`` is not a non-empty string, or a price is not a finite, non-negative number.
    """

    model_id: str
    input_per_million: float
    output_per_million: float
    cache_read_per_million: float | None = None
    cache_write_per_million: float | None = None
    provider_name: str | None = None

    def __post_init__(self) -> None:
        """Reject an empty model id and prices that are not finite, non-negative numbers."""
        if not isinstance(self.model_id, str) or not self.model_id:
            raise ValueError(f"model_id=<{self.model_id!r}> | a price needs the id of the model it is for")
        for name in ("input_per_million", "output_per_million", "cache_read_per_million", "cache_write_per_million"):
            value = getattr(self, name)
            if value is None and name.startswith("cache_"):
                continue
            is_number = isinstance(value, (int, float)) and not isinstance(value, bool)
            if not (is_number and 0 <= value <= sys.float_info.max):
                raise ValueError(f"{name}=<{value!r}> | a price must be a finite, non-negative number")


@dataclass(frozen=True, kw_only=True)
class ModelCostEstimate:
    """Estimated cost of one model's share of a request, or of one model call.

    Attributes:
        provider_name: Name of the model's provider; ``None`` when not known.
        model_id: The model id; ``None`` when not known.
        usage: The token usage the estimate is for.
        cost_usd: The estimate in USD; ``None`` when no price was found.
        price: The price used; ``None`` when no price was found.
        price_source: ``"user"`` for a price you passed, or the genai-prices entry the price came from, such as
            ``"genai-prices:aws/amazon.nova-lite-v1:0"``; ``None`` when no price was found.
    """

    provider_name: str | None
    model_id: str | None
    usage: Usage = field(hash=False)
    cost_usd: float | None
    price: ModelPrice | None
    price_source: str | None


@dataclass(frozen=True, kw_only=True)
class CostEstimate:
    """Estimated cost of a request so far.

    Attributes:
        total_usd: The estimate in USD; ``None`` when any model in the request has no price.
        models: The estimate for each model the request used.
    """

    total_usd: float | None
    models: tuple[ModelCostEstimate, ...]

    @property
    def unpriced(self) -> tuple[ModelCostEstimate, ...]:
        """The models no price was found for."""
        return tuple(model for model in self.models if model.cost_usd is None)


class CostEstimateEvent(TypedEvent):
    """Stream event emitted after each model call, carrying its estimated cost and the request's so far.

    ``model_call`` names the model the plugin saw. Wrap middleware added after the plugin that swaps the
    model, or answers without calling one, is not reflected in it; the request's estimate is.
    """

    def __init__(self, cost_estimate: CostEstimate, model_call: ModelCostEstimate) -> None:
        """Initialize with the estimates.

        Args:
            cost_estimate: The running estimate for the whole request so far.
            model_call: The estimate for the model call that just ended.
        """
        super().__init__({"type": "cost_estimate", "cost_estimate": cost_estimate, "model_call": model_call})


class GenAIPricesEstimator(Plugin):
    """Estimates the USD cost of a request from its token usage and the list prices bundled in genai-prices.

    Attached to an agent, it adds a ``cost_estimate`` event to the agent's stream after every model call. The
    event carries the estimate for that call and the running estimate for the whole request so far, including
    nested and auxiliary model calls. :meth:`estimate` computes the request's estimate and needs no agent.

    It makes no network calls: prices are as recent as the installed genai-prices package.

    Args:
        prices: Your own prices. They win over genai-prices, and one with a ``provider_name`` wins over one
            without.

    Raises:
        ValueError: If two prices name the same provider and model.
    """

    name = "strands:genai-prices-estimator"

    def __init__(self, *, prices: Sequence[ModelPrice] = ()) -> None:
        """Initialize the estimator."""
        super().__init__()
        self._prices: dict[tuple[str | None, str], ModelPrice] = {}
        for price in prices:
            key = (price.provider_name, price.model_id)
            if key in self._prices:
                raise ValueError(
                    f"provider_name=<{key[0]}>, model_id=<{key[1]}> | prices has two entries for one model"
                )
            self._prices[key] = price
        # Loads the bundled price data now; the first lookup takes long enough to stall a running event loop.
        with contextlib.suppress(Exception):
            _genai_price("openai", "gpt-4o")

    def init_agent(self, agent: Agent) -> None:
        """Register the middleware that adds a ``cost_estimate`` event after each model call."""
        agent.add_middleware(InvokeModelStage, self._emit_estimate)

    def estimate(
        self, request: AgentResult | MultiAgentResult | InvocationContext | Iterable[ModelUsage]
    ) -> CostEstimate:
        """Estimate the cost of a request so far, including its nested and auxiliary model calls.

        A request you continue by passing its ``invocation_context`` to a later call is one request: its
        estimate grows, so do not add the estimates together.

        Args:
            request: An agent or multi-agent result, an ``InvocationContext``, or usage records such as a saved
                ``usage_by_model``.

        Returns:
            The estimate. A model without a price has ``cost_usd=None`` and makes ``total_usd`` ``None``, as
            does a result that carries no ``invocation_context``.

        Raises:
            TypeError: If ``request`` is none of the accepted types.
        """
        if hasattr(request, "invocation_context"):
            if request.invocation_context is None:
                return CostEstimate(total_usd=None, models=())
            request = request.invocation_context
        if isinstance(request, InvocationContext):
            return self._estimate(request.usage_by_model)
        is_records = isinstance(request, Iterable) and not isinstance(request, (str, bytes, Mapping))
        usage_by_model = list(request) if is_records else None
        if usage_by_model is None or not all(isinstance(model_usage, ModelUsage) for model_usage in usage_by_model):
            raise TypeError(
                f"request=<{type(request).__name__}> | expected an agent or multi-agent result, "
                "an InvocationContext, or an iterable of ModelUsage"
            )
        return self._estimate(usage_by_model)

    async def _emit_estimate(
        self, context: InvokeModelContext, next_fn: MiddlewareNext[InvokeModelContext, TypedEvent]
    ) -> AsyncGenerator[TypedEvent, None]:
        async for event in next_fn(context):
            yield event
            estimate_event = self._event_after_call(context, event) if isinstance(event, ModelStopReason) else None
            if estimate_event is not None:
                yield estimate_event

    def _event_after_call(self, context: InvokeModelContext, stop_event: ModelStopReason) -> CostEstimateEvent | None:
        """The event for a model call that has ended, or ``None`` so a pricing error never fails the call."""
        try:
            provider_name, model_id = _model_key(context.model)
            model_call = self._estimate_model(
                ModelUsage(provider_name=provider_name, model_id=model_id, usage=stop_event.usage)
            )
            # The event loop always sets the request; estimate() rejects a missing one.
            return CostEstimateEvent(self.estimate(context.invocation_context), model_call)  # type: ignore[arg-type]
        except Exception as error:
            logger.warning("error=<%s> | cost estimate failed | no estimate emitted for this model call", error)
            return None

    def _estimate(self, usage_by_model: Iterable[ModelUsage]) -> CostEstimate:
        models = tuple(self._estimate_model(model_usage) for model_usage in usage_by_model)
        costs = [model.cost_usd for model in models if model.cost_usd is not None]
        return CostEstimate(total_usd=math.fsum(costs) if len(costs) == len(models) else None, models=models)

    def _estimate_model(self, model_usage: ModelUsage) -> ModelCostEstimate:
        price, price_source = self._find_price(model_usage.provider_name, model_usage.model_id)
        return ModelCostEstimate(
            provider_name=model_usage.provider_name,
            model_id=model_usage.model_id,
            usage=model_usage.usage,
            cost_usd=None if price is None else _cost(model_usage.usage, price),
            price=price,
            price_source=price_source,
        )

    def _find_price(self, provider_name: str | None, model_id: str | None) -> tuple[ModelPrice | None, str | None]:
        if model_id is None:
            return None, None
        for key in ((provider_name, model_id), (None, model_id)):
            if key in self._prices:
                return self._prices[key], "user"
        return _genai_price(provider_name, model_id)


def _genai_price(provider_name: str | None, model_id: str) -> tuple[ModelPrice | None, str | None]:
    """Look a model up in genai-prices, returning its base rates and the entry that matched, or ``None`` twice."""
    provider_id, priced_model_id = _PROVIDER_IDS.get(provider_name or ""), model_id
    if provider_name == "litellm" and "/" in model_id:
        provider_id, priced_model_id = model_id.split("/", 1)
    # A bare LiteLLM id has no provider; genai-prices then infers one from the model name, as LiteLLM does.
    if provider_id is None and provider_name != "litellm":
        return None, None
    try:
        matched = calc_price(_PricedUsage(input_tokens=0, output_tokens=0), priced_model_id, provider_id=provider_id)
    except LookupError:
        return None, None
    input_rate, output_rate, cache_read_rate, cache_write_rate = (
        _base_rate(getattr(matched.model_price, field, None)) for field in _GENAI_RATE_FIELDS
    )
    # A fee per request cannot be worked out from token counts, so an entry that has one is left unpriced.
    if input_rate is None or output_rate is None or getattr(matched.model_price, "requests_kcount", None) is not None:
        return None, None
    price = ModelPrice(
        model_id=model_id,
        provider_name=provider_name,
        input_per_million=input_rate,
        output_per_million=output_rate,
        cache_read_per_million=cache_read_rate,
        cache_write_per_million=cache_write_rate,
    )
    return price, f"genai-prices:{matched.provider.id}/{matched.model.id}"


def _base_rate(rate: Any) -> float | None:
    """A model's total cannot say which calls crossed a long-context tier, so a tiered rate is read at its base."""
    if rate is None:
        return None
    return float(rate.base if isinstance(rate, TieredPrices) else rate)


def _cost(usage: Usage, price: ModelPrice) -> float:
    """Tokens times price, charging cached tokens once whether or not ``inputTokens`` includes them."""
    cache_read = usage.get("cacheReadInputTokens", 0)
    cache_write = usage.get("cacheWriteInputTokens", 0)
    uncached_input = usage["inputTokens"]
    if usage["inputTokens"] + usage["outputTokens"] == usage["totalTokens"]:
        uncached_input = max(uncached_input - cache_read - cache_write, 0)
    cache_read_rate = price.input_per_million if price.cache_read_per_million is None else price.cache_read_per_million
    cache_write_rate = (
        price.input_per_million if price.cache_write_per_million is None else price.cache_write_per_million
    )
    return (
        uncached_input * price.input_per_million
        + cache_read * cache_read_rate
        + cache_write * cache_write_rate
        + usage["outputTokens"] * price.output_per_million
    ) / 1_000_000

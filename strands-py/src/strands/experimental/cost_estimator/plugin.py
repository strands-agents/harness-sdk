"""Estimate what a request cost in USD from its token usage per model and the list prices in genai-prices.

The estimate is tokens times list price. It is not a bill: it knows nothing about regions, service tiers,
batch or provisioned pricing, negotiated discounts, or long-context price tiers.
"""

from __future__ import annotations

import logging
import math
from collections.abc import AsyncGenerator, Iterable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

try:
    from genai_prices import Usage as _PricedUsage
    from genai_prices import calc_price
    from genai_prices.types import TieredPrices
except ImportError as error:
    raise ImportError(
        "strands.experimental.cost_estimator requires the genai-prices package, which needs Python 3.11+. "
        "Install with: pip install 'strands-agents[cost-estimation]'"
    ) from error

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
    "bedrock-mantle": "aws",
    "google": "google",
    "mistral": "mistral",
    "openai": "openai",
    "typesafe": "typesafe",
}
_GENAI_RATE_FIELDS = ("input_mtok", "output_mtok", "cache_read_mtok", "cache_write_mtok")


@dataclass(frozen=True)
class ModelPrice:
    """List price of a model in USD per one million tokens.

    Attributes:
        input_per_million: Price of uncached input tokens.
        output_per_million: Price of output tokens.
        cache_read_per_million: Price of input tokens read from cache; ``None`` uses the input price.
        cache_write_per_million: Price of input tokens written to cache; ``None`` uses the input price.
        model_id: The model the price is for, compared as a whole string. Required on a price you pass in.
        provider_name: The provider the price is for; ``None`` matches the model id on any provider.

    Raises:
        ValueError: If a price is not a finite, non-negative number.
    """

    input_per_million: float
    output_per_million: float
    cache_read_per_million: float | None = None
    cache_write_per_million: float | None = None
    model_id: str | None = None
    provider_name: str | None = None

    def __post_init__(self) -> None:
        """Reject prices that are not finite, non-negative numbers."""
        for name in ("input_per_million", "output_per_million", "cache_read_per_million", "cache_write_per_million"):
            value = getattr(self, name)
            if value is None and name.startswith("cache_"):
                continue
            is_number = isinstance(value, (int, float)) and not isinstance(value, bool)
            if not (is_number and math.isfinite(value) and value >= 0):
                raise ValueError(f"{name}=<{value!r}> | a price must be a finite, non-negative number")


@dataclass(frozen=True)
class ModelCostEstimate:
    """Estimated cost of one model's share of a request.

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
    usage: Usage
    cost_usd: float | None
    price: ModelPrice | None
    price_source: str | None


@dataclass(frozen=True)
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
    """Stream event carrying the estimated cost of the request so far, emitted after each model call."""

    def __init__(self, cost_estimate: CostEstimate) -> None:
        """Initialize with the estimate.

        Args:
            cost_estimate: The estimate for the whole request so far, not for one model call.
        """
        super().__init__({"cost_estimate": cost_estimate})


class GenAIPricesEstimator(Plugin):
    """Estimates the USD cost of a request from its token usage and the list prices bundled in genai-prices.

    Attached to an agent, it adds a ``cost_estimate`` event to the agent's stream after every model call. The
    event carries the estimate for the whole request so far, including nested and auxiliary model calls.
    :meth:`estimate` computes the same for a finished request and needs no agent.

    It makes no network calls: prices are as recent as the installed genai-prices package.

    Args:
        prices: Your own prices, each naming its ``model_id``. They win over genai-prices, and one with a
            ``provider_name`` wins over one without.

    Raises:
        ValueError: If a price has no ``model_id``, or two prices name the same provider and model.
    """

    name = "strands:genai-prices-estimator"

    def __init__(self, *, prices: Sequence[ModelPrice] = ()) -> None:
        """Initialize the estimator."""
        super().__init__()
        self._prices: dict[tuple[str | None, str], ModelPrice] = {}
        for price in prices:
            if price.model_id is None:
                raise ValueError(f"price=<{price!r}> | a price passed in prices needs a model_id")
            key = (price.provider_name, price.model_id)
            if key in self._prices:
                raise ValueError(
                    f"provider_name=<{key[0]}>, model_id=<{key[1]}> | prices has two entries for one model"
                )
            self._prices[key] = price

    def init_agent(self, agent: Agent) -> None:
        """Register the middleware that adds a ``cost_estimate`` event after each model call."""
        agent.add_middleware(InvokeModelStage, self._emit_estimate)

    def estimate(self, request: AgentResult | MultiAgentResult | InvocationContext) -> CostEstimate:
        """Estimate the cost of a request so far, including its nested and auxiliary model calls.

        A request you continue by passing its ``invocation_context`` to a later call is one request: its
        estimate grows, so do not add the estimates together.

        Args:
            request: An agent or multi-agent result, or an ``InvocationContext``.

        Returns:
            The estimate. A model without a price has ``cost_usd=None`` and makes ``total_usd`` ``None``, as
            does a result that carries no ``invocation_context``.
        """
        context = request if isinstance(request, InvocationContext) else request.invocation_context
        if context is None:
            return CostEstimate(total_usd=None, models=())
        return self._estimate(context.usage_by_model)

    async def _emit_estimate(
        self, context: InvokeModelContext, next_fn: MiddlewareNext[InvokeModelContext, TypedEvent]
    ) -> AsyncGenerator[TypedEvent, None]:
        async for event in next_fn(context):
            yield event
            estimate = self._estimate_after_call(context, event) if isinstance(event, ModelStopReason) else None
            if estimate is not None:
                yield CostEstimateEvent(estimate)

    def _estimate_after_call(self, context: InvokeModelContext, stop_event: ModelStopReason) -> CostEstimate | None:
        """The request's estimate once a model call has ended, or ``None`` so a pricing error never fails the call."""
        try:
            if context.invocation_context is not None:
                return self.estimate(context.invocation_context)
            return self._estimate([ModelUsage(*_model_key(context.model), stop_event.usage)])
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
    if provider_name is None:
        return None, None
    provider_id, priced_model_id = _PROVIDER_IDS.get(provider_name), model_id
    if provider_name == "litellm" and "/" in model_id:
        provider_id, priced_model_id = model_id.split("/", 1)
    if provider_id is None:
        return None, None
    try:
        matched = calc_price(_PricedUsage(input_tokens=0, output_tokens=0), priced_model_id, provider_id=provider_id)
    except LookupError:
        return None, None
    input_rate, output_rate, cache_read_rate, cache_write_rate = (
        _base_rate(getattr(matched.model_price, field, None)) for field in _GENAI_RATE_FIELDS
    )
    if input_rate is None or output_rate is None:
        return None, None
    price = ModelPrice(input_rate, output_rate, cache_read_rate, cache_write_rate, model_id, provider_name)
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

Estimate what a request cost in USD from its token usage per model and the list prices in genai-prices.

The estimate is tokens times list price. It is not a bill: it knows nothing about regions, service tiers, batch or provisioned pricing, negotiated discounts, or long-context price tiers.

## ModelPrice

```python
@dataclass(frozen=True, kw_only=True)
class ModelPrice()
```

Defined in: [src/strands/vended\_plugins/cost\_estimator/plugin.py:56](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/cost_estimator/plugin.py#L56)

List price of a model in USD per one million tokens.

**Attributes**:

-   `model_id` - The model the price is for, compared as a whole string.
-   `input_per_million` - Price of uncached input tokens.
-   `output_per_million` - Price of output tokens.
-   `cache_read_per_million` - Price of input tokens read from cache; `None` uses the input price.
-   `cache_write_per_million` - Price of input tokens written to cache; `None` uses the input price.
-   `provider_name` - The provider the price is for, compared as a whole string with the `provider_name` of the usage; `None` matches the model id on any provider.

**Raises**:

-   `ValueError` - If `model_id` is not a non-empty string, or a price is not a finite, non-negative number.

#### \_\_post\_init\_\_

```python
def __post_init__() -> None
```

Defined in: [src/strands/vended\_plugins/cost\_estimator/plugin.py:79](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/cost_estimator/plugin.py#L79)

Reject an empty model id and prices that are not finite, non-negative numbers.

## ModelCostEstimate

```python
@dataclass(frozen=True, kw_only=True)
class ModelCostEstimate()
```

Defined in: [src/strands/vended\_plugins/cost\_estimator/plugin.py:93](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/cost_estimator/plugin.py#L93)

Estimated cost of one model’s share of a request, or of one model call.

**Attributes**:

-   `provider_name` - Name of the model’s provider; `None` when not known.
-   `model_id` - The model id; `None` when not known.
-   `usage` - The token usage the estimate is for.
-   `cost_usd` - The estimate in USD; `None` when no price was found.
-   `price` - The price used; `None` when no price was found.
-   `price_source` - `"user"` for a price you passed, or the genai-prices entry the price came from, such as `"genai-prices:aws/amazon.nova-lite-v1:0"`; `None` when no price was found.

## CostEstimate

```python
@dataclass(frozen=True, kw_only=True)
class CostEstimate()
```

Defined in: [src/strands/vended\_plugins/cost\_estimator/plugin.py:115](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/cost_estimator/plugin.py#L115)

Estimated cost of a request so far.

**Attributes**:

-   `total_usd` - The estimate in USD; `None` when any model in the request has no price.
-   `models` - The estimate for each model the request used.

#### unpriced

```python
@property
def unpriced() -> tuple[ModelCostEstimate, ...]
```

Defined in: [src/strands/vended\_plugins/cost\_estimator/plugin.py:127](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/cost_estimator/plugin.py#L127)

The models no price was found for.

## CostEstimateEvent

```python
class CostEstimateEvent(TypedEvent)
```

Defined in: [src/strands/vended\_plugins/cost\_estimator/plugin.py:132](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/cost_estimator/plugin.py#L132)

Stream event emitted after each model call, carrying its estimated cost and the request’s so far.

`model_call` names the model the plugin saw. Wrap middleware added after the plugin that swaps the model, or answers without calling one, is not reflected in it; the request’s estimate is.

#### \_\_init\_\_

```python
def __init__(cost_estimate: CostEstimate,
             model_call: ModelCostEstimate) -> None
```

Defined in: [src/strands/vended\_plugins/cost\_estimator/plugin.py:139](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/cost_estimator/plugin.py#L139)

Initialize with the estimates.

**Arguments**:

-   `cost_estimate` - The running estimate for the whole request so far.
-   `model_call` - The estimate for the model call that just ended.

## GenAIPricesEstimator

```python
class GenAIPricesEstimator(Plugin)
```

Defined in: [src/strands/vended\_plugins/cost\_estimator/plugin.py:149](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/cost_estimator/plugin.py#L149)

Estimates the USD cost of a request from its token usage and the list prices bundled in genai-prices.

Attached to an agent, it adds a `cost_estimate` event to the agent’s stream after every model call. The event carries the estimate for that call and the running estimate for the whole request so far, including nested and auxiliary model calls. :meth:`estimate` computes the request’s estimate and needs no agent.

It makes no network calls: prices are as recent as the installed genai-prices package.

**Arguments**:

-   `prices` - Your own prices. They win over genai-prices, and one with a `provider_name` wins over one without.

**Raises**:

-   `ValueError` - If two prices name the same provider and model.

#### \_\_init\_\_

```python
def __init__(*, prices: Sequence[ModelPrice] = ()) -> None
```

Defined in: [src/strands/vended\_plugins/cost\_estimator/plugin.py:168](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/cost_estimator/plugin.py#L168)

Initialize the estimator.

#### init\_agent

```python
def init_agent(agent: Agent) -> None
```

Defined in: [src/strands/vended\_plugins/cost\_estimator/plugin.py:183](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/cost_estimator/plugin.py#L183)

Register the middleware that adds a `cost_estimate` event after each model call.

#### estimate

```python
def estimate(
    request: AgentResult | MultiAgentResult | InvocationContext
    | Iterable[ModelUsage]
) -> CostEstimate
```

Defined in: [src/strands/vended\_plugins/cost\_estimator/plugin.py:187](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/cost_estimator/plugin.py#L187)

Estimate the cost of a request so far, including its nested and auxiliary model calls.

A request you continue by passing its `invocation_context` to a later call is one request: its estimate grows, so do not add the estimates together.

**Arguments**:

-   `request` - An agent or multi-agent result, an `InvocationContext`, or usage records such as a saved `usage_by_model`.

**Returns**:

The estimate. A model without a price has `cost_usd=None` and makes `total_usd` `None`, as does a result that carries no `invocation_context`.

**Raises**:

-   `TypeError` - If `request` is none of the accepted types.
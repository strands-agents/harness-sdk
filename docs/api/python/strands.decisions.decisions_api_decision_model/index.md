Decision model backed by decisionapi.net.

## DecisionsAPIDecisionModel

```python
class DecisionsAPIDecisionModel(DecisionModel)
```

Defined in: [src/strands/decisions/decisions\_api\_decision\_model.py:18](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/decisions_api_decision_model.py#L18)

Decision model backed by decisionapi.net.

`ask` raises `ModelThrottledException` on provider throttling (HTTP 429/503/529, with the `httpx.HTTPStatusError` as `__cause__`), `ContextWindowOverflowException` when the request exceeds the provider’s size limit (HTTP 413 or the pre-send body-byte check), `ValueError` for request-level violations (more than eight questions, too many choices, binary content, state that is not JSON-serializable or contains NaN/infinity), `httpx.HTTPStatusError` for any other non-2xx response, and `StructuredOutputException` for a malformed provider response. Transport errors from the HTTP client (e.g. `httpx.TimeoutException`, `httpx.ConnectError`) propagate unchanged.

**Example**:

```python
decisions = DecisionsAPIDecisionModel()  # reads JEV_API_KEY from the environment
result = await decisions.ask(
    "A customer needs a refund today.",
    \{"department": \{"question": "Which team should handle this?", "choices": ["billing", "support"]}},
)
```

#### \_\_init\_\_

```python
def __init__(
        *,
        api_key: str | None = None,
        model_id: str = _DECISIONS_API_DEFAULT_MODEL_ID,
        default_min_confidence: float = _DECISIONS_API_DEFAULT_MIN_CONFIDENCE,
        http_client: httpx.AsyncClient | None = None) -> None
```

Defined in: [src/strands/decisions/decisions\_api\_decision\_model.py:40](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/decisions_api_decision_model.py#L40)

Create a decisionapi.net-backed decision model.

**Arguments**:

-   `api_key` - Decisions API key. Defaults to the `JEV_API_KEY` environment variable.
-   `model_id` - Decisions API model identifier. Defaults to `~typesafe/jev-latest`.
-   `default_min_confidence` - Default minimum confidence in `[0.0, 1.0]`. Defaults to `0.5`.
-   `http_client` - `httpx.AsyncClient` used for the request. The caller owns and closes it; pass one to reuse connections across decisions, set a timeout, or add headers. When omitted, a client with a 30-second timeout is created per request.

**Raises**:

-   `ValueError` - If the API key is missing, `model_id` is empty, or the confidence threshold is out of range.
-   `TypeError` - If `http_client` is not an `httpx.AsyncClient`.
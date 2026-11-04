Decision model backed by TypeSafe’s hosted Jev API.

## TypeSafeDecisionModel

```python
class TypeSafeDecisionModel(DecisionModel)
```

Defined in: [src/strands/decisions/typesafe\_decision\_model.py:17](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/typesafe_decision_model.py#L17)

Decision model backed by TypeSafe’s hosted Jev API.

`ask` raises `ModelThrottledException` on provider throttling (HTTP 429/503/529, with the `httpx.HTTPStatusError` as `__cause__`), `ContextWindowOverflowException` when the request exceeds the provider’s size limit (HTTP 413 or the pre-send body-byte check), `ValueError` for request-level violations (too many choices, binary content, state that is not JSON-serializable or contains NaN/infinity), `httpx.HTTPStatusError` for any other non-2xx response, and `StructuredOutputException` for a malformed provider response. Transport errors from the HTTP client (e.g. `httpx.TimeoutException`, `httpx.ConnectError`) propagate unchanged.

**Example**:

```python
decisions = TypeSafeDecisionModel()  # reads TYPESAFE_API_KEY from the environment
result = await decisions.ask(
    "A customer needs a refund today.",
    \{"urgent": \{"question": "Is this urgent?", "choices": "boolean"}},
)
```

#### \_\_init\_\_

```python
def __init__(*,
             api_key: str | None = None,
             model_id: str = _TYPESAFE_DEFAULT_MODEL_ID,
             default_min_confidence: float = _TYPESAFE_DEFAULT_MIN_CONFIDENCE,
             http_client: httpx.AsyncClient | None = None) -> None
```

Defined in: [src/strands/decisions/typesafe\_decision\_model.py:38](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/typesafe_decision_model.py#L38)

Create a TypeSafe-backed decision model.

**Arguments**:

-   `api_key` - TypeSafe API key. Defaults to the `TYPESAFE_API_KEY` environment variable.
-   `model_id` - Jev model identifier. Defaults to `jev-latest`.
-   `default_min_confidence` - Default minimum confidence in `[0.0, 1.0]`. Defaults to `0.5`.
-   `http_client` - `httpx.AsyncClient` used for the request. The caller owns and closes it; pass one to reuse connections across decisions, set a timeout, or add headers. When omitted, a client with a 30-second timeout is created per request.

**Raises**:

-   `ValueError` - If the API key is missing, `model_id` is empty, or the confidence threshold is out of range.
-   `TypeError` - If `http_client` is not an `httpx.AsyncClient`.
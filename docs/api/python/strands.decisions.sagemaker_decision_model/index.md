Decision model backed by a System One model on a SageMaker AI real-time endpoint.

## SageMakerDecisionModel

```python
class SageMakerDecisionModel(DecisionModel)
```

Defined in: [src/strands/decisions/sagemaker\_decision\_model.py:34](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/sagemaker_decision_model.py#L34)

Decision model backed by a System One model on a SageMaker AI real-time endpoint.

Requests are signed with the standard AWS credential chain; callers need `sagemaker:InvokeEndpoint` on the endpoint.

`ask` raises `ModelThrottledException` when the endpoint is throttled, `ContextWindowOverflowException` when the request is too large, `ValueError` for an invalid request, and `StructuredOutputException` for a malformed response. Other SageMaker errors propagate unchanged.

**Example**:

```python
decisions = SageMakerDecisionModel("my-decider-endpoint", region_name="us-east-1")
result = await decisions.ask(
    "A customer needs a refund today.",
    \{"urgent": \{"question": "Is this urgent?", "choices": "boolean"}},
)
```

#### \_\_init\_\_

```python
def __init__(
        endpoint_name: str,
        *,
        region_name: str | None = None,
        boto_session: boto3.Session | None = None,
        boto_client_config: BotocoreConfig | None = None,
        client: "SageMakerRuntimeClient | None" = None,
        default_min_confidence: float = _SAGEMAKER_DEFAULT_MIN_CONFIDENCE
) -> None
```

Defined in: [src/strands/decisions/sagemaker\_decision\_model.py:55](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/sagemaker_decision_model.py#L55)

Create a SageMaker-backed decision model.

**Arguments**:

-   `endpoint_name` - Name of the SageMaker AI real-time endpoint serving the System One model.
-   `region_name` - AWS region of the endpoint. Takes precedence over `boto_client_config`’s region. Cannot be combined with `boto_session` or `client`.
-   `boto_session` - Boto session used to create the `sagemaker-runtime` client, for example one with a named profile or assumed-role credentials. Its region is used unless `boto_client_config` sets one. Cannot be combined with `region_name` or `client`.
-   `boto_client_config` - `botocore` configuration for the `sagemaker-runtime` client. Cannot be combined with `client`.
-   `client` - Pre-built `sagemaker-runtime` client, for example one shared with other components or configured with an endpoint override. Used as is, without the SDK’s user agent. Cannot be combined with `region_name`, `boto_session` or `boto_client_config`.
-   `default_min_confidence` - Default minimum confidence in `[0.0, 1.0]`. Defaults to `0.5`.

**Raises**:

-   `ValueError` - If the endpoint name is empty, the confidence threshold is out of range, `region_name` is combined with `boto_session`, or `client` is combined with `region_name`, `boto_session` or `boto_client_config`.
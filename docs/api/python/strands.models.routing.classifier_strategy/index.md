Route among configured candidates by asking a model or decision model one closed question.

## ClassifierStrategy

```python
class ClassifierStrategy()
```

Defined in: [src/strands/models/routing/classifier\_strategy.py:106](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/routing/classifier_strategy.py#L106)

Choose a candidate by applying a configurable routing policy with a classifier model.

The classifier is asked one closed question that carries the SDK’s fixed routing rules followed by the routing policy. A `DecisionModel`, such as a System One provider, can be passed in place of a model.

Each candidate is offered under a positional key (`c0`, `c1`, …); names, descriptions, and metadata travel only as evidence in the routing context, so optional or arbitrary names never become answer values. The routing context is a bounded projection of the latest request, the parent agent’s textual instructions, and candidate evidence; it crosses the classifier provider boundary and must not contain secrets.

Selection runs only before the first model call. A single candidate is returned without asking. The classifier must commit to a key. Classification failures, unknown keys, and timeouts warn and decline selection, so `ModelRouter` serves candidate zero. After an attempt this strategy declines, so a failure of the selected candidate surfaces without switching. Nested routers are treated as opaque candidates using only their wrapper evidence.

**Example**:

```python
router = ModelRouter(
    models=[
        RoutingCandidate(fast, name="routine", description="Short factual requests"),
        RoutingCandidate(strong, name="complex", description="Multi-step design work"),
    ],
    strategy=ClassifierStrategy(classifier_model),
)
agent = Agent(model=router)
```

#### \_\_init\_\_

```python
def __init__(
        model: Model | DecisionModel,
        *,
        routing_policy: str | None = None,
        system_prompt: str | None = None,
        timeout: float = 30.0,
        max_message_chars: int = _DEFAULT_MESSAGE_CHARACTER_LIMIT,
        max_agent_instructions_chars:
    int = _DEFAULT_AGENT_INSTRUCTIONS_CHARACTER_LIMIT,
        max_candidate_chars: int = _DEFAULT_CANDIDATE_CHARACTER_LIMIT) -> None
```

Defined in: [src/strands/models/routing/classifier\_strategy.py:136](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/routing/classifier_strategy.py#L136)

Initialize the strategy.

**Arguments**:

-   `model` - Model or `DecisionModel` used for classification. A `Model` must honor forced tool selection, since a provider that ignores it fails classification and every selection falls back to candidate zero.
-   `routing_policy` - Routing policy, sent verbatim and never truncated. The SDK adds mandatory isolation, candidate-key, and structured-output rules that the policy cannot override. Defaults to the SDK input-complexity policy.
-   `system_prompt` - Deprecated alias for `routing_policy`.
-   `timeout` - Maximum seconds to wait for the decision. On timeout the decision call is cancelled.
-   `max_message_chars` - Maximum characters copied from the latest request into the routing context.
-   `max_agent_instructions_chars` - Maximum characters copied from the parent agent’s system prompt text into the routing context.
-   `max_candidate_chars` - Maximum aggregate characters for the serialized evidence (names, descriptions, and metadata) of all candidates. Evidence is never truncated; selection raises `ValueError` when the budget is exceeded.

**Raises**:

-   `TypeError` - If `model` is not a `Model` or `DecisionModel`, or another argument has the wrong type.
-   `ValueError` - If both `routing_policy` and `system_prompt` are set, `timeout` is not finite and greater than zero, or a character limit is not positive.

#### select

```python
async def select(context: RoutingContext,
                 **kwargs: Any) -> RoutingCandidate | None
```

Defined in: [src/strands/models/routing/classifier\_strategy.py:186](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/routing/classifier_strategy.py#L186)

Select one opening candidate, declining on a decision failure.

**Raises**:

-   `ValueError` - If the candidates’ serialized evidence exceeds `max_candidate_chars`. This misconfiguration is permanent, so it propagates instead of declining.
Base interface for making structured “decisions” from inside the SDK.

## DecisionModel

```python
class DecisionModel(abc.ABC)
```

Defined in: [src/strands/decisions/decision\_model.py:15](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/decision_model.py#L15)

Abstract base for anything that can answer closed questions.

The public `ask` opens a `decision` span, validates the question map, delegates to the subclass `_ask`, records usage and the answer set as span attributes/events, and closes the span. Every implementation is traced identically. Given an `invocation_context`, `ask` also adds the reported usage to that request once `_ask` returns.

#### ask

```python
async def ask(state: DecisionInput,
              questions: dict[str, Question],
              *,
              invocation_context: InvocationContext | None = None,
              **kwargs: Any) -> DecisionResult
```

Defined in: [src/strands/decisions/decision\_model.py:24](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/decision_model.py#L24)

Ask one or more closed questions over the given state.

**Arguments**:

-   `state` - A plain string, a one-shot content list, or a message history.
-   `questions` - Map of identifier to question. The returned `answers` dict is keyed off this same map.
-   `invocation_context` - Request to add this decision’s token usage to. The request’s limits do not apply to the decision.
-   `**kwargs` - Additional keyword arguments forwarded to the implementation for future extensibility.

**Returns**:

A `DecisionResult` whose answers are keyed by the question identifiers.

**Raises**:

-   `ValueError` - If `questions` is empty or a question violates its semantic constraints.
-   `TypeError` - If `invocation_context` was not created by the SDK.
-   `StructuredOutputException` - If the model declines to produce a valid answer set, omits an answer, or returns a value outside a question’s allowed choices.
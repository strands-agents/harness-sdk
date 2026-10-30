Public types for the decision model primitive.

See `team/designs/0020-decision-models.md` for the design rationale.

#### DecisionInput

Input state passed to a decision model invocation.

A plain string question, a single-turn content list (multimodal), or a full message history.

## UncertaintyOptions

```python
class UncertaintyOptions(TypedDict)
```

Defined in: [src/strands/decisions/types.py:21](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/types.py#L21)

Fine-grained uncertainty configuration for a question.

**Attributes**:

-   `min_confidence` - Minimum confidence in `[0.0, 1.0]` below which the answer is reported as uncertain. Read only by implementations that return per-answer confidence (e.g. System One models); ignored by `LLMDecisionModel`.

## Question

```python
class Question(TypedDict)
```

Defined in: [src/strands/decisions/types.py:33](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/types.py#L33)

A single question posed to a decision model.

**Attributes**:

-   `question` - The question posed to the model, in natural language.
-   `choices` - Answer shape: `"boolean"` or a non-empty list of string literals.
-   `uncertainty` - Uncertainty configuration for this question. Omitted or `True` permits an uncertain answer (the default); `False` disables it, forcing a commitment to one of `choices`; an `UncertaintyOptions` mapping permits it with a custom minimum confidence.

## Uncertain

```python
@dataclass(frozen=True)
class Uncertain()
```

Defined in: [src/strands/decisions/types.py:51](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/types.py#L51)

Sentinel returned in place of an answer when the decision model declined to commit.

Carries an optional free-form reason supplied by the implementation. Note that an `Uncertain` instance is truthy: always narrow an answer with `isinstance(value, Uncertain)` before using it, rather than relying on its truthiness.

**Attributes**:

-   `reason` - Optional free-form explanation for the uncertainty.

#### \_\_str\_\_

```python
def __str__() -> str
```

Defined in: [src/strands/decisions/types.py:64](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/types.py#L64)

Render as `Uncertain(reason)` or `Uncertain` when no reason is set.

## DecisionMetadata

```python
@dataclass
class DecisionMetadata()
```

Defined in: [src/strands/decisions/types.py:70](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/types.py#L70)

Per-call metadata recorded by a decision model implementation.

**Attributes**:

-   `latency_ms` - Time spent in the underlying model call, in milliseconds.

## DecisionResult

```python
@dataclass
class DecisionResult()
```

Defined in: [src/strands/decisions/types.py:81](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/types.py#L81)

Result returned by `DecisionModel.ask`, keyed by the same identifiers as the question map.

**Attributes**:

-   `answers` - Per-question answer, keyed by question id. Each value is a `bool` (boolean question), one of the question’s `choices`, or `Uncertain`. Narrow with `isinstance(value, Uncertain)` before using an answer.
-   `metadata` - Per-call metadata recorded by the implementation.
-   `usage` - Aggregate token usage for the underlying model call, when the provider reports it.
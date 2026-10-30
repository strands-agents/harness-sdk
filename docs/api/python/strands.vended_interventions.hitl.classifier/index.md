Built-in risk classifiers for the HumanInTheLoop handler.

The LLM classifier uses an inner agent with structured output; the decision model classifier asks any `DecisionModel` a single boolean question. Both evaluate whether a tool call requires human approval against the same risk criteria.

## ClassifierResult

```python
@dataclass
class ClassifierResult()
```

Defined in: [src/strands/vended\_interventions/hitl/classifier.py:27](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_interventions/hitl/classifier.py#L27)

Result from a classifier evaluation.

## HumanInTheLoopClassifier

```python
@runtime_checkable
class HumanInTheLoopClassifier(Protocol)
```

Defined in: [src/strands/vended\_interventions/hitl/classifier.py:35](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_interventions/hitl/classifier.py#L35)

Callable (sync or async) that decides whether a tool call requires human approval.

#### \_\_call\_\_

```python
def __call__(event: BeforeToolCallEvent,
             **kwargs: Any) -> ClassifierResult | Awaitable[ClassifierResult]
```

Defined in: [src/strands/vended\_interventions/hitl/classifier.py:38](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_interventions/hitl/classifier.py#L38)

Evaluate whether a tool call requires human approval.

**Arguments**:

-   `event` - The tool call event under evaluation.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Returns**:

ClassifierResult indicating whether approval is required.

## LLMClassifierConfig

```python
@dataclass
class LLMClassifierConfig()
```

Defined in: [src/strands/vended\_interventions/hitl/classifier.py:52](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_interventions/hitl/classifier.py#L52)

Configuration for the built-in LLM risk classifier.

Kept for backwards compatibility. Prefer passing a `DecisionModel` as the classifier for new code.

**Arguments**:

-   `system_prompt` - Risk criteria prompt. Defaults to a general-purpose risk prompt.
-   `model` - Model for risk evaluation. Resolution order: this `model` > `agent.aux_model`
    
    > `agent.model`.
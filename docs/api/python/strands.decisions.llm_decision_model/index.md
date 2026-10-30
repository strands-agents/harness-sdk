Decision model backed by a vended `Model` provider.

Translates an `ask` call into a single forced structured-output model call, parses the model’s answers, and lifts them back into the SDK’s answer shape.

## LLMDecisionModel

```python
class LLMDecisionModel(DecisionModel)
```

Defined in: [src/strands/decisions/llm\_decision\_model.py:31](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/llm_decision_model.py#L31)

Adapter that turns any `Model` into a `DecisionModel`.

`ask` is implemented as one direct model call with a dynamically-built Pydantic answer model and forced structured output. Uncertainty is modeled by appending an `'uncertain'` option to each permitting question’s enum.

**Example**:

```python
decision = LLMDecisionModel(model=BedrockModel())
result = await decision.ask(
    "The fruit is an apple",
    \{
        "color": \{"question": "What color is the fruit?", "choices": ["red", "green", "blue"]},
        "is_fruit": \{
            "question": "Is the thing talked about a fruit?",
            "choices": "boolean",
            "uncertainty": False,
        },
    },
)
# result.answers["color"]    is "red" | "green" | "blue" | Uncertain
# result.answers["is_fruit"] is True | False | Uncertain
#   (opting out via `uncertainty=False` only removes 'uncertain' from the model's enum)
```

#### \_\_init\_\_

```python
def __init__(model: Model | None = None,
             *,
             system_prompt: str = _DEFAULT_SYSTEM_PROMPT) -> None
```

Defined in: [src/strands/decisions/llm\_decision\_model.py:58](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/llm_decision_model.py#L58)

Create an LLM-backed decision model.

**Arguments**:

-   `model` - Underlying vended model. Defaults to a zero-config `BedrockModel`.
-   `system_prompt` - System prompt used to frame the decision for the model. The SDK appends mandatory output and prompt-injection rules that the prompt cannot override. Defaults to a generic decision framing.

**Raises**:

-   `TypeError` - If `model` is not a `Model`.
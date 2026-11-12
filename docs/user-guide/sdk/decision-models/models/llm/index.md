`LLMDecisionModel` answers questions with a model you already use, from any [model provider](/docs/user-guide/sdk/model-providers/index.md). Each `ask` is a single call to that model, outside the agent loop.

## Configuration

| Option | Description |
| --- | --- |
| `model` | The model that answers. Defaults to Amazon Bedrock with the SDK’s default model. |
| `system_prompt``systemPrompt` | Frames the questions for the model. Defaults to a general prompt for answering closed questions. |

The decision model uses only the model you pass. It doesn’t pick up an agent’s model or [auxiliary model](/docs/user-guide/sdk/model-providers/index.md#auxiliary-model), even when an agent’s tool or classifier calls it.

(( tab "Python" ))
```python
from strands import LLMDecisionModel
from strands.models import BedrockModel

decisions = LLMDecisionModel(
    model=BedrockModel(
        model_id="global.anthropic.claude-haiku-4-5-20251001-v1:0",
        # Constrain the model's tool input to the answer schema
        strict_tools=True,
    ),
    system_prompt="You triage messages sent to an online store's support team.",
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { BedrockModel, LLMDecisionModel } from '@strands-agents/sdk'

const decisions = new LLMDecisionModel({
  model: new BedrockModel({
    modelId: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    // Constrain the model's tool input to the answer schema
    strictTools: true,
  }),
  systemPrompt: "You triage messages sent to an online store's support team.",
})
```
(( /tab "TypeScript" ))

## Answers

The decision model sends all the questions in one [structured output](/docs/user-guide/sdk/agents/structured-output/index.md) call. Each answer is constrained to its choices, or `"uncertain"` when the question allows it. An uncertain answer can include the model’s reason, which the result carries on `Uncertain`.

## Prompt injection

The decision model adds rules after your system prompt that tell the model to treat the input as data, not instructions, and to ignore text that tries to change the rules, the choices, or the answer. Your system prompt can’t remove them.

## Errors

`ask` raises an error when the model returns no answers, omits a question, or returns a value outside a question’s choices. Errors from the model provider, such as throttling, pass through unchanged.

## Related pages

- [Decision models](/docs/user-guide/sdk/decision-models/index.md) (1 shared tag)
- [Decisions in an agent](/docs/user-guide/sdk/decision-models/agents/index.md) (1 shared tag)
- [Questions and answers](/docs/user-guide/sdk/decision-models/questions/index.md) (1 shared tag)
- [Supported decision models](/docs/user-guide/sdk/decision-models/models/index.md) (1 shared tag)
- [Decision model observability](/docs/user-guide/sdk/decision-models/observability/index.md) (1 shared tag)
- [Decision models quickstart](/docs/user-guide/sdk/decision-models/quickstart/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/decisions/llm_decision_model.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/llm_decision_model.py)

### TypeScript

- [harness-sdk/strands-ts/src/decisions/llm-decision-model.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/llm-decision-model.ts)

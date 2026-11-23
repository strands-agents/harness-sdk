You describe what you want to know as a map of questions, and every decision model returns the same result shape, so the code that asks and the code that reads the answers stay the same when you change decision models.

## Questions

You pass questions to `ask` as a map from an id to a question. The id is yours: the result uses the same ids, so you read each answer by the id you gave it. One call can ask several questions about the same input.

| Field | Description |
| --- | --- |
| `question` | The question, in plain language. Must not be empty. |
| `choices` | `"boolean"` for a yes/no answer, or a list of labels for a multiple-choice answer. |
| `uncertainty` | Whether the answer can be `Uncertain`. See [Uncertainty](#uncertainty). |

A yes/no question returns `True``true` or `False``false`. A multiple-choice question returns one of its labels, exactly as you wrote it.

## Uncertainty

By default, every answer can be `Uncertain`: the decision model returns it instead of a choice when it can’t commit. Set `uncertainty` on a question to change that:

| Setting | Effect |
| --- | --- |
| Omitted, or `True``true` | The answer can be `Uncertain`. |
| `False``false` | The decision model must pick one of the choices. |
| A minimum confidence | The answer can be `Uncertain`, and an answer whose confidence is below the threshold (in `[0.0, 1.0]`) comes back as `Uncertain`. |

The minimum confidence, `{"min_confidence": 0.8}``{ minConfidence: 0.8 }`, applies only to decision models that report a confidence for each answer. The [LLM decision model](/docs/user-guide/sdk/decision-models/models/llm/index.md) doesn’t, so it ignores the threshold.

`Uncertain` carries an optional reason. Check for it before you use an answer, with `isinstance(answer, Uncertain)``answer instanceof Uncertain`.

### Confidence

[TypeSafe Jev](/docs/user-guide/sdk/decision-models/models/typesafe/index.md), [Decisions API](/docs/user-guide/sdk/decision-models/models/decisions-api/index.md), and [Amazon SageMaker AI](/docs/user-guide/sdk/decision-models/models/sagemaker/index.md) report a confidence in `[0.0, 1.0]` for each answer in `metadata.confidence`, and each choice’s probability in `metadata.probabilities`. Their default minimum confidence is 0.5. An answer below the minimum comes back as `Uncertain`, and the metadata still shows what the model leaned toward.

-   **Yes/no**: the model returns the probability of yes, and the answer is yes at 0.5 or above. The confidence measures how far that probability sits from 0.5, from 0 at 0.5 to 1 at 0.0 or 1.0. At the default minimum, a yes/no answer needs a probability of at least 0.75 or at most 0.25.
-   **Multiple choice**: the model returns each label’s probability and its own confidence in the label it picked.

## Input

The input is what the questions are about. It can be a string, a list of content blocks for a single message, or a full conversation as a list of messages. A conversation lets the decision model answer about the whole exchange, not only the latest message:

(( tab "Python" ))
```python
import asyncio

from strands import LLMDecisionModel

conversation = [
    {"role": "user", "content": [{"text": "Where is my order 1182?"}]},
    {"role": "assistant", "content": [{"text": "It shipped yesterday."}]},
    {"role": "user", "content": [{"text": "I've asked three times. Cancel it."}]},
]


async def main():
    decisions = LLMDecisionModel()
    result = await decisions.ask(
        conversation,
        {
            "sentiment": {
                "question": "How does the customer feel?",
                "choices": ["positive", "neutral", "negative"],
            },
        },
    )
    print(result.answers["sentiment"])


asyncio.run(main())

# Typical output:
# negative
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { LLMDecisionModel, Message, TextBlock } from '@strands-agents/sdk'

const conversation = [
  new Message({ role: 'user', content: [new TextBlock('Where is my order 1182?')] }),
  new Message({ role: 'assistant', content: [new TextBlock('It shipped yesterday.')] }),
  new Message({
    role: 'user',
    content: [new TextBlock("I've asked three times. Cancel it.")],
  }),
]

const decisions = new LLMDecisionModel()
const result = await decisions.ask(conversation, {
  sentiment: {
    question: 'How does the customer feel?',
    choices: ['positive', 'neutral', 'negative'],
  },
})
console.log(result.answers.sentiment)

// Typical output:
// negative
```
(( /tab "TypeScript" ))

## Results

`ask` returns a result with the answers, metadata about the call, and token usage:

| Field | Description |
| --- | --- |
| `answers` | One answer per question, keyed by question id. |
| `metadata.latency_ms``metadata.latencyMs` | Time the decision model spent on the call, in milliseconds. |
| `metadata.provider_name``metadata.providerName`, `metadata.model_id``metadata.modelId` | The provider and model that answered, when the decision model reports them. |
| `metadata.probabilities`, `metadata.confidence` | The probability of each choice and the confidence of each answer, keyed by question id, when the decision model reports them. |
| `usage` | Input, output, and total tokens, when the decision model reports them. |

## Validation

`ask` checks the questions before it calls any model and raises an error when:

-   There are no questions.
-   A question’s text is empty or only whitespace.
-   A multiple-choice question has no labels, an empty label, or the same label twice.
-   A label is `"uncertain"`, which is reserved for the `Uncertain` answer.
-   A minimum confidence is outside `[0.0, 1.0]`.

TypeSafe Jev, Decisions API, and Amazon SageMaker AI also raise an error, before they call the provider, for:

-   A multiple-choice question with more than 255 labels.
-   Input with binary content, such as an image or document passed as bytes. Send text instead.
-   Input that can’t be serialized to JSON. NaN and infinity count as input that can't be serialized.NaN and infinity aren't rejected: they're sent as null.

## Related pages

- [Decision models](/docs/user-guide/sdk/decision-models/index.md) (1 shared tag)
- [Decisions API](/docs/user-guide/sdk/decision-models/models/decisions-api/index.md) (1 shared tag)
- [Decisions in an agent](/docs/user-guide/sdk/decision-models/agents/index.md) (1 shared tag)
- [LLM decision model](/docs/user-guide/sdk/decision-models/models/llm/index.md) (1 shared tag)
- [Supported decision models](/docs/user-guide/sdk/decision-models/models/index.md) (1 shared tag)
- [Typed rubric evaluator](/docs/user-guide/evals-sdk/evaluators/typed_rubric_evaluator/index.md) (1 shared tag)
- [TypeSafe Jev](/docs/user-guide/sdk/decision-models/models/typesafe/index.md) (1 shared tag)
- [Amazon SageMaker AI](/docs/user-guide/sdk/decision-models/models/sagemaker/index.md) (1 shared tag)
- [Model Routing](/docs/user-guide/sdk/model-providers/model-routing/index.md) (1 shared tag)
- [Decision model observability](/docs/user-guide/sdk/decision-models/observability/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/decisions/types.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/types.py)
- [harness-sdk/strands-py/src/strands/decisions/decision_model.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/decision_model.py)
- [harness-sdk/strands-py/src/strands/decisions/_system_one_http_adapter.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/_system_one_http_adapter.py)

### TypeScript

- [harness-sdk/strands-ts/src/decisions/types.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts)
- [harness-sdk/strands-ts/src/decisions/decision-model.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/decision-model.ts)
- [harness-sdk/strands-ts/src/decisions/system-one-http-adapter.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/system-one-http-adapter.ts)

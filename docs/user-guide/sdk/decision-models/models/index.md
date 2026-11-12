To change what answers your questions, you change the decision model class. Every class takes the same [questions](/docs/user-guide/sdk/decision-models/questions/index.md) and returns the same result, so the rest of your code stays as it is.

## Built-in decision models

| Decision model | Class | Answers with | Reports |
| --- | --- | --- | --- |
| [LLM decision model](/docs/user-guide/sdk/decision-models/models/llm/index.md) | `LLMDecisionModel` | Any model provider | Latency, token usage |

## Custom decision models

To answer questions with your own backend, such as a rules engine or a classifier you host, subclass `DecisionModel` and implement `_ask`. It receives the input and the questions and returns a result with one answer per question and the call’s latency. The base class validates the questions before your method runs, records the [decision span](/docs/user-guide/sdk/decision-models/observability/index.md) around it, and, when `ask` receives an invocation context, adds the reported token usage to that request.

This decision model answers yes/no questions by checking the input for keywords:

(( tab "Python" ))
```python
import asyncio
import time

from strands.decisions import DecisionMetadata, DecisionModel, DecisionResult


class KeywordDecisionModel(DecisionModel):
    """Answers yes when the input contains any of the keywords."""

    def __init__(self, keywords: list[str]):
        self.keywords = keywords

    async def _ask(self, state, questions, **kwargs):
        started = time.perf_counter()
        text = str(state).lower()
        found = any(keyword in text for keyword in self.keywords)
        return DecisionResult(
            answers={question_id: found for question_id in questions},
            metadata=DecisionMetadata(
                latency_ms=round((time.perf_counter() - started) * 1000)
            ),
        )


async def main():
    decisions = KeywordDecisionModel(["refund", "charged twice"])
    result = await decisions.ask(
        "I was charged twice for order 1182.",
        {"billing": {"question": "Is this a billing issue?", "choices": "boolean"}},
    )
    print(result.answers)


asyncio.run(main())

# Output:
# {'billing': True}
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { DecisionModel } from '@strands-agents/sdk'
import type {
  DecisionCallOptions,
  DecisionInput,
  DecisionResult,
  Question,
} from '@strands-agents/sdk'

/** Answers yes when the input contains any of the keywords. */
class KeywordDecisionModel extends DecisionModel {
  constructor(private readonly keywords: string[]) {
    super()
  }

  protected async _ask<const Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q,
    _options: DecisionCallOptions
  ): Promise<DecisionResult<Q>> {
    const startedAt = performance.now()
    const text = JSON.stringify(state).toLowerCase()
    const found = this.keywords.some((keyword) => text.includes(keyword))
    const answers = Object.fromEntries(Object.keys(questions).map((id) => [id, found]))
    return {
      answers,
      metadata: { latencyMs: Math.round(performance.now() - startedAt) },
    } as DecisionResult<Q>
  }
}

const decisions = new KeywordDecisionModel(['refund', 'charged twice'])
const result = await decisions.ask('I was charged twice for order 1182.', {
  billing: { question: 'Is this a billing issue?', choices: 'boolean' },
})
console.log(result.answers)

// Output:
// { billing: true }
```
(( /tab "TypeScript" ))

This example only handles yes/no questions. A decision model that also handles multiple-choice questions returns one of each question’s labels, or `Uncertain` when the question allows it. The base class doesn’t check the answers your method returns.

## Related pages

- [Decision models](/docs/user-guide/sdk/decision-models/index.md) (1 shared tag)
- [Decisions in an agent](/docs/user-guide/sdk/decision-models/agents/index.md) (1 shared tag)
- [LLM decision model](/docs/user-guide/sdk/decision-models/models/llm/index.md) (1 shared tag)
- [Questions and answers](/docs/user-guide/sdk/decision-models/questions/index.md) (1 shared tag)
- [Decision model observability](/docs/user-guide/sdk/decision-models/observability/index.md) (1 shared tag)
- [Decision models quickstart](/docs/user-guide/sdk/decision-models/quickstart/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/decisions/decision_model.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/decision_model.py)
- [harness-sdk/strands-py/src/strands/decisions/types.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/types.py)

### TypeScript

- [harness-sdk/strands-ts/src/decisions/decision-model.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/decision-model.ts)
- [harness-sdk/strands-ts/src/decisions/types.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts)

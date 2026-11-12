In this quickstart, you triage a customer support message with a decision model. You ask whether the message is urgent and which team should handle it, then read the answers in your code.

The examples use `LLMDecisionModel`, which runs the questions on a model provider. With no model configured, it uses Amazon Bedrock, so you need the SDK installed and AWS credentials with Amazon Bedrock access. The [Python](/docs/user-guide/sdk/quickstart/python/index.md) and [TypeScript](/docs/user-guide/sdk/quickstart/typescript/index.md) quickstarts cover both.

## Ask a question

Each question has an id you choose, the question in plain language, and its choices: `"boolean"` for a yes/no answer, or a list of labels. Pass the input and the questions to `ask`:

(( tab "Python" ))
```python
import asyncio

from strands import LLMDecisionModel

message = "I was charged twice for order 1182. Please refund one charge today."


async def main():
    decisions = LLMDecisionModel()
    result = await decisions.ask(
        message,
        {
            "urgent": {
                "question": "Does the customer need help today?",
                "choices": "boolean",
            },
            "team": {
                "question": "Which team should handle this message?",
                "choices": ["billing", "shipping", "technical"],
            },
        },
    )
    print(result.answers)


asyncio.run(main())

# Typical output:
# {'urgent': True, 'team': 'billing'}
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { LLMDecisionModel } from '@strands-agents/sdk'

const message = 'I was charged twice for order 1182. Please refund one charge today.'

const decisions = new LLMDecisionModel()
const result = await decisions.ask(message, {
  urgent: {
    question: 'Does the customer need help today?',
    choices: 'boolean',
  },
  team: {
    question: 'Which team should handle this message?',
    choices: ['billing', 'shipping', 'technical'],
  },
})
console.log(result.answers)

// Typical output:
// { urgent: true, team: 'billing' }
```
(( /tab "TypeScript" ))

The answers are keyed by your question ids. A yes/no question returns a boolean, and a multiple-choice question returns one of its labels.

## Handle an uncertain answer

Sometimes the input doesn’t support any of the choices. Instead of guessing, the decision model can return `Uncertain`, often with a reason. This message says nothing about the customer’s plan:

(( tab "Python" ))
```python
import asyncio

from strands import LLMDecisionModel, Uncertain

message = "I was charged twice for order 1182. Please refund one charge today."


async def main():
    decisions = LLMDecisionModel()
    result = await decisions.ask(
        message,
        {
            "plan": {
                "question": "Which plan is the customer on?",
                "choices": ["free", "pro", "enterprise"],
            },
        },
    )
    plan = result.answers["plan"]
    if isinstance(plan, Uncertain):
        print(f"Unknown plan: {plan.reason}")
    else:
        print(f"Plan: {plan}")


asyncio.run(main())

# Typical output:
# Unknown plan: The message does not mention which plan the customer is on.
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { LLMDecisionModel, Uncertain } from '@strands-agents/sdk'

const message = 'I was charged twice for order 1182. Please refund one charge today.'

const decisions = new LLMDecisionModel()
const result = await decisions.ask(message, {
  plan: {
    question: 'Which plan is the customer on?',
    choices: ['free', 'pro', 'enterprise'],
  },
})
const plan = result.answers.plan
if (plan instanceof Uncertain) {
  console.log(`Unknown plan: ${plan.reason}`)
} else {
  console.log(`Plan: ${plan}`)
}

// Typical output:
// Unknown plan: The message does not mention which plan the customer is on.
```
(( /tab "TypeScript" ))

Every question allows `Uncertain` unless you turn it off, which [Questions and answers](/docs/user-guide/sdk/decision-models/questions/index.md#uncertainty) covers.

## Next steps

-   [Questions and answers](/docs/user-guide/sdk/decision-models/questions/index.md): the choices, uncertainty settings, inputs, and result fields.
-   [Decisions in an agent](/docs/user-guide/sdk/decision-models/agents/index.md): ask from a tool and count the tokens toward the agent’s request.
-   [LLM decision model](/docs/user-guide/sdk/decision-models/models/llm/index.md): choose the model and system prompt.

## Related pages

- [Decision models](/docs/user-guide/sdk/decision-models/index.md) (1 shared tag)
- [Decisions in an agent](/docs/user-guide/sdk/decision-models/agents/index.md) (1 shared tag)
- [LLM decision model](/docs/user-guide/sdk/decision-models/models/llm/index.md) (1 shared tag)
- [Questions and answers](/docs/user-guide/sdk/decision-models/questions/index.md) (1 shared tag)
- [Supported decision models](/docs/user-guide/sdk/decision-models/models/index.md) (1 shared tag)
- [Choosing an Agent Foundation](/docs/user-guide/migrate/choosing-an-agent-foundation/index.md) (1 shared tag)
- [Get started](/docs/user-guide/sdk/quickstart/overview/index.md) (1 shared tag)
- [Python Quickstart](/docs/user-guide/sdk/quickstart/python/index.md) (1 shared tag)
- [Strands evaluation quickstart](/docs/user-guide/evals-sdk/quickstart/index.md) (1 shared tag)
- [Strands Shell quickstart](/docs/user-guide/shell/quickstart/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/decisions/llm_decision_model.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/llm_decision_model.py)
- [harness-sdk/strands-py/src/strands/decisions/types.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/types.py)

### TypeScript

- [harness-sdk/strands-ts/src/decisions/llm-decision-model.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/llm-decision-model.ts)
- [harness-sdk/strands-ts/src/decisions/types.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts)

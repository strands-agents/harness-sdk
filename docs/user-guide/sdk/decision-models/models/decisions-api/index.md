[Decisions API](https://decisionapi.net) serves decision models at decisionapi.net, with model identifiers such as `~typesafe/jev-latest`. `DecisionsAPIDecisionModel` sends your questions there and returns the same result as every other [decision model](/docs/user-guide/sdk/decision-models/models/index.md), plus a probability for each label and a confidence for each answer. By default it asks TypeSafe’s Jev model.

Choose it when you have a Decisions API key. If you have a TypeSafe key, use [`TypeSafeDecisionModel`](/docs/user-guide/sdk/decision-models/models/typesafe/index.md) instead: it calls Jev on TypeSafe directly, reports the exact Jev version that answered, and isn’t capped at eight questions per call.

Follow the [quickstart](/docs/user-guide/sdk/decision-models/quickstart/index.md) to ask your first questions. Swap in `DecisionsAPIDecisionModel` and the rest of the code stays the same.

## Installation

`DecisionsAPIDecisionModel` ships with the SDK and needs no extra:

(( tab "Python" ))
```bash
pip install strands-agents
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```bash
npm install @strands-agents/sdk
```

The class runs on the server only. Constructing it in a browser throws, because the request would expose your API key.
(( /tab "TypeScript" ))

## Credentials

Get an API key from Decisions API and set it in your environment:

```bash
export JEV_API_KEY="your-api-key"
```

`DecisionsAPIDecisionModel` reads `JEV_API_KEY` when you construct it. The variable holds a decisionapi.net key, not a TypeSafe key, despite the name. To pass the key directly, set `api_key``apiKey`. The constructor raises an error when neither is set.

## Configuration

| Option | Description |
| --- | --- |
| `api_key``apiKey` | Decisions API key. Defaults to `JEV_API_KEY`. |
| `model_id``modelId` | Decisions API model identifier. Defaults to `~typesafe/jev-latest`. |
| `default_min_confidence``defaultMinConfidence` | Confidence below which an answer comes back `Uncertain`, in `[0.0, 1.0]`. Defaults to `0.5`. See [Confidence and uncertainty](#confidence-and-uncertainty). |
| `http_client``fetch` | How the request is sent. See [Timeouts and connections](#timeouts-and-connections). |

See the API reference for [Python](/docs/api/python/strands.decisions.decisions_api_decision_model#strands.decisions.decisions_api_decision_model.DecisionsAPIDecisionModel.__init__) or [TypeScript](/docs/api/typescript/DecisionsAPIDecisionModelOptions/index.md) for all constructor options.

## Ask questions

This example asks two questions about a support message and prints each answer with its confidence:

(( tab "Python" ))
```python
import asyncio

from strands.decisions import DecisionsAPIDecisionModel

message = "I was charged twice for order 1182. Please refund one charge today."


async def main():
    decisions = DecisionsAPIDecisionModel()
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
    confidence = result.metadata.confidence
    print(result.answers["urgent"], f"{confidence['urgent']:.2f}")
    print(result.answers["team"], f"{confidence['team']:.2f}")
    print(result.metadata.model_id)


asyncio.run(main())

# Typical output:
# True 0.90
# billing 1.00
# ~typesafe/jev-latest
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { DecisionsAPIDecisionModel } from '@strands-agents/sdk'

const message = 'I was charged twice for order 1182. Please refund one charge today.'

const decisions = new DecisionsAPIDecisionModel()
const { answers, metadata } = await decisions.ask(message, {
  urgent: {
    question: 'Does the customer need help today?',
    choices: 'boolean',
  },
  team: {
    question: 'Which team should handle this message?',
    choices: ['billing', 'shipping', 'technical'],
  },
})
console.log(answers.urgent, metadata.confidence?.urgent.toFixed(2))
console.log(answers.team, metadata.confidence?.team.toFixed(2))
console.log(metadata.modelId)

// Typical output:
// true 0.90
// billing 1.00
// ~typesafe/jev-latest
```
(( /tab "TypeScript" ))

Decisions API doesn’t say which model version answered, so the result reports the model you requested, such as `~typesafe/jev-latest`, unless the response names one. When you need to trace each decision to a model version, use [`TypeSafeDecisionModel`](/docs/user-guide/sdk/decision-models/models/typesafe/index.md).

Decisions API accepts at most eight questions per call. Split a larger set across several `ask` calls.

## Confidence and uncertainty

The model reports a confidence for every answer. An answer below the minimum comes back as `Uncertain`, and `metadata.confidence` and `metadata.probabilities` still show what the model leaned toward. [Confidence](/docs/user-guide/sdk/decision-models/questions/index.md#confidence) explains how it’s measured.

The default minimum of 0.5 suits most routing and triage questions. For a question where a wrong answer costs more than asking a person, raise the minimum on that question alone: set its `uncertainty` to `{"min_confidence": 0.8}``{ minConfidence: 0.8 }`.

## Timeouts and connections

(( tab "Python" ))
With no client configured, each call opens an `httpx.AsyncClient` with a 30-second timeout, which httpx applies to each phase, such as connecting or reading. Pass your own client to reuse connections across decisions, change the timeout, or add headers. You own the client, so close it when you’re done:

```python
import asyncio

import httpx

from strands.decisions import DecisionsAPIDecisionModel

messages = ["My package never arrived.", "The app crashes when I log in."]


async def main():
    # Reuse one connection pool, and give up if connecting or any read takes over
    # five seconds
    async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
        decisions = DecisionsAPIDecisionModel(http_client=client)
        for message in messages:
            result = await decisions.ask(
                message,
                {
                    "team": {
                        "question": "Which team should handle this message?",
                        "choices": ["billing", "shipping", "technical"],
                    },
                },
            )
            print(result.answers["team"])


asyncio.run(main())

# Typical output:
# shipping
# technical
```
(( /tab "Python" ))

(( tab "TypeScript" ))
The decision model sends the request with the global `fetch` and sets no timeout of its own. Pass a `cancelSignal` to `ask` to bound how long a decision can take:

```typescript
import { DecisionsAPIDecisionModel } from '@strands-agents/sdk'

const decisions = new DecisionsAPIDecisionModel()
const { answers } = await decisions.ask(
  'My package never arrived.',
  {
    team: {
      question: 'Which team should handle this message?',
      choices: ['billing', 'shipping', 'technical'],
    },
  },
  // Give up on the decision after five seconds
  { cancelSignal: AbortSignal.timeout(5000) }
)
console.log(answers.team)

// Typical output:
// shipping
```

To route requests through a proxy or change how they’re sent, pass your own `fetch` implementation to the constructor.
(( /tab "TypeScript" ))

## Errors

Beyond the [validation errors](/docs/user-guide/sdk/decision-models/questions/index.md#validation), `ask` raises:

| Error | When |
| --- | --- |
| `ModelThrottledException``ModelThrottledError` | Decisions API is throttling or temporarily unavailable (HTTP 429, 503, or 529). Retry with backoff. |
| `ContextWindowOverflowException``ContextWindowOverflowError` | The request is too large (HTTP 413). Shorten the input, such as by sending only the latest messages of a conversation. |
| `httpx.HTTPStatusError``ModelError` | Any other non-2xx response, such as HTTP 401 for an invalid API key. |
| `httpx.TransportError``ModelError` | The request didn't complete, because of a network failure or a timeout.The request failed before the response arrived, because of a network failure or a timeout. A failure after that raises the underlying error. |
| `StructuredOutputException``ModelError` | Decisions API returned a response the decision model can’t read, or reported an error inside a successful response. |
| `ValueError``Error` | The request has more than eight questions. |

Decisions API can report a failure inside an HTTP 200 response, as a non-zero error `code` with a message. The decision model raises it with both, rather than returning a result with no answers.

The throttling and context window errors keep the HTTP failure as their cause.

Read its status code from the cause's response.Both extend ModelError, so check for them before you check for ModelError.

## Related pages

- [Decision models](/docs/user-guide/sdk/decision-models/index.md) (1 shared tag)
- [Decisions in an agent](/docs/user-guide/sdk/decision-models/agents/index.md) (1 shared tag)
- [LLM decision model](/docs/user-guide/sdk/decision-models/models/llm/index.md) (1 shared tag)
- [Questions and answers](/docs/user-guide/sdk/decision-models/questions/index.md) (1 shared tag)
- [Supported decision models](/docs/user-guide/sdk/decision-models/models/index.md) (1 shared tag)
- [TypeSafe Jev](/docs/user-guide/sdk/decision-models/models/typesafe/index.md) (1 shared tag)
- [Amazon SageMaker AI](/docs/user-guide/sdk/decision-models/models/sagemaker/index.md) (1 shared tag)
- [Model Routing](/docs/user-guide/sdk/model-providers/model-routing/index.md) (1 shared tag)
- [Decision model observability](/docs/user-guide/sdk/decision-models/observability/index.md) (1 shared tag)
- [Decision models quickstart](/docs/user-guide/sdk/decision-models/quickstart/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/decisions/decisions_api_decision_model.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/decisions_api_decision_model.py)
- [harness-sdk/strands-py/src/strands/decisions/_system_one_http_adapter.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/_system_one_http_adapter.py)

### TypeScript

- [harness-sdk/strands-ts/src/decisions/decisions-api-decision-model.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/decisions-api-decision-model.ts)
- [harness-sdk/strands-ts/src/decisions/system-one-http-adapter.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/system-one-http-adapter.ts)

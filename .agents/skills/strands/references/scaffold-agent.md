# Scaffold a Strands agent

Start by identifying:

- Python or TypeScript
- Strands harness or the lower-level SDK
- model provider and credential source
- required tools, persistence, and deployment target

Prefer the harness for a general-purpose agent. Prefer the SDK for an application-specific agent or when the user needs direct control of the loop.

## Python

Python requires 3.10 or newer.

### Harness

Install `strands-harness`, then create the smallest runnable entrypoint:

```python
from strands_harness import create_harness

agent = create_harness()
result = agent("Summarize this repository and identify its test command.")
print(result)
```

### SDK

Install `strands-agents`. Amazon Bedrock is the default provider:

```python
from strands import Agent

agent = Agent()
result = agent("Summarize this repository and identify its test command.")
print(result)
```

For the direct Anthropic API, install the `anthropic` extra and use the current model ID selected by the user or official documentation:

```python
import os

from strands import Agent
from strands.models.anthropic import AnthropicModel

model_id = os.environ["ANTHROPIC_MODEL_ID"]
model = AnthropicModel(model_id=model_id, max_tokens=4096)
agent = Agent(model=model)
result = agent("Summarize this repository and identify its test command.")
print(result)
```

## TypeScript

TypeScript requires Node.js 22 or newer.

### Harness

Install `@strands-agents/harness`, then create the smallest runnable entrypoint:

```typescript
import { createHarness } from '@strands-agents/harness'

const agent = await createHarness()
const result = await agent.invoke(
  'Summarize this repository and identify its test command.'
)
console.log(result.lastMessage)
```

### SDK

Install `@strands-agents/sdk`. Amazon Bedrock is the default provider:

```typescript
import { Agent } from '@strands-agents/sdk'

const agent = new Agent()
const result = await agent.invoke(
  'Summarize this repository and identify its test command.'
)
console.log(result.lastMessage)
```

For the direct Anthropic API, install `@anthropic-ai/sdk` and use the current model ID selected by the user or official documentation:

```typescript
import { Agent } from '@strands-agents/sdk'
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic'

const modelId = process.env.ANTHROPIC_MODEL_ID
if (!modelId) {
  throw new Error('Set ANTHROPIC_MODEL_ID')
}

const model = new AnthropicModel({ modelId })
const agent = new Agent({ model })
const result = await agent.invoke(
  'Summarize this repository and identify its test command.'
)
console.log(result.lastMessage)
```

## Finish the scaffold

Add only what the requested behavior needs. Then:

1. run the entrypoint;
2. confirm credentials come from the environment or the provider's standard credential chain;
3. confirm the result object is handled rather than discarded;
4. add lifecycle limits before unattended or autonomous execution;
5. document any model call that could not be exercised locally.

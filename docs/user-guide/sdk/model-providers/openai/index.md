[OpenAI](https://platform.openai.com/docs/overview) is an AI research and deployment company that provides a range of language models. The Strands Agents SDK implements an OpenAI provider, letting you run agents against any OpenAI or OpenAI-compatible model.

## Installation

OpenAI is configured as an optional dependency in Strands Agents. To install, run:

(( tab "Python" ))
```bash
pip install 'strands-agents[openai]'
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```bash
npm install @strands-agents/sdk openai
```
(( /tab "TypeScript" ))

## Usage

After installing dependencies, you can import and initialize the Strands Agents’ OpenAI provider as follows:

(( tab "Python" ))
```python
from strands import Agent
from strands.models.openai import OpenAIModel
from strands.vended_tools import notebook

model = OpenAIModel(
    client_args={
        "api_key": "<KEY>",
    },
    # **model_config
    model_id="gpt-4o",
    params={
        "max_tokens": 1000,
        "temperature": 0.7,
    }
)

agent = Agent(model=model, tools=[notebook])
response = agent('Create a notebook named "ideas" and add three project ideas.')
print(response)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'

const model = new OpenAIModel({
  api: 'chat',
  apiKey: process.env.OPENAI_API_KEY || '<KEY>',
  modelId: 'gpt-5.4',
  maxTokens: 1000,
  temperature: 0.7,
})

const agent = new Agent({ model })
const response = await agent.invoke('What is 2+2')
console.log(response)
```
(( /tab "TypeScript" ))

To connect to a custom OpenAI-compatible server:

(( tab "Python" ))
```python
model = OpenAIModel(
    client_args={
      "api_key": "<KEY>",
      "base_url": "<URL>",
    },
    ...
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const model = new OpenAIModel({
  api: 'chat',
  apiKey: '<KEY>',
  clientConfig: {
    baseURL: '<URL>',
  },
  modelId: 'gpt-5.4',
})

const agent = new Agent({ model })
const response = await agent.invoke('Hello!')
```
(( /tab "TypeScript" ))

Guides for specific OpenAI-compatible services, such as [OpenRouter](/docs/integrations/model-providers/openrouter/index.md) and [Fireworks AI](/docs/integrations/model-providers/fireworksai/index.md), are in the [integrations](/integrations/index.md) section.

## Configuration

### Client Configuration

(( tab "Python" ))
The `client_args` configure the underlying OpenAI client. For a complete list of available arguments, please refer to the OpenAI [source](https://github.com/openai/openai-python).
(( /tab "Python" ))

(( tab "TypeScript" ))
The `clientConfig` configures the underlying OpenAI client. For a complete list of available options, please refer to the [OpenAI TypeScript documentation](https://github.com/openai/openai-node).
(( /tab "TypeScript" ))

### Model Configuration

The model configuration sets parameters for inference:

(( tab "Python" ))
| Parameter | Description | Example | Options |
| --- | --- | --- | --- |
| `model_id` | ID of a model to use | `gpt-4o` | [reference](https://platform.openai.com/docs/models) |
| `params` | Model specific parameters | `{"max_tokens": 1000, "temperature": 0.7}` | [reference](https://platform.openai.com/docs/api-reference/chat/create) |
(( /tab "Python" ))

(( tab "TypeScript" ))
| Parameter | Description | Example | Options |
| --- | --- | --- | --- |
| `modelId` | ID of a model to use | `gpt-5.4` | [reference](https://platform.openai.com/docs/models) |
| `maxTokens` | Maximum tokens to generate | `1000` | [reference](https://platform.openai.com/docs/api-reference/chat/create) |
| `temperature` | Controls randomness (0-2) | `0.7` | [reference](https://platform.openai.com/docs/api-reference/chat/create) |
| `topP` | Nucleus sampling (0-1) | `0.9` | [reference](https://platform.openai.com/docs/api-reference/chat/create) |
| `frequencyPenalty` | Reduces repetition (-2.0 to 2.0) | `0.5` | [reference](https://platform.openai.com/docs/api-reference/chat/create) |
| `presencePenalty` | Encourages new topics (-2.0 to 2.0) | `0.5` | [reference](https://platform.openai.com/docs/api-reference/chat/create) |
| `params` | Additional parameters not listed above | `{ stop: ["END"] }` | [reference](https://platform.openai.com/docs/api-reference/chat/create) |
(( /tab "TypeScript" ))

## Troubleshooting

(( tab "Python" ))
**Module Not Found**

If you encounter the error `ModuleNotFoundError: No module named 'openai'`, this means you haven’t installed the `openai` dependency in your environment. To fix, run `pip install 'strands-agents[openai]'`.

**GPT-OSS Tool Calling Fails on Non-Managed Endpoints**

If you are running GPT-OSS on an endpoint that isn’t a managed inference provider and you see errors like `Unexpected token ... while expecting start token ...` during tool calling, your endpoint likely doesn’t have the correct stop tokens configured.

As an immediate workaround, pass the GPT-OSS stop sequences explicitly via `params`:

```python
model = OpenAIModel(
    client_args={
        "api_key": "<KEY>",
        "base_url": "http://localhost:8000/v1",
    },
    model_id="<MODEL_ID>",
    params={"stop": ["<|call|>", "<|return|>", "<|end|>"]}
)
```

See the [OpenAI Harmony message format](https://cookbook.openai.com/articles/openai-harmony#message-format) for details on GPT-OSS stop tokens.

**Tools with GPT-5.6 and GPT-6 Models**

OpenAI’s Chat Completions API accepts tools for GPT-5.6 and GPT-6 models only with reasoning off, and for some of them (such as `gpt-6-astra` and `gpt-6.1-sol`) not at all. When the client targets `api.openai.com` or Amazon Bedrock Mantle, `OpenAIModel` therefore sends `reasoning_effort="none"`, with a warning, when an agent with tools runs on the first group and `params` sets no `reasoning_effort`. A `reasoning_effort` you set is sent as it is, so OpenAI rejects any value but `"none"`. For the second group, OpenAI rejects every request with tools, and the error `OpenAIModel` raises says so. To use tools on the second group, or tools with reasoning on the first, use `OpenAIResponsesModel`. Requests to other OpenAI-compatible endpoints are sent as configured.
(( /tab "Python" ))

(( tab "TypeScript" ))
**Authentication Errors**

If you encounter authentication errors, ensure your OpenAI API key is properly configured. Set the `OPENAI_API_KEY` environment variable or pass it via the `apiKey` parameter in the model configuration.

**GPT-OSS Tool Calling Fails on Non-Managed Endpoints**

If you are running GPT-OSS on an endpoint that isn’t a managed inference provider and you see errors like `Unexpected token ... while expecting start token ...` during tool calling, your endpoint likely doesn’t have the correct stop tokens configured.

As an immediate workaround, pass the GPT-OSS stop sequences explicitly via `params`:

```typescript
import { OpenAIModel } from '@strands-agents/sdk/models/openai'

const model = new OpenAIModel({
  api: 'chat',
  apiKey: '<KEY>',
  clientConfig: {
    baseURL: 'http://localhost:8000/v1',
  },
  modelId: '<MODEL_ID>',
  params: { stop: ['<|call|>', '<|return|>', '<|end|>'] },
})
```

See the [OpenAI Harmony message format](https://cookbook.openai.com/articles/openai-harmony#message-format) for details on GPT-OSS stop tokens.

**Tools with GPT-5.6 and GPT-6 Models**

OpenAI’s Chat Completions API accepts tools for GPT-5.6 and GPT-6 models only with reasoning off, and for some of them (such as `gpt-6-astra` and `gpt-6.1-sol`) not at all. With `api: 'chat'` and a client that targets `api.openai.com` or Amazon Bedrock Mantle, `OpenAIModel` therefore sends `reasoning_effort: 'none'`, with a warning, when an agent with tools runs on the first group and `params` sets no `reasoning_effort`. A `reasoning_effort` you set is sent as it is, so OpenAI rejects any value but `'none'`. For the second group, OpenAI rejects every request with tools, and the error `OpenAIModel` throws says so. To use tools on the second group, or tools with reasoning on the first, use the default `api: 'responses'`. Requests to other OpenAI-compatible endpoints are sent as configured.
(( /tab "TypeScript" ))

## Advanced Features

### Structured Output

OpenAI models support structured output through their native tool calling capabilities. Pass a schema to the agent, and Strands converts it to OpenAI’s function calling format and validates the response.

(( tab "Python" ))
Define a Pydantic model and pass it to `agent.structured_output()`:

```python
from pydantic import BaseModel, Field
from strands import Agent
from strands.models.openai import OpenAIModel

class PersonInfo(BaseModel):
    """Extract person information from text."""
    name: str = Field(description="Full name of the person")
    age: int = Field(description="Age in years")
    occupation: str = Field(description="Job or profession")

model = OpenAIModel(
    client_args={"api_key": "<KEY>"},
    model_id="gpt-4o",
)

agent = Agent(model=model)

result = agent.structured_output(
    PersonInfo,
    "John Smith is a 30-year-old software engineer working at a tech startup."
)

print(f"Name: {result.name}")      # "John Smith"
print(f"Age: {result.age}")        # 30
print(f"Job: {result.occupation}") # "software engineer"
```
(( /tab "Python" ))

(( tab "TypeScript" ))
Define a Zod schema and pass it as `structuredOutputSchema`. Validated output is on `result.structuredOutput`:

```typescript
import { Agent } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { z } from 'zod'

const PersonInfo = z.object({
  name: z.string().describe('Full name of the person'),
  age: z.number().describe('Age in years'),
  occupation: z.string().describe('Job or profession'),
})

const model = new OpenAIModel({
  api: 'chat',
  apiKey: process.env.OPENAI_API_KEY || '<KEY>',
  modelId: 'gpt-4o',
})

const agent = new Agent({ model, structuredOutputSchema: PersonInfo })

const result = await agent.invoke(
  'John Smith is a 30-year-old software engineer working at a tech startup.'
)

const person = result.structuredOutput as z.infer<typeof PersonInfo>
console.log(`Name: ${person.name}`) // "John Smith"
console.log(`Age: ${person.age}`) // 30
console.log(`Job: ${person.occupation}`) // "software engineer"
```
(( /tab "TypeScript" ))

For schema patterns, error handling, and per-invocation overrides, see [Structured Output](/docs/user-guide/sdk/agents/structured-output/index.md).

### Custom client

You can pass your own OpenAI client to the OpenAIModel for Strands Agents to use directly. You are responsible for handling the lifecycle (e.g., closing) of the client.

(( tab "Python" ))
```python
from strands import Agent
from strands.models.openai import OpenAIModel
from openai import AsyncOpenAI

client = AsyncOpenAI(
    api_key= "<KEY>",
)

agent = Agent(
    model = OpenAIModel(
        model_id="gpt-4o-mini-2024-07-18",
        client=client
    )
)

async def chat(prompt: str):
    result = await agent.invoke_async(prompt)
    print(result)

async def main():
    await chat("What is 2+2")
    await chat("What is 2*2")
    # close the client
    client.close()

if __name__ == "__main__":
    asyncio.run(main())
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import OpenAI from 'openai'
import { Agent } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '<KEY>',
})

const model = new OpenAIModel({
  api: 'chat',
  client,
  modelId: 'gpt-5.4',
})

const agent = new Agent({ model })
const response = await agent.invoke('What is 2+2?')
console.log(response)
```
(( /tab "TypeScript" ))

## References

-   [Migrate from OpenAI to Strands](/docs/user-guide/migrate/openai/index.md) — move a hand-written `chat.completions` loop or an OpenAI Agents SDK app to Strands
-   [Python API](/docs/api/python/strands.models.model)
-   [OpenAI](https://platform.openai.com/docs/overview)

## Related pages

- [Writer](/docs/user-guide/sdk/model-providers/writer/index.md) (2 shared tags)
- [LiteLLM](/docs/user-guide/sdk/model-providers/litellm/index.md) (1 shared tag)
- [Return structured output](/docs/user-guide/sdk/agents/structured-output/index.md) (1 shared tag)
- [Structured output similarity evaluator](/docs/user-guide/evals-sdk/evaluators/structured_output_evaluator/index.md) (1 shared tag)
- [Google](/docs/user-guide/sdk/model-providers/google/index.md) (1 shared tag)
- [Vercel](/docs/user-guide/sdk/model-providers/vercel/index.md) (1 shared tag)
- [Structured output](/docs/user-guide/sdk/agents/structured-output-behavior/index.md) (1 shared tag)
- [Anthropic](/docs/user-guide/sdk/model-providers/anthropic/index.md) (1 shared tag)
- [Multimodal correctness evaluator](/docs/user-guide/evals-sdk/evaluators/multimodal_correctness_evaluator/index.md) (1 shared tag)
- [Multimodal faithfulness evaluator](/docs/user-guide/evals-sdk/evaluators/multimodal_faithfulness_evaluator/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/models/openai.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/openai.py)

### TypeScript

- [harness-sdk/strands-ts/src/models/openai/model.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/openai/model.ts)

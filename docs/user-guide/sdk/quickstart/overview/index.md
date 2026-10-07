The Strands Agents SDK empowers developers to quickly build, manage, evaluate and deploy AI-powered agents. These quick start guides get you set up and running a simple agent in less than 20 minutes.

[Python Quickstart](../python/index.md)Create your first Python Strands agent with full feature access!

[TypeScript Quickstart](../typescript/index.md)Create your first TypeScript Strands agent!

---

## A library, not a platform

Strands runs inside your own process. Creating an agent is constructing an object in Python or Node.js: there is no hosted control plane, scheduler, or database to stand up first. Any [model provider](/docs/user-guide/sdk/model-providers/index.md) works. Amazon Bedrock is the default, and swapping in Anthropic, OpenAI, Gemini, or Ollama is a one-line change, so an AWS account is only required if you keep the default. Adding an agent to an existing FastAPI, Express, or Next.js app is a dependency and a few lines of code, not new infrastructure.

Here is the whole of it: one file that answers HTTP requests with a Strands agent. The route handler constructs an agent and calls it. The only service it reaches is the model provider.

(( tab "Python" ))
```python
from fastapi import FastAPI
from pydantic import BaseModel
from strands import Agent

app = FastAPI()


class ChatRequest(BaseModel):
    prompt: str


@app.post("/chat")
def chat(request: ChatRequest) -> dict[str, str]:
    # The agent lives in this process: no scheduler or database to reach.
    agent = Agent()
    result = agent(request.prompt)
    return {"reply": str(result)}
```

Run it with `uvicorn main:app`.
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import express, { type Request, type Response } from 'express'

const app = express()
app.use(express.json())

app.post('/chat', async (req: Request, res: Response) => {
  // The agent lives in this process: no scheduler or database to reach.
  const agent = new Agent()
  const result = await agent.invoke(req.body.prompt)
  res.json({ reply: result.lastMessage })
})

app.listen(3000)
```

Run it with `tsx server.ts`.
(( /tab "TypeScript" ))

## Use any model provider

The model is one object you hand to the agent. Amazon Bedrock is the default, and every other provider is a one-line swap; the rest of your agent code does not change.

(( tab "Python" ))
(( tab "Amazon Bedrock" ))
```python
from strands import Agent

# Amazon Bedrock is the default, so no model object is required.
agent = Agent()
print(agent("What can you help me build?"))
```
(( /tab "Amazon Bedrock" ))

(( tab "Anthropic" ))
```python
from strands import Agent
from strands.models.anthropic import AnthropicModel

agent = Agent(model=AnthropicModel(client_args={"api_key": "<KEY>"}, model_id="claude-sonnet-5"))
print(agent("What can you help me build?"))
```
(( /tab "Anthropic" ))

(( tab "OpenAI" ))
```python
from strands import Agent
from strands.models.openai import OpenAIModel

agent = Agent(model=OpenAIModel(client_args={"api_key": "<KEY>"}, model_id="gpt-5.4"))
print(agent("What can you help me build?"))
```
(( /tab "OpenAI" ))

(( tab "Google" ))
```python
from strands import Agent
from strands.models.gemini import GeminiModel

agent = Agent(model=GeminiModel(client_args={"api_key": "<KEY>"}, model_id="gemini-2.5-flash"))
print(agent("What can you help me build?"))
```
(( /tab "Google" ))

(( tab "Ollama" ))
```python
from strands import Agent
from strands.models.ollama import OllamaModel

agent = Agent(model=OllamaModel(host="http://localhost:11434", model_id="llama3.1"))
print(agent("What can you help me build?"))
```
(( /tab "Ollama" ))
(( /tab "Python" ))

(( tab "TypeScript" ))
(( tab "Amazon Bedrock" ))
```typescript
import { Agent } from '@strands-agents/sdk'

// Amazon Bedrock is the default, so no model object is required.
const agent = new Agent()
const result = await agent.invoke('What can you help me build?')
console.log(result.lastMessage)
```
(( /tab "Amazon Bedrock" ))

(( tab "Anthropic" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic'

const agent = new Agent({
  model: new AnthropicModel({ apiKey: '<KEY>', modelId: 'claude-sonnet-5' }),
})
const result = await agent.invoke('What can you help me build?')
console.log(result.lastMessage)
```
(( /tab "Anthropic" ))

(( tab "OpenAI" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'

const agent = new Agent({
  model: new OpenAIModel({ apiKey: '<KEY>', modelId: 'gpt-5.4' }),
})
const result = await agent.invoke('What can you help me build?')
console.log(result.lastMessage)
```
(( /tab "OpenAI" ))

(( tab "Google" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { GoogleModel } from '@strands-agents/sdk/models/google'

const agent = new Agent({
  model: new GoogleModel({ apiKey: '<KEY>', modelId: 'gemini-2.5-flash' }),
})
const result = await agent.invoke('What can you help me build?')
console.log(result.lastMessage)
```
(( /tab "Google" ))

Ollama runs in the Python SDK only.
(( /tab "TypeScript" ))

See [model providers](/docs/user-guide/sdk/model-providers/index.md) for the full list and per-provider configuration.

## Strands harness or the Strands Harness SDK?

Strands gives you two starting points, and you can move between them without a rewrite.

| If you want to… | Start with | Why |
| --- | --- | --- |
| Get a complete agent harness with tested defaults, in one import | [Strands harness](/docs/user-guide/harness/index.md) | Model, tools, memory, context management, and a production loop are already wired together. |
| Build the agent yourself and customize every part of the loop | [SDK](/docs/user-guide/sdk/index.md) | You define the tools, model, memory, and control flow, and the Strands Harness SDK runs the loop. |
| Start on Strands harness and drop down for more control later | [Compose with the Strands Harness SDK](/docs/user-guide/harness/composing-with-sdk/index.md) | Strands harness is built on the Strands Harness SDK, so you can change any piece of it without a rewrite. |

Weighing Strands against other frameworks or a hand-written loop instead? See [choosing an agent foundation](/docs/user-guide/migrate/choosing-an-agent-foundation/index.md).

## Language support

Strands Agents SDK is available in both Python and TypeScript.

### Feature availability

The table below compares feature availability between the Python and TypeScript SDKs.

| Category | Feature | Python | TypeScript |
| --- | --- | --- | --- |
| **Core** | [Agent creation and invocation](/docs/user-guide/sdk/agents/agent-loop/index.md) | ✅ | ✅ |
|  | [Streaming responses](/docs/user-guide/sdk/streaming/index.md) | ✅ | ✅ |
|  | [Structured output](/docs/user-guide/sdk/agents/structured-output/index.md) | ✅ | ✅ |
| **Model providers** | [Amazon Bedrock](/docs/user-guide/sdk/model-providers/amazon-bedrock/index.md) | ✅ | ✅ |
|  | [OpenAI](/docs/user-guide/sdk/model-providers/openai/index.md) | ✅ | ✅ |
|  | [OpenAI Responses API](/docs/user-guide/sdk/model-providers/openai-responses/index.md) | ✅ | ✅ |
|  | [Anthropic](/docs/user-guide/sdk/model-providers/anthropic/index.md) | ✅ | ✅ |
|  | [Google](/docs/user-guide/sdk/model-providers/google/index.md) | ✅ | ✅ |
|  | [Ollama](/docs/user-guide/sdk/model-providers/ollama/index.md) | ✅ | ❌ |
|  | [LiteLLM](/docs/user-guide/sdk/model-providers/litellm/index.md) | ✅ | ❌ |
|  | [Custom providers](/docs/user-guide/sdk/model-providers/custom_model_provider/index.md) | ✅ | ✅ |
|  | [Additional providers](/docs/user-guide/sdk/model-providers/index.md) | 5+ | 1+ |
| **Tools** | [Custom function tools](/docs/user-guide/sdk/tools/custom-tools/index.md) | ✅ | ✅ |
|  | [MCP (Model Context Protocol)](/docs/user-guide/sdk/tools/mcp-tools/index.md) | ✅ | ✅ |
|  | [Built-in tools](/docs/user-guide/sdk/tools/community-tools-package/index.md) | 30+ via community package | 4 built-in |
| **Conversation** | [Null manager](/docs/user-guide/sdk/agents/conversation-management/index.md) | ✅ | ✅ |
|  | [Sliding window manager](/docs/user-guide/sdk/agents/conversation-management/index.md) | ✅ | ✅ |
|  | [Summarizing manager](/docs/user-guide/sdk/agents/conversation-management/index.md) | ✅ | ✅ |
| **Hooks** | [Lifecycle hooks](/docs/user-guide/sdk/agents/hooks/index.md) | ✅ | ✅ |
|  | [Custom hook providers](/docs/user-guide/sdk/agents/hooks/index.md) | ✅ | ✅ |
| **Multi-agent** | [Swarms](/docs/user-guide/sdk/multi-agent/swarm/index.md) | ✅ | ✅ |
|  | [Graphs](/docs/user-guide/sdk/multi-agent/graph/index.md) | ✅ | ✅ |
|  | [Workflows](/docs/user-guide/sdk/multi-agent/workflow/index.md) | ✅ | ✅ |
|  | [Agents as tools](/docs/user-guide/sdk/multi-agent/agents-as-tools/index.md) | ✅ | ✅ |
|  | [Agent-to-Agent (A2A)](/docs/user-guide/sdk/multi-agent/agent-to-agent/index.md) | ✅ | ✅ |
| **Session management** | [File, S3, repository managers](/docs/user-guide/sdk/agents/session-management/index.md) | ✅ | ✅ |
| **Observability** | [OpenTelemetry integration](/docs/user-guide/sdk/observability-evaluation/observability/index.md) | ✅ | ✅ |
| **Steering** | [Agent steering](/docs/user-guide/sdk/agents/interventions/steering/index.md) | ✅ | ✅ |
| **Voice** | [Bidirectional streaming](/docs/user-guide/sdk/bidi/quickstart/index.md) | ✅ | ❌ |

## Related pages

- [Choosing an Agent Foundation](/docs/user-guide/migrate/choosing-an-agent-foundation/index.md) (1 shared tag)
- [Get started with Strands Box](/docs/user-guide/box/getting-started/index.md) (1 shared tag)
- [Python Quickstart](/docs/user-guide/sdk/quickstart/python/index.md) (1 shared tag)
- [Strands evaluation quickstart](/docs/user-guide/evals-sdk/quickstart/index.md) (1 shared tag)
- [Strands Shell quickstart](/docs/user-guide/shell/quickstart/index.md) (1 shared tag)
- [TypeScript Quickstart](/docs/user-guide/sdk/quickstart/typescript/index.md) (1 shared tag)
- [Red teaming quickstart](/docs/user-guide/evals-sdk/red-teaming/quickstart/index.md) (1 shared tag)
- [Build a Voice Agent](/docs/user-guide/sdk/bidi/quickstart/index.md) (1 shared tag)

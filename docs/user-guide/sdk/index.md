New to Strands?

Start with **[Strands harness](/docs/user-guide/harness/index.md)** for a fully assembled, state-of-the-art agent harness. It’s built on the Strands Harness SDK with opinionated, benchmarked defaults for the system prompt, tools, memory, sessions, and context management, and every default is overridable.

Use the **Strands Harness SDK** when you want to build an agent harness from the ground up, piece by piece.

An agent harness is the software around a model that turns it into an agent. The Strands Harness SDK is for building one yourself, end to end.

It runs the loop and gives you the pieces you attach to it: tools, memory, sessions, plugins, and interventions. The same code takes you from prototype to production.

## A running agent

The smallest agent is a model with the loop around it. Create one and invoke it:

(( tab "Python" ))
```python
from strands import Agent

agent = Agent()
agent("Explain the agent loop in one sentence.")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'

const agent = new Agent()
const result = await agent.invoke('Explain the agent loop in one sentence.')
console.log(result.lastMessage)
```
(( /tab "TypeScript" ))

From here you add the tools, memory, and model provider your application needs, then take it to production.

## Strands harness or the Strands Harness SDK?

Strands gives you two starting points, and you can move between them without a rewrite.

| If you want to… | Start with | Why |
| --- | --- | --- |
| Get a complete agent harness with tested defaults | [Strands harness](/docs/user-guide/harness/index.md) | The decisions are already made: system prompt, tools, memory, sessions, context management, and a production loop come pre-wired and benchmarked. You start from a working agent. |
| Build the agent harness yourself, piece by piece | [Strands Harness SDK quickstart](/docs/user-guide/sdk/quickstart/python/index.md) | Nothing is pre-decided. You get the primitives and the loop, and you choose every component and how they fit. |
| Start on Strands harness and drop down for more control later | [Compose with the Strands Harness SDK](/docs/user-guide/harness/composing-with-sdk/index.md) | Strands harness is built on the Strands Harness SDK, so any piece is yours to swap out without a rewrite. |

Weighing Strands against other frameworks or a hand-written loop instead? See [choosing an agent foundation](/docs/user-guide/migrate/choosing-an-agent-foundation/index.md).

[Quickstart](./quickstart/python/index.md)Walk through installing the Strands Harness SDK, choosing a model provider, and running your first agent in Python or TypeScript.

## Build

[Add tools](./tools/index.md)Give the agent capabilities with community, custom, and MCP tools.

[Give it long-term memory](./memory/overview/index.md)Persist and recall knowledge across sessions.

[Return structured output](./agents/structured-output/index.md)Get typed, schema-validated results back from the agent.

[Choose a multi-agent pattern](./multi-agent/multi-agent-patterns/index.md)Choose agents as tools, a workflow in your code, Graph, or Swarm, and learn when to use the vended graph tool.

## Run

[Deploy to production](./deploy/operating-agents-in-production/index.md)Ship to Lambda, Fargate, EKS, Bedrock AgentCore, and more.

[Observe your agent](./observability-evaluation/observability/index.md)Trace runs, read metrics, and debug behavior.

[Secure for production](./safety-security/guardrails/index.md)Add guardrails, redact PII, and keep message history trusted.

## Where to go next

Building a feature? Each build guide above takes one task end to end. When you need to look up how a piece works, the **Components** section is the reference underneath the guides: the agent loop, models, state, sessions, hooks, plugins, interventions, and voice.
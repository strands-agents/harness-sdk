Give your agent the ability to do things beyond generating text: call an API, read a file, run code, or query a database. You pass tools to an agent, and the agent decides when to call them based on the request. Strands works with tools you write yourself, prebuilt tools the SDK and community ship, and any MCP server.

Tool Security

All tools, whether custom, community-provided, or included in the Strands tools package, execute code on behalf of your agent with the permissions of the host process. Under the shared responsibility model, you should audit each tool’s behavior (file access patterns, network calls, shell execution) and ensure it is appropriate for your deployment environment and threat model. See [Responsible AI](/docs/user-guide/sdk/safety-security/responsible-ai/index.md) for more details.

## Give your agent tools

[Attach and invoke tools](using-tools/index.md)Pass tools to an agent, inspect what is loaded, and invoke them by prompt or directly.

[Create custom tools](custom-tools/index.md)Turn your own functions into tools the agent can call.

[Use MCP tools](mcp-tools/index.md)Connect the agent to any Model Context Protocol server.

[Agents as tools](../multi-agent/agents-as-tools/index.md)Give one agent another agent to call as a specialized tool.

## Prebuilt tools and how they run

[Vended tools](vended-tools/index.md)Ready-made tools included in the SDK for files, HTTP, notebooks, and shell.

[Community tools package](community-tools-package/index.md)Migration guidance from the former community tools package.

[Tool executors](executors/index.md)Control whether multiple tool calls run concurrently or in sequence.

## A running agent with a tool

The smallest useful setup is an agent with a single tool it can decide to call. Define the tool, pass it to the agent, and invoke:

(( tab "Python" ))
```python
from strands import Agent, tool


@tool
def get_weather(city: str) -> str:
    """Get the current weather for a city."""
    return f"It's sunny in {city}."


agent = Agent(tools=[get_weather])
agent("What's the weather in Seattle?")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent, tool } from '@strands-agents/sdk'
import { z } from 'zod'

const getWeather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a city',
  inputSchema: z.object({
    city: z.string().describe('The name of the city'),
  }),
  callback: (input) => `It's sunny in ${input.city}.`,
})

const agent = new Agent({ tools: [getWeather] })
await agent.invoke("What's the weather in Seattle?")
```
(( /tab "TypeScript" ))

The agent reads the tool’s description and decides when to call it. From here you add the tools your application needs and control how they run.

## Where to go next

New to tools? Start with [Attach and invoke tools](/docs/user-guide/sdk/tools/using-tools/index.md) to see how tools load onto an agent and the two ways to call them, then [Create custom tools](/docs/user-guide/sdk/tools/custom-tools/index.md) to build your own.

Bringing in tools that already exist? Reach for [vended tools](/docs/user-guide/sdk/tools/vended-tools/index.md) or the [community tools package](/docs/user-guide/sdk/tools/community-tools-package/index.md), or connect an [MCP server](/docs/user-guide/sdk/tools/mcp-tools/index.md). When a model returns several tool calls at once, [tool executors](/docs/user-guide/sdk/tools/executors/index.md) decide whether they run concurrently or in order.

## Related pages

- [Connect your agent to MCP tools](/docs/user-guide/sdk/tools/mcp-tools/index.md) (2 shared tags)
- [MCP Transports](/docs/user-guide/sdk/tools/mcp-transports/index.md) (2 shared tags)
- [A2A Client](/docs/user-guide/sdk/tools/vended-tools/a2a-client/index.md) (1 shared tag)
- [Attach and invoke tools](/docs/user-guide/sdk/tools/using-tools/index.md) (1 shared tag)
- [Bash / shell](/docs/user-guide/sdk/tools/vended-tools/shell/index.md) (1 shared tag)
- [Community tools package](/docs/user-guide/sdk/tools/community-tools-package/index.md) (1 shared tag)
- [Create custom tools](/docs/user-guide/sdk/tools/custom-tools/index.md) (1 shared tag)
- [Edit](/docs/user-guide/sdk/tools/vended-tools/edit/index.md) (1 shared tag)
- [File editor](/docs/user-guide/sdk/tools/vended-tools/file-editor/index.md) (1 shared tag)
- [Graph](/docs/user-guide/sdk/tools/vended-tools/graph/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/tools/decorator.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/decorator.py)
- [harness-sdk/strands-py/src/strands/tools/registry.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/registry.py)

### TypeScript

- [harness-sdk/strands-ts/src/tools/tool.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/tool.ts)
- [harness-sdk/strands-ts/src/tools/tool-factory.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/tool-factory.ts)

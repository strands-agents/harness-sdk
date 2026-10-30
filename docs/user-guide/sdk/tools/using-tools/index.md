Once you have tools, whether you [wrote them yourself](/docs/user-guide/sdk/tools/custom-tools/index.md), pulled them from an [MCP server](/docs/user-guide/sdk/tools/mcp-tools/index.md), or picked them from a prebuilt package, you attach them to an agent and the agent decides when to call them. This page covers how tools load onto an agent and the two ways to invoke them.

## Adding Tools to Agents

Pass tools to an agent at initialization or add them at runtime. Once loaded, the agent can call them in response to user requests:

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import http_request, notebook

# Add tools to our agent
agent = Agent(tools=[http_request, notebook])

# Agent will automatically determine when to use the notebook tool
agent('Create a notebook named "ideas" and add three project ideas.')

print("\n\n")  # Print new lines

# Agent will use the HTTP request tool when appropriate
agent("Get https://example.com and summarize the response status.")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const agent = new Agent({
  tools: [fileEditor],
})

// Agent will use the file_editor tool when appropriate
await agent.invoke('Show me the contents of a single file in this directory')
```
(( /tab "TypeScript" ))

We can see which tools are loaded in our agent:

(( tab "Python" ))
Access `agent.tool_names` for a list of tool names, and `agent.tool_registry.get_all_tools_config()` for a JSON representation including descriptions and input parameters:

```python
print(agent.tool_names)

print(agent.tool_registry.get_all_tools_config())
```
(( /tab "Python" ))

(( tab "TypeScript" ))
Access the tools array directly:

```typescript
// Access all tools
console.log(agent.tools)
```
(( /tab "TypeScript" ))

## Loading Tools from Files

(( tab "Python" ))
Load tools from a file by passing its path at initialization:

```python
agent = Agent(tools=["/path/to/my_tool.py"])
```
(( /tab "Python" ))

(( tab "TypeScript" ))
Loading tools from a file path is available in the Python SDK.
(( /tab "TypeScript" ))

### Auto-loading and reloading tools

(( tab "Python" ))
Tools placed in your current working directory `./tools/` can be automatically loaded at agent initialization, and automatically reloaded when modified. This helps when developing and debugging tools: modify the tool code and any agent using it reloads the latest version.

Automatic loading and reloading of tools in the `./tools/` directory is disabled by default. To enable this behavior, set `load_tools_from_directory=True` during `Agent` initialization:

```python
from strands import Agent

agent = Agent(load_tools_from_directory=True)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
Automatic loading and reloading from a directory is available in the Python SDK.
(( /tab "TypeScript" ))

Tool Loading Implications

When enabling automatic tool loading, any Python file placed in the `./tools/` directory will be executed by the agent. Under the shared responsibility model, it is your responsibility to ensure that only safe, trusted code is written to the tool loading directory, as the agent will automatically pick up and execute any tools found there.

## Using Tools

You can invoke tools in two ways.

Agents have context about tool calls and their results as part of conversation history. See [Using State in Tools](/docs/user-guide/sdk/agents/state/index.md#using-state-in-tools) for more information.

### Natural Language Invocation

The most common way agents use tools is through natural language requests. The agent determines when and how to invoke tools based on the user’s input:

(( tab "Python" ))
```python
# Agent decides when to use tools based on the request
agent('Read the "ideas" notebook.')
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const agent = new Agent({
  tools: [notebook],
})

// Agent decides when to use tools based on the request
await agent.invoke('Please read the default notebook')
```
(( /tab "TypeScript" ))

### Direct Method Calls

Tools can be invoked programmatically in addition to natural language invocation.

(( tab "Python" ))
Every tool added to an agent becomes a method accessible directly on the agent object:

```python
# Directly invoke a tool as a method
result = agent.tool.notebook(mode="read", name="ideas")
```

When calling tools directly as methods, always use keyword arguments. Positional arguments are not supported:

```python
# Positional arguments are not supported, this raises an error
result = agent.tool.notebook("read", "ideas")
```

If a tool name contains hyphens, you can invoke the tool using underscores instead:

```python
# Directly invoke a tool named "read-all"
result = agent.tool.read_all(path="/path/to/file.txt")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
Every tool added to an agent is accessible as a method on `agent.tool`. Call `.invoke(input)` for the result, or `.stream(input)` to consume intermediate events:

```typescript
import { Agent } from '@strands-agents/sdk'
import { notebook } from '@strands-agents/sdk/vended-tools/notebook'

const agent = new Agent({
  tools: [notebook],
})

// Call a tool by name. Returns a ToolResultBlock with `status`
// ('success' | 'error') and `content` blocks.
const result = await agent.tool.notebook!.invoke({
  mode: 'read',
  name: 'default',
})
console.log(result.status, result.content)

// Stream intermediate events; the generator returns the final result.
for await (const event of agent.tool.notebook!.stream({
  mode: 'read',
  name: 'default',
})) {
  console.log('progress:', event)
}

// Skip recording the call in conversation history.
await agent.tool.notebook!.invoke(
  { mode: 'read', name: 'default' },
  { recordDirectToolCall: false }
)
```

Note `agent.tool` (singular) is the direct-call accessor; `agent.tools` (plural) is the array of registered tools.

The accessor resolves names by exact match first, then with underscores substituted for hyphens, then case-insensitively. `agent.tool.read_all` resolves to a tool registered as `read-all`. Calling a name that doesn’t resolve throws `ToolNotFoundError`.

By default, direct calls are recorded in the agent’s message history. Pass `{ recordDirectToolCall: false }` to skip recording. This is required when calling tools during an active agent invocation (otherwise `ConcurrentInvocationError` is thrown), and useful for side-effect tools whose output should stay out of conversation context.
(( /tab "TypeScript" ))

When a model returns several tool requests at once, a [tool executor](/docs/user-guide/sdk/tools/executors/index.md) controls whether they run concurrently (the default) or sequentially.

## Related pages

- [A2A Client](/docs/user-guide/sdk/tools/vended-tools/a2a-client/index.md) (1 shared tag)
- [Bash / shell](/docs/user-guide/sdk/tools/vended-tools/shell/index.md) (1 shared tag)
- [Community tools package](/docs/user-guide/sdk/tools/community-tools-package/index.md) (1 shared tag)
- [Create custom tools](/docs/user-guide/sdk/tools/custom-tools/index.md) (1 shared tag)
- [Edit](/docs/user-guide/sdk/tools/vended-tools/edit/index.md) (1 shared tag)
- [File editor](/docs/user-guide/sdk/tools/vended-tools/file-editor/index.md) (1 shared tag)
- [Graph](/docs/user-guide/sdk/tools/vended-tools/graph/index.md) (1 shared tag)
- [Handoff to User](/docs/user-guide/sdk/tools/vended-tools/handoff-to-user/index.md) (1 shared tag)
- [HTTP request](/docs/user-guide/sdk/tools/vended-tools/http-request/index.md) (1 shared tag)
- [MCP Router](/docs/user-guide/sdk/tools/vended-tools/mcp-router/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/tools/registry.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/registry.py)

### TypeScript

- [harness-sdk/strands-ts/src/tools/tool.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/tool.ts)
- [harness-sdk/strands-ts/src/tools/tool-factory.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/tool-factory.ts)

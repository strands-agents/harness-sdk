A subagent is an agent the main agent can call like a tool. Delegating a self-contained subtask keeps its intermediate work out of the main conversation: only the subagent’s final answer comes back. Strands harness gives you two ways to add one, your own specialist agents and a built-in general-purpose delegate.

## Add your own specialist agents

Pass `tools` your own `Agent` instances wrapped with `as_tool()` / `asTool()`. Each is a tool named after the agent’s `name`, so give each a clear name and description that tells the model when to reach for it:

(( tab "Python" ))
```python
from strands import Agent
from strands_harness import create_harness

researcher = Agent(
    name="researcher",
    description="Researches a topic and returns a concise, sourced summary.",
    system_prompt="Research the given topic and return a concise, sourced summary.",
)
agent = create_harness(tools=[researcher.as_tool()])
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { createHarness } from '@strands-agents/harness'

const researcher = new Agent({
  name: 'researcher',
  description: 'Researches a topic and returns a concise, sourced summary.',
  systemPrompt: 'Research the given topic and return a concise, sourced summary.',
})
const agent = await createHarness({ tools: [researcher.asTool()] })
```
(( /tab "TypeScript" ))

Each call runs from the subagent’s construction-time baseline, a fresh conversation, so a specialist does not accumulate state between calls. The subagent’s name must be unique across the tool set, the same rule as any tool.

## The built-in generalist

Strands harness enables one built-in subagent, `generalist`, exposed to the agent as a tool. It is a full Strands harness agent that inherits the parent’s configuration (model, thinking, caching, context management, built-in tools, plugins, subagents, interventions, and sandbox) but runs with a generic role prompt instead of your `instructions`. By default it starts from a blank conversation, so the model must put everything the subtask needs into the call (it can opt into sharing the parent’s history with the `context` parameter), and it returns a single self-contained answer. It keeps every MCP server the parent has.

The tool is the SDK’s [`subagent`](/docs/user-guide/sdk/tools/vended-tools/subagent/index.md) with a builder that rebuilds the child as a harness agent, so the model-facing parameters match the SDK tool.

The generalist gets the same plugin instances you pass in `plugins`, so a plugin’s hooks run in both agents. Each plugin’s `init_agent``initAgent` runs for the parent and again for every delegation, so a plugin that keeps per-agent state must key it by agent instead of storing it on itself. A hook you add to the parent after creating it, with `agent.add_hook()``agent.addHook()`, does not run in the generalist. In Python, the generalist also runs hooks you pass to `create_harness` in `hooks`; the TypeScript `createHarness` has no `hooks` option.

Reach for it when a subtask would otherwise flood the main context: searching many files, a multi-step change, or open-ended exploration where you only need the conclusion. Because the generalist inherits `interventions` and the sandbox, a delegate cannot become an approval or isolation bypass.

## Select or disable built-in subagents

The `subagent` tool is on by default. Set it to `False` / `false` in `builtin_tools` to turn it off:

(( tab "Strands harness" ))
(( tab "Python" ))
```python
from strands_harness import create_harness

agent = create_harness(builtin_tools={"subagent": False})  # no generalist delegate
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { createHarness } from '@strands-agents/harness'

const agent = await createHarness({ builtinTools: { subagent: false } })
```
(( /tab "TypeScript" ))
(( /tab "Strands harness" ))

(( tab "SDK" ))
(( tab "Python" ))
```python
# pip install strands-agents
from strands import Agent

# The generalist is Strands harness-specific; raw Strands Harness SDK has none to disable.
agent = Agent()
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
// npm install @strands-agents/sdk
import { Agent } from '@strands-agents/sdk'

// The generalist is Strands harness-specific; raw Strands Harness SDK has none to disable.
const agent = new Agent()
```
(( /tab "TypeScript" ))
(( /tab "SDK" ))

Background execution

In both SDKs the `generalist` runs in the background, so the main agent can keep working while it runs. See [run work in the background](/docs/user-guide/harness/configure/background-tasks/index.md).

## Limit delegation depth

A delegate may delegate again, up to `max_depth` / `maxDepth` levels (default 2). Set it to `0` to remove the `subagent` tool entirely:

(( tab "Python" ))
```python
from strands_harness import create_harness

agent = create_harness(builtin_tools={"subagent": {"max_depth": 1}})
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { createHarness } from '@strands-agents/harness'

const agent = await createHarness({ builtinTools: { subagent: { maxDepth: 1 } } })
```
(( /tab "TypeScript" ))

Breaking change

Earlier harness releases shipped their own copy of this tool. It now uses the SDK’s: the `mcp_servers` / `mcpServers` parameter is gone, `AgentSpec` has no `task`, `context` or `last_messages` field, TypeScript’s `Option` is `new Option(name, value, description)`, the depth budget is stored under `strands.subagent_depth`, child interrupt ids are namespaced by the subagent call (`v1:subagent:<toolUseId>:<id>` in Python, `subagent:<toolUseId>:<id>` in TypeScript), and a depth of `0` removes the tool rather than registering one that always refuses.

For the full option list, see the [configuration reference](/docs/user-guide/harness/reference/configuration/index.md).

## Implementation

### Python

- [harness-sdk/harness-py/src/strands_harness/agent.py](https://github.com/strands-agents/harness-sdk/blob/main/harness-py/src/strands_harness/agent.py)
- [harness-sdk/harness-py/src/strands_harness/tools/subagent.py](https://github.com/strands-agents/harness-sdk/blob/main/harness-py/src/strands_harness/tools/subagent.py)

### TypeScript

- [harness-sdk/harness-ts/src/agent.ts](https://github.com/strands-agents/harness-sdk/blob/main/harness-ts/src/agent.ts)
- [harness-sdk/harness-ts/src/builtin-tools.ts](https://github.com/strands-agents/harness-sdk/blob/main/harness-ts/src/builtin-tools.ts)

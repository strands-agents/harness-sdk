Vended tools are pre-built tools included directly in the Strands Harness SDK for common agent tasks like file operations, shell commands, HTTP requests, and persistent notes.

They ship as part of the SDK package and are updated alongside it. See [Versioning & Maintenance](#versioning--maintenance) for how changes are communicated and what level of backwards compatibility they maintain.

## Quickstart

Each tool is imported from its own subpath under `@strands-agents/sdk/vended-tools`, with no additional packages required:

```typescript
import { Agent } from '@strands-agents/sdk'
import { bash } from '@strands-agents/sdk/vended-tools/bash'
import { edit } from '@strands-agents/sdk/vended-tools/edit'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'
import { notebook, makeNotebook } from '@strands-agents/sdk/vended-tools/notebook'

const agent = new Agent({
  tools: [bash, edit, httpRequest, notebook],
})
```

## Available tools

| Tool | Description | Supported in |
| --- | --- | --- |
| [Edit](/docs/user-guide/sdk/tools/vended-tools/edit/index.md) | Make in-place changes to a text file | Python, TypeScript (Node.js) |
| [File Editor](/docs/user-guide/sdk/tools/vended-tools/file-editor/index.md) *(deprecated)* | View, create, and edit files | Python, TypeScript (Node.js) |
| [Read](/docs/user-guide/sdk/tools/vended-tools/read/index.md) | Read a file as numbered text or a media block | Python, TypeScript (Node.js) |
| [Write](/docs/user-guide/sdk/tools/vended-tools/write/index.md) | Create or overwrite a text file with the full provided content | Python, TypeScript (Node.js) |
| [HTTP Request](/docs/user-guide/sdk/tools/vended-tools/http-request/index.md) | Make HTTP requests to external APIs | Python, TypeScript (Node.js 22+, browsers) |
| [Notebook](/docs/user-guide/sdk/tools/vended-tools/notebook/index.md) | Manage persistent text notebooks | Python, TypeScript (Node.js, browsers) |
| [Bash](/docs/user-guide/sdk/tools/vended-tools/shell/index.md) | Execute shell commands with persistent sessions | Python, TypeScript (Node.js, Unix/Linux/macOS) |
| [MCP Router](/docs/user-guide/sdk/tools/vended-tools/mcp-router/index.md) | Connect to Model Context Protocol servers on a developer-set allowlist | Python, TypeScript (Node.js) |
| [Sleep](/docs/user-guide/sdk/tools/vended-tools/sleep/index.md) | Pause execution for a bounded, cancellable duration | Python, TypeScript (Node.js, browsers) |
| [Handoff to User](/docs/user-guide/sdk/tools/vended-tools/handoff-to-user/index.md) | Pause the agent loop and surface a message to the user | Python, TypeScript (Node.js, browsers) |
| [Stop](/docs/user-guide/sdk/tools/vended-tools/stop/index.md) | Gracefully end the agent loop when the task is complete | Python, TypeScript (Node.js, browsers) |
| [Web Fetch](/docs/user-guide/sdk/tools/vended-tools/web-fetch/index.md) | Fetch a URL and return cleaned markdown for a model to read | Python, TypeScript (Node.js) |
| [A2A Client](/docs/user-guide/sdk/tools/vended-tools/a2a-client/index.md) | Discover and send messages to remote A2A-protocol agents | Python, TypeScript (Node.js, browsers) |
| [Python REPL](/docs/user-guide/sdk/tools/vended-tools/python-repl/index.md) | Execute Python code through the agent’s sandbox | Python, TypeScript (Node.js, Unix/Linux/macOS) |
| [Subagent](/docs/user-guide/sdk/tools/vended-tools/subagent/index.md) | Delegate a self-contained task to a child agent | Python, TypeScript (Node.js, browsers) |
| [Swarm](/docs/user-guide/sdk/tools/vended-tools/swarm/index.md) | Spin up a team of agents that collaborate via the swarm pattern | Python, TypeScript (Node.js, browsers) |
| [Graph](/docs/user-guide/sdk/tools/vended-tools/graph/index.md) | Run a team of sub-agents as a directed acyclic graph designed by the model | Python, TypeScript (Node.js, browsers) |

## Multi-agent tools

The [subagent](/docs/user-guide/sdk/tools/vended-tools/subagent/index.md), [swarm](/docs/user-guide/sdk/tools/vended-tools/swarm/index.md), and [graph](/docs/user-guide/sdk/tools/vended-tools/graph/index.md) tools let the model configure child agents at runtime. They use axis policies to control how much freedom the model has over each parameter. Import them from `strands.multiagent``@strands-agents/sdk/multiagent`.

-   `Inherit()``new Inherit()`: the child inherits the parent’s value. Hidden from the model.
-   `Fixed(value)``new Fixed(value)`: you pin the value. Hidden from the model.
-   `Open()``new Open()`: the model writes a free-form string value.
-   `Choice([...], multiple=True)``new Choice([...], true)`: the model picks from a set you define (one value, or several when `multiple` is set).

Use `Option` inside a `Choice` to map model-facing names to runtime values. Bundle axis defaults into a `Preset` that the model selects via `agent_type`. When the model omits both `agent_type` and `instructions`, the child uses `default_preset``defaultPreset`, or the first preset if none is set.

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { Choice, Fixed, Inherit, Open, Preset } from '@strands-agents/sdk/multiagent'
import { bash } from '@strands-agents/sdk/vended-tools/bash'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'
import { makeSubagent } from '@strands-agents/sdk/vended-tools/subagent'

const delegate = makeSubagent({
  presets: {
    researcher: new Preset({
      instructions: 'You research topics on the web and cite your sources.',
      description: 'web research',
    }),
    summarizer: new Preset({
      instructions: 'You condense documents into short bullet summaries.',
      description: 'summarize a document',
    }),
  },
  defaultPreset: 'researcher',
  instructions: new Open(), // model writes the child's system prompt
  tools: new Fixed(['http_request']), // child can only make HTTP requests
  model: new Inherit(), // child runs on the parent's model
  context: new Choice(['none', 'no_tools']), // model picks how much history to share
})
const agent = new Agent({ tools: [bash, httpRequest, delegate] })
await agent.invoke(
  'Have a subagent summarize the latest Node.js release notes, then run the tests.'
)
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.multiagent import Choice, Fixed, Inherit, Open, Preset
from strands.vended_tools.http_request import http_request
from strands.vended_tools.shell import shell
from strands.vended_tools.subagent import make_subagent

delegate = make_subagent(
    presets={
        "researcher": Preset(
            instructions="You research topics on the web and cite your sources.",
            description="web research",
        ),
        "summarizer": Preset(
            instructions="You condense documents into short bullet summaries.",
            description="summarize a document",
        ),
    },
    default_preset="researcher",
    instructions=Open(),  # model writes the child's system prompt
    tools=Fixed(["http_request"]),  # child can only make HTTP requests
    model=Inherit(),  # child runs on the parent's model
    context=Choice(["none", "no_tools"]),  # model picks how much history to share
)
agent = Agent(tools=[shell, http_request, delegate])
agent("Have a subagent summarize the latest Python release notes, then run the tests.")
```
(( /tab "Python" ))

Tools that accept axis policies use a default builder to turn resolved specs into child agents. By default, it produces child agents that inherit the parent’s tools, model, and interventions, so a child’s tool calls go through the same approval and authorization checks as the parent’s. Each child gets `context_manager="auto"``contextManager: 'auto'` (unless its model is stateful) in place of the parent’s context-management tools, and accesses the parent’s long-term memory through inherited memory tools.

To replace the default builder, pass any callable that takes an `AgentSpec` and returns an `Agent`. A custom builder decides everything the child inherits, including interventions.

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import type { AgentSpec } from '@strands-agents/sdk/multiagent'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'
import { makeSubagent } from '@strands-agents/sdk/vended-tools/subagent'

// Each child gets the resolved instructions and only the HTTP request tool
const delegate = makeSubagent({
  builder: (spec: AgentSpec) =>
    new Agent({
      name: spec.name,
      systemPrompt: spec.instructions,
      tools: [httpRequest],
    }),
})
const agent = new Agent({ tools: [delegate] })
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.multiagent import AgentSpec
from strands.vended_tools.http_request import http_request
from strands.vended_tools.subagent import make_subagent

def build_child(spec: AgentSpec) -> Agent:
    return Agent(name=spec.name, system_prompt=spec.instructions, tools=[http_request])

delegate = make_subagent(builder=build_child)
agent = Agent(tools=[delegate])
```
(( /tab "Python" ))

---

## Using multiple tools together

Combine vended tools in one agent to cover a multi-step workflow:

```typescript
import { Agent } from '@strands-agents/sdk'
import { bash } from '@strands-agents/sdk/vended-tools/bash'
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
import { notebook } from '@strands-agents/sdk/vended-tools/notebook'

const agent = new Agent({
  tools: [bash, fileEditor, notebook],
  systemPrompt: [
    'You are a software development assistant.',
    'When given a feature to implement:',
    '1. Use the notebook tool to create a plan with a checklist of steps',
    '2. Work through each step, checking them off as you go',
    '3. Use the bash tool to run tests and verify your changes',
  ].join('\n'),
})

// Agent plans the work, implements it, and tracks progress
await agent.invoke(
  'Add input validation to the createUser function in src/users.ts. ' +
    'It should reject empty names and invalid email formats.'
)
```

## Versioning & maintenance

Vended tools ship as part of the SDK and are updated alongside it. Report bugs and feature requests in the [GitHub repository](https://github.com/strands-agents/harness-sdk/issues).

Tool names are stable and will not change. In minor versions, a tool’s description, spec, or parameters may be updated to improve effectiveness. These changes are noted in SDK release notes. Pin your SDK version and test after upgrades if your workflows depend on specific tool behavior.

## See also

-   [Custom Tools](/docs/user-guide/sdk/tools/custom-tools/index.md): build your own tools
-   [Community Tools Package](/docs/user-guide/sdk/tools/community-tools-package/index.md): Python tools package with 30+ tools
-   [Session Management](/docs/user-guide/sdk/agents/session-management/index.md): persist agent state including notebooks
-   [Interrupts](/docs/user-guide/sdk/interrupts/index.md): implement approval workflows for sensitive operations
-   [Hooks](/docs/user-guide/sdk/agents/hooks/index.md): intercept and customize tool execution

## Related pages

- [A2A Client](/docs/user-guide/sdk/tools/vended-tools/a2a-client/index.md) (1 shared tag)
- [Attach and invoke tools](/docs/user-guide/sdk/tools/using-tools/index.md) (1 shared tag)
- [Bash / shell](/docs/user-guide/sdk/tools/vended-tools/shell/index.md) (1 shared tag)
- [Community tools package](/docs/user-guide/sdk/tools/community-tools-package/index.md) (1 shared tag)
- [Create custom tools](/docs/user-guide/sdk/tools/custom-tools/index.md) (1 shared tag)
- [Edit](/docs/user-guide/sdk/tools/vended-tools/edit/index.md) (1 shared tag)
- [File editor](/docs/user-guide/sdk/tools/vended-tools/file-editor/index.md) (1 shared tag)
- [Graph](/docs/user-guide/sdk/tools/vended-tools/graph/index.md) (1 shared tag)
- [Handoff to User](/docs/user-guide/sdk/tools/vended-tools/handoff-to-user/index.md) (1 shared tag)
- [HTTP request](/docs/user-guide/sdk/tools/vended-tools/http-request/index.md) (1 shared tag)

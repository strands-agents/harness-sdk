Lets your agent design and run a team of sub-agents as a [Graph](/docs/user-guide/sdk/multi-agent/graph/index.md). The model supplies a `task`, a list of `nodes` (each with a unique `name` and its own `instructions`), and `edges` that order them. Nodes with no upstream nodes start in parallel, and each node receives its upstream outputs.

Nodes inherit the caller’s model and tools, including MCP tools, except graph tools. Child interrupts pause the tool call and resume with the user’s response. An interrupted graph is saved in the parent agent’s interrupt state, so it can resume after the parent is restored from a snapshot or session. By default, a call times out after 15 minutes and each node after 5 minutes.

*Supported in: Python, TypeScript (Node.js, browsers).*

**Example:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { graph } from '@strands-agents/sdk/vended-tools/graph'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'

const agent = new Agent({ tools: [graph, httpRequest] })
await agent.invoke(
  'Research three competing vector databases in parallel, then write a comparison table.'
)
```

Use `makeGraph` to set limits (`maxNodes`, `maxEdges`, `maxSteps`, and `timeout` and `nodeTimeout` in milliseconds), build each node agent yourself with `builder`, or control what the model configures on each node with [axis policies](/docs/user-guide/sdk/tools/vended-tools/index.md#multi-agent-tools) over `instructions`, `tools`, and `model`.

```typescript
import { Agent } from '@strands-agents/sdk'
import { Choice, Preset } from '@strands-agents/sdk/multiagent'
import { makeGraph } from '@strands-agents/sdk/vended-tools/graph'
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'

const team = makeGraph({
  presets: {
    researcher: new Preset({
      instructions: 'Gather facts from the web and cite every source.',
      tools: ['http_request'],
      description: 'Finds and summarizes sources.',
    }),
    writer: new Preset({
      instructions: 'Turn upstream findings into clear prose.',
      tools: ['file_editor'],
      description: 'Drafts the final document.',
    }),
  },
  tools: new Choice(['http_request', 'file_editor'], true),
  maxNodes: 6,
  maxEdges: 10,
  timeout: 600_000,
  nodeTimeout: 120_000,
})
const agent = new Agent({ tools: [team, httpRequest, fileEditor] })
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import graph, http_request

agent = Agent(tools=[graph, http_request])
agent("Research three competing vector databases in parallel, then write a comparison table.")
```

Use `make_graph` to set limits (`max_nodes`, `max_edges`, `max_node_executions`, and `execution_timeout` and `node_timeout` in seconds), build each node agent yourself with `builder`, or control what the model configures on each node with [axis policies](/docs/user-guide/sdk/tools/vended-tools/index.md#multi-agent-tools) over `instructions`, `tools`, and `model`. A running graph cannot be cancelled from the parent agent.

```python
from strands import Agent
from strands.multiagent import Choice, Preset
from strands.vended_tools import file_editor, http_request, make_graph

team = make_graph(
    presets={
        "researcher": Preset(
            instructions="Gather facts from the web and cite every source.",
            tools=["http_request"],
            description="Finds and summarizes sources.",
        ),
        "writer": Preset(
            instructions="Turn upstream findings into clear prose.",
            tools=["file_editor"],
            description="Drafts the final document.",
        ),
    },
    tools=Choice(["http_request", "file_editor"], multiple=True),
    max_nodes=6,
    max_edges=10,
    execution_timeout=600,
    node_timeout=120,
)
agent = Agent(tools=[team, http_request, file_editor])
```
(( /tab "Python" ))

Full API reference: [TypeScript](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/graph/README.md)

## Related pages

- [A2A Client](/docs/user-guide/sdk/tools/vended-tools/a2a-client/index.md) (1 shared tag)
- [Attach and invoke tools](/docs/user-guide/sdk/tools/using-tools/index.md) (1 shared tag)
- [Bash / shell](/docs/user-guide/sdk/tools/vended-tools/shell/index.md) (1 shared tag)
- [Community tools package](/docs/user-guide/sdk/tools/community-tools-package/index.md) (1 shared tag)
- [Create custom tools](/docs/user-guide/sdk/tools/custom-tools/index.md) (1 shared tag)
- [Edit](/docs/user-guide/sdk/tools/vended-tools/edit/index.md) (1 shared tag)
- [File editor](/docs/user-guide/sdk/tools/vended-tools/file-editor/index.md) (1 shared tag)
- [Handoff to User](/docs/user-guide/sdk/tools/vended-tools/handoff-to-user/index.md) (1 shared tag)
- [HTTP request](/docs/user-guide/sdk/tools/vended-tools/http-request/index.md) (1 shared tag)
- [MCP Router](/docs/user-guide/sdk/tools/vended-tools/mcp-router/index.md) (1 shared tag)


## Implementation

### TypeScript

- [harness-sdk/strands-ts/src/vended-tools/graph/graph.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/graph/graph.ts)

### Python

- [harness-sdk/strands-py/src/strands/vended_tools/graph/graph.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/graph/graph.py)

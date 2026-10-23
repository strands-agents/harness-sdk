# Graph Tool

Runs a team of agents at runtime as a directed acyclic graph, then returns each node's final output.

The model defines the graph on each call: a `task`, a list of `nodes` (a unique `name` plus whichever of `agent_type`, `instructions`, `tools`, and `model` the axis policies expose), and `edges` that order them. The tool resolves each spec, builds the agents, and runs them as a [`Graph`](../../multiagent/graph.ts). Nodes with no incoming edges receive the task directly; each other node runs once its upstream nodes finish and receives their outputs. Nodes that become ready together run in parallel. Cycles are rejected. Nodes never receive a graph tool, so graphs do not nest.

`makeGraph` takes axis policies from `@strands-agents/sdk/multiagent` that control which parameters the model sees for each node, plus caps on nodes and edges per call and the `Graph` limits (`maxSteps`, `timeout`, `nodeTimeout`).

## Usage

```typescript
import { Agent } from '@strands-agents/sdk'
import { graph } from '@strands-agents/sdk/vended-tools/graph'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'

const agent = new Agent({ tools: [graph, httpRequest] })
await agent.invoke('Research three competing vector databases in parallel, then write a comparison table.')
```

Presets, a tool subset, and limits:

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

## API

### `graph`

The default tool, produced by `makeGraph()`: no presets, free-form `instructions`, inherited tools and model, at most 20 nodes and 50 edges, a 15-minute graph timeout, and a 5-minute per-node timeout. Node executions are not capped.

### `makeGraph(options?)`

| Option          | Type                         | Default                     | Description                                                            |
| --------------- | ---------------------------- | --------------------------- | ---------------------------------------------------------------------- |
| `builder`       | `(spec: AgentSpec) => Agent` | (inherits from parent)      | Turns a resolved spec into an agent. Each agent needs a unique `id`.   |
| `presets`       | `Record<string, Preset>`     | `{}`                        | Named roles the model selects via `agent_type`.                        |
| `defaultPreset` | `string`                     | first preset                | Preset used when the model omits both `agent_type` and `instructions`. |
| `instructions`  | `Open \| Choice \| Fixed`    | `new Open()`                | Policy for each node's system prompt.                                  |
| `tools`         | `Choice \| Fixed \| Inherit` | `new Inherit()`             | Policy for each node's tools. A `Choice` must be `multiple`.           |
| `model`         | `Inherit \| Choice \| Fixed` | `new Inherit()`             | Policy for each node's model.                                          |
| `maxNodes`      | `number`                     | `20`                        | Upper bound on nodes per call. Must be an integer of at least 2.       |
| `maxEdges`      | `number`                     | `50`                        | Upper bound on edges per call. Must be a positive integer.             |
| `maxSteps`      | `number`                     | `Infinity`                  | Max total node executions. Must be a positive integer or `Infinity`.   |
| `timeout`       | `number`                     | `900_000`                   | Wall-clock ceiling for the whole graph, in milliseconds.               |
| `nodeTimeout`   | `number`                     | `300_000`                   | Per-node wall-clock ceiling, in milliseconds.                          |
| `name`          | `string`                     | `graph`                     | Tool name.                                                             |
| `description`   | `string`                     | `DEFAULT_GRAPH_DESCRIPTION` | Tool description.                                                      |

Throws if `name` or `description` is empty, a limit is out of range, `defaultPreset` is not one of `presets`, or a `Choice` axis has no options, or a `tools` `Choice` is not `multiple`.

The default builder gives each node the parent's model and tools (narrowed by the resolved spec), sandbox, printer setting, and trace attributes, plus `contextManager: 'auto'` unless the node's model is stateful. The node agent's `name` and `id` are its spec name.

### Input

| Property | Type       | Required | Description                                                                               |
| -------- | ---------- | -------- | ----------------------------------------------------------------------------------------- |
| `task`   | `string`   | Yes      | The objective for the graph; entry-point nodes receive it directly.                       |
| `nodes`  | `object[]` | Yes      | Agent specifications: `name` plus the axis properties the policies expose.                |
| `edges`  | `object[]` | Yes      | `{ from_node, to_node }` pairs of node names. Use an empty list for fully parallel nodes. |

### Output

Returns each node's final output as `name: output` lines, using the node names from the input. Repeated edges are ignored. Returns an error result when the input is invalid, when a node fails (naming the failed nodes, with the output of the nodes that finished), and when a step or time limit stops the graph (with the partial output).

If a node stops on interrupts, they are raised on the parent with the id `graph:<toolUseId>:<nodeInterruptId>` (`toolUseId` URI-encoded) and the node's original `name` and `reason`. The interrupted graph's state is stored in the parent's interrupt state, so resuming the parent resumes the graph, including after the parent is restored from a session. On resume the graph's nodes are rebuilt from the same input, so a custom `builder` must give each spec the same agent id.

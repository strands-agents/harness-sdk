# Graph Tool

Runs a team of agents at runtime as a directed acyclic graph designed by the model, then returns each node's final output.

The model defines the graph on each call: a `task`, a list of `nodes` (each a unique `name` plus whichever of `agent_type`, `instructions`, `tools`, and `model` the axis policies expose), and `edges` that order them. The tool resolves each spec, builds the agents, and runs them as a [`Graph`](../../multiagent/graph.ts). Nodes with no incoming edges receive the task directly and start in parallel; each other node runs once its upstream nodes finish and receives their outputs. Cycles, self-loops, and edges to undeclared nodes are rejected. Nodes never receive a graph tool, so graphs do not nest.

`makeGraph` takes axis policies from `@strands-agents/sdk/multiagent` that control which parameters the model sees for each node, caps on nodes and edges per call, and the `Graph` limits (`maxSteps`, `timeout`, `nodeTimeout`). Repeated edges are collapsed into one.

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
    researcher: new Preset({ instructions: 'Gather facts and cite sources.', tools: ['http_request'] }),
    writer: new Preset({ instructions: 'Turn upstream findings into prose.', tools: ['file_editor'] }),
  },
  tools: new Choice(['http_request', 'file_editor'], true),
  maxNodes: 6,
  maxEdges: 10,
  maxSteps: 12,
  timeout: 600_000,
  nodeTimeout: 120_000,
})
const agent = new Agent({ tools: [team, httpRequest, fileEditor] })
```

## API

### `graph`

The default tool, produced by `makeGraph()`: no presets, free-form `instructions`, inherited tools and model, at most 20 nodes and 50 edges per call, a 15-minute graph timeout, and a 5-minute per-node timeout. Pass `Infinity` as `maxSteps`, `timeout`, or `nodeTimeout` to lift that limit.

### `makeGraph(options?)`

| Option          | Type                         | Default                     | Description                                                            |
| --------------- | ---------------------------- | --------------------------- | ---------------------------------------------------------------------- |
| `builder`       | `(spec: AgentSpec) => Agent` | (inherits from parent)      | Turns a resolved spec into an agent.                                   |
| `presets`       | `Record<string, Preset>`     | `{}`                        | Named roles the model selects via `agent_type`.                        |
| `defaultPreset` | `string`                     | first preset                | Preset used when the model omits both `agent_type` and `instructions`. |
| `instructions`  | `Open \| Choice \| Fixed`    | `new Open()`                | Policy for each node's system prompt.                                  |
| `tools`         | `Choice \| Fixed \| Inherit` | `new Inherit()`             | Policy for each node's tools. A `Choice` must be `multiple`.           |
| `model`         | `Inherit \| Choice \| Fixed` | `new Inherit()`             | Policy for each node's model.                                          |
| `maxNodes`      | `number`                     | `20`                        | Upper bound on nodes per call. Must be an integer >= 2.                |
| `maxEdges`      | `number`                     | `50`                        | Upper bound on edges per call. Must be a positive integer.             |
| `maxSteps`      | `number`                     | `Infinity`                  | Max total node executions.                                             |
| `timeout`       | `number`                     | `900_000`                   | Wall-clock ceiling for the whole graph, in milliseconds.               |
| `nodeTimeout`   | `number`                     | `300_000`                   | Per-node wall-clock ceiling, in milliseconds.                          |
| `name`          | `string`                     | `graph`                     | Tool name.                                                             |
| `description`   | `string`                     | `DEFAULT_GRAPH_DESCRIPTION` | Tool description.                                                      |

Throws if `name` or `description` is empty, `maxNodes` is not an integer >= 2, `maxEdges` is not a positive integer, `maxSteps` is not a positive integer or `Infinity`, a timeout is not a positive number, `defaultPreset` is not one of `presets`, or a `Choice` axis has no options, or a `tools` `Choice` is not `multiple`.

The default builder gives each node the parent's model, tools (narrowed by the resolved spec), and interventions, sandbox, printer setting, and trace attributes, plus `contextManager: 'auto'` unless the node's model is stateful. The agent's `name` and `id` are its spec name.

### Input

| Property | Type       | Required | Description                                                                                 |
| -------- | ---------- | -------- | ------------------------------------------------------------------------------------------- |
| `task`   | `string`   | Yes      | The objective for the graph; entry-point nodes receive it directly.                         |
| `nodes`  | `object[]` | Yes      | Agent specifications, one per node: `name` plus the axis properties the policies expose.    |
| `edges`  | `object[]` | Yes      | Directed edges `{ from_node, to_node }` between node names. Empty for fully parallel nodes. |

### Output

Returns each completed node's output as `name: output` lines, using the node names the model chose. Returns an error result with the partial output when the graph does not complete (a node fails, or a step or time limit is hit), with each failed node rendered as `name: failed: error`, and an error result when the input is invalid.

If a node stops on interrupts, they are raised on the parent with the id `graph:<toolUseId>:<nodeInterruptId>` (`toolUseId` URI-encoded) and the node's original `name` and `reason`. The interrupted graph's state is stored in the parent's interrupt state, so resuming the parent resumes the graph, including after the parent is restored from a session. On resume the graph's agents are rebuilt from the same input. Nodes are keyed by their names, so a custom `builder` can assign any agent ids.

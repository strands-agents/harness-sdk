A [Graph](/docs/user-guide/sdk/multi-agent/graph/index.md) is assembled from nodes and edges. This page is the reference for those building blocks: the fields on each type, the builder or constructor that assembles them, and the options that bound execution. To build and run a graph, see [Graph](/docs/user-guide/sdk/multi-agent/graph/index.md).

## Graph Components

(( tab "Python" ))
**1\. GraphNode**

A [`GraphNode`](/docs/api/python/strands.multiagent.graph#GraphNode) represents a node in the graph with:

-   **node\_id**: Unique identifier for the node
-   **executor**: The Agent, A2AAgent, or MultiAgentBase instance to execute
-   **dependencies**: Set of nodes this node depends on
-   **execution\_status**: Current status (PENDING, EXECUTING, COMPLETED, FAILED)
-   **result**: The NodeResult after execution
-   **execution\_time**: Time taken to execute the node in milliseconds

**2\. GraphEdge**

A [`GraphEdge`](/docs/api/python/strands.multiagent.graph#GraphEdge) represents a connection between nodes with:

-   **from\_node**: Source node
-   **to\_node**: Target node
-   **condition**: Optional function that determines if the edge should be traversed

**3\. GraphBuilder**

The [`GraphBuilder`](/docs/api/python/strands.multiagent.graph#GraphBuilder) constructs graphs:

-   **add\_node()**: Add an agent or multi-agent system as a node
-   **add\_edge()**: Create a dependency between nodes
-   **set\_entry\_point()**: Define starting nodes for execution
-   **set\_max\_node\_executions()**: Limit total node executions (useful for cyclic graphs)
-   **set\_execution\_timeout()**: Set maximum execution time
-   **set\_node\_timeout()**: Set timeout for individual nodes
-   **reset\_on\_revisit()**: Control whether nodes reset state when revisited
-   **build()**: Validate and create the Graph instance
(( /tab "Python" ))

(( tab "TypeScript" ))
**Nodes**

Nodes wrap agents or other orchestrators for execution within the graph. The SDK provides two built-in node types:

-   **AgentNode**: Wraps an `AgentBase` instance. Created automatically when you pass an agent to the `nodes` array. Uses the agent’s `id` as the node identifier.
-   **MultiAgentNode**: Wraps a `MultiAgentBase` instance (e.g. another `Graph` or `Swarm`). Created automatically when you pass an orchestrator to the `nodes` array. Uses the orchestrator’s `id` as the node identifier.

**Edges**

Edges define directed connections between nodes. They can be specified as simple tuples or with an optional handler for conditional traversal:

-   **`[source, target]`**: Tuple of node IDs for unconditional edges
-   **`{ source, target, handler }`**: Object with an optional `EdgeHandler` function for conditional traversal

**Graph Constructor**

The `Graph` constructor accepts:

-   **nodes**: Array of `AgentBase`, `MultiAgentBase`, or `Node` instances
-   **edges**: Array of edge definitions (tuples or objects with handlers)
-   **sources**: Entry point node IDs (auto-detected from nodes with no incoming edges)
-   **maxSteps**: Maximum total node executions (useful for cyclic graphs). Defaults to `Infinity`.
-   **maxConcurrency**: Maximum nodes executing in parallel. Defaults to `Infinity`.
-   **timeout**: Wall-clock ceiling for the entire graph invocation, in milliseconds. Defaults to `Infinity`. Does not propagate into nested orchestrators wrapped via `MultiAgentNode`; nested `Swarm`/`Graph` instances run under their own timeout config.
-   **nodeTimeout**: Fallback per-node wall-clock ceiling in milliseconds. Applied to any `AgentNode` that does not set its own `timeout`. Defaults to `Infinity`. Does not apply to `MultiAgentNode`.
-   **plugins**: Plugins for event-driven extensibility

To bound an individual `AgentNode`, pass `timeout` to its options object instead of relying on the orchestrator’s `nodeTimeout`. Per-node `timeout` overrides `nodeTimeout` for that node and must be at least 1 ms.

Each `AgentNode` captures the wrapped agent’s state before execution and restores it afterward, so a node visited multiple times runs from a clean slate.

Set `preserveContext: true` on the node to opt out: `new AgentNode({ agent: analyst, preserveContext: true })`. The wrapped agent then accumulates messages, app state, and model state across executions, which suits revisited nodes that build on prior work like iterative refinement.

`preserveContext: true` requires an `Agent` instance; passing it with a non-`Agent` `InvokableAgent` throws at construction time.

If neither `maxSteps` nor `timeout` is set, the SDK emits a one-time warning at construction since a graph with cyclic edges and no bound can run indefinitely.

Timeouts are enforced via `AbortSignal` and are cooperative. A tool that neither polls its cancel signal nor forwards it to a cancellable API can run past the deadline.
(( /tab "TypeScript" ))

## Related pages

- [A2A Server Configuration](/docs/user-guide/sdk/multi-agent/a2a-server-configuration/index.md) (1 shared tag)
- [Agent-to-Agent (A2A) Protocol](/docs/user-guide/sdk/multi-agent/agent-to-agent/index.md) (1 shared tag)
- [Build a sequential workflow](/docs/user-guide/sdk/multi-agent/workflow/index.md) (1 shared tag)
- [Choose a multi-agent pattern](/docs/user-guide/sdk/multi-agent/multi-agent-patterns/index.md) (1 shared tag)
- [Graph Multi-Agent Pattern](/docs/user-guide/sdk/multi-agent/graph/index.md) (1 shared tag)
- [Swarm Multi-Agent Pattern](/docs/user-guide/sdk/multi-agent/swarm/index.md) (1 shared tag)
- [Agents as tools](/docs/user-guide/sdk/multi-agent/agents-as-tools/index.md) (1 shared tag)
- [Interrupts in Multi-Agent Systems](/docs/user-guide/sdk/interrupts-multi-agent/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/multiagent/graph.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/graph.py)

### TypeScript

- [harness-sdk/strands-ts/src/multiagent/graph.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/multiagent/graph.ts)

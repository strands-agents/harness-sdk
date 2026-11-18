Graph tool for running a directed acyclic graph of sub-agents at runtime.

Provides :func:`make_graph` (a factory that lets the developer pin safety limits and authority modes) and :data:`graph` (a default instance). The tool is a thin shim over :class:`~strands.multiagent.graph.Graph`: it resolves each node spec through the authority-mode system, builds agents via an :data:`AgentBuilder`, runs the graph, and maps the result.

#### DEFAULT\_GRAPH\_DESCRIPTION

Description for the default graph tool.

## EdgeSpec

```python
class EdgeSpec(TypedDict)
```

Defined in: [src/strands/vended\_tools/graph/graph.py:57](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/graph/graph.py#L57)

One directed edge in a graph topology.

#### make\_graph

```python
def make_graph(
    *,
    name: str = "graph",
    description: str = DEFAULT_GRAPH_DESCRIPTION,
    builder: AgentBuilder | None = None,
    presets: Mapping[str, Preset] | None = None,
    default_preset: str | None = None,
    instructions: Open | Choice | Fixed | None = None,
    tools: Choice | Fixed | Inherit | None = None,
    model: Inherit | Choice | Fixed | None = None,
    max_nodes: int = _DEFAULT_MAX_NODES,
    max_edges: int = _DEFAULT_MAX_EDGES,
    max_node_executions: int | None = None,
    execution_timeout: float | None = _DEFAULT_EXECUTION_TIMEOUT,
    node_timeout: float | None = _DEFAULT_NODE_TIMEOUT
) -> DecoratedFunctionTool
```

Defined in: [src/strands/vended\_tools/graph/graph.py:87](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/graph/graph.py#L87)

Create a graph tool with developer-controlled safety limits and authority modes.

Each node spec from the model is resolved through the authority-mode system (see :mod:`~strands.multiagent.spec`), then built via `builder`. A running graph cannot be cancelled from the parent agent.

A child’s interrupt is surfaced as an interrupt of this tool and can be resumed after a parent-agent snapshot restore.

**Arguments**:

-   `name` - Tool name shown to the model.
-   `description` - Tool description shown to the model.
-   `builder` - Callable, sync or async, that turns an :class:`AgentSpec` into an `Agent`. When `None` a default builder is used that creates an `Agent` inheriting the caller’s model with the spec’s instructions and tools.
-   `presets` - Named roles the model can select via `agent_type`.
-   `default_preset` - Preset used when the model omits both `agent_type` and `instructions`.
-   `instructions` - Authority mode for the instructions axis.
-   `tools` - Authority mode for the tools axis.
-   `model` - Authority mode for the model axis.
-   `max_nodes` - Upper bound on nodes per invocation.
-   `max_edges` - Upper bound on edges per invocation.
-   `max_node_executions` - Maximum total node executions across the graph. `None` for no limit.
-   `execution_timeout` - Total timeout in seconds. `None` for no limit.
-   `node_timeout` - Per-node timeout in seconds. `None` for no limit.

**Returns**:

A decorated tool that builds and runs a :class:`~strands.multiagent.graph.Graph`.

**Raises**:

-   `ValueError` - If a count limit is not a positive integer, a timeout is not a positive number, *max\_nodes* < 2, or a `Choice` axis violates its constraints (empty options, `multiple=False` for tools).

#### graph

Default graph tool. Children inherit the caller’s model.
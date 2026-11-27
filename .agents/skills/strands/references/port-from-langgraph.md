# Port from LangGraph

Migrate behavior and external contracts, not syntax line by line.

## Map the architecture

| LangGraph | Strands |
| --- | --- |
| model-calling node function | `Agent` node |
| deterministic node function | custom node or ordinary code |
| `StateGraph` | Python `GraphBuilder` or TypeScript `Graph` |
| `add_edge` | graph edge |
| `add_conditional_edges` | conditional edge |
| `thread_id` | session ID |
| checkpointer | session manager on the orchestrator |
| `interrupt()` or `interrupt_before` | interrupt raised from a hook or tool |
| `recursion_limit` | orchestrator execution limit, plus per-agent limits where supported |
| LangSmith tracing | OpenTelemetry |

Strands graph nodes pass outputs along edges. Do not recreate a large shared state object by default. The orchestrator's session manager persists graph state; whether a revisited agent node retains its own conversation differs by SDK and node configuration, so verify that behavior explicitly.

## Migration sequence

1. Record the current public entrypoint, external IDs, graph topology, conditional routes, persistence behavior, interrupts, limits, streaming, and tracing.
2. Keep the public entrypoint and caller-visible IDs stable. If a Strands storage backend restricts session ID characters, use a deterministic collision-resistant mapping behind the unchanged external ID.
3. Turn nodes that call a model into focused Strands agents with clear system prompts and tools.
4. Keep validation, data shaping, and other deterministic work as custom nodes or ordinary functions.
5. Recreate edges and conditions. Check join behavior explicitly: Python and TypeScript graph joins can have different readiness semantics in current releases.
6. Replace the checkpointer with a supported session manager attached to the graph or orchestrator, not to each child agent.
7. Translate one recursion limit into an orchestrator execution limit: Python uses `set_max_node_executions()` and TypeScript uses `maxSteps`. Add per-agent turn or token limits where the node invocation surface supports them. In the current TypeScript graph API, `AgentNode` does not forward invocation `limits`; use a bounded `InvokableAgent` wrapper when those limits are required, and also set graph and node timeouts.
8. Replace LangSmith-specific instrumentation with OpenTelemetry when tracing must continue to the same backend.

## Verify parity

Run representative inputs through both implementations and compare behavior rather than exact generated text:

- callers use the same entrypoint and identifiers;
- each stage still performs its responsibility;
- routing and joins fire in the intended order;
- revisited nodes retain or reset conversation context as intended;
- a repeated session resumes correctly;
- approval or interrupt flows pause and resume;
- limits stop runaway work with an explicit stop reason;
- traces reach the configured collector.

Do not translate an in-flight LangGraph checkpoint format unless the user has a concrete requirement to preserve it. Prefer starting a fresh Strands session store under the same external session IDs and document the cutover behavior.

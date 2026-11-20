Defined in: [src/multiagent/graph.ts:146](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/multiagent/graph.ts#L146)

Directed graph orchestration pattern.

Agents execute as nodes in a dependency graph, with edges defining execution order and optional conditions controlling routing. Source nodes (those with no incoming edges) run first, and downstream nodes execute once all their dependencies complete. Parallel execution is supported up to a configurable concurrency limit.

Key design choices vs the Python SDK:

-   Construction uses a declarative options object rather than a mutable GraphBuilder. Nodes and edges are passed directly to the constructor.
-   Dependency resolution uses AND semantics: a node runs only when all incoming edges are satisfied. Python uses OR semantics, firing a node when any single incoming edge from the completed batch is satisfied.
-   Nodes are launched individually as they become ready (up to maxConcurrency). Python executes in discrete batches, waiting for the entire batch to complete before scheduling the next set of nodes.
-   Agent nodes are stateless by default (snapshot/restore on each execution). Python accumulates agent state across executions unless `reset_on_revisit` is enabled.
-   Node failures produce a FAILED result, allowing parallel paths to continue; this includes a node whose agent reaches a request limit (MultiAgentInvokeOptions.limits). The graph’s own `maxSteps` and `timeout` throw exceptions. Python does the inverse: node failures throw exceptions (fail-fast), while limit violations return a FAILED result.

## Example

```typescript
const graph = new Graph({
  nodes: [researcher, writer],
  edges: [['researcher', 'writer']],
})

const result = await graph.invoke('Explain quantum computing')
```

## Implements

-   `MultiAgent`

## Constructors

### Constructor

```ts
new Graph(options): Graph;
```

Defined in: [src/multiagent/graph.ts:167](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/multiagent/graph.ts#L167)

#### Parameters

| Parameter | Type |
| --- | --- |
| `options` | `GraphOptions` |

#### Returns

`Graph`

## Properties

### id

```ts
readonly id: string;
```

Defined in: [src/multiagent/graph.ts:147](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/multiagent/graph.ts#L147)

Unique identifier for this orchestrator.

#### Implementation of

`MultiAgent.id`

---

### nodes

```ts
readonly nodes: ReadonlyMap<string, Node>;
```

Defined in: [src/multiagent/graph.ts:148](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/multiagent/graph.ts#L148)

---

### edges

```ts
readonly edges: readonly Edge[];
```

Defined in: [src/multiagent/graph.ts:149](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/multiagent/graph.ts#L149)

---

### config

```ts
readonly config: Required<GraphConfig>;
```

Defined in: [src/multiagent/graph.ts:150](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/multiagent/graph.ts#L150)

---

### sessionManager?

```ts
readonly sessionManager?: SessionManager;
```

Defined in: [src/multiagent/graph.ts:157](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/multiagent/graph.ts#L157)

## Methods

### initialize()

```ts
initialize(): Promise<void>;
```

Defined in: [src/multiagent/graph.ts:209](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/multiagent/graph.ts#L209)

Initialize the graph. Invokes the MultiAgentInitializedEvent callback. Called automatically on first invocation.

#### Returns

`Promise`<`void`\>

---

### invoke()

```ts
invoke(input, options?): Promise<MultiAgentResult>;
```

Defined in: [src/multiagent/graph.ts:223](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/multiagent/graph.ts#L223)

Invoke graph and return final result (consumes stream).

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `input` | `MultiAgentInput` | The input to pass to entry point nodes |
| `options?` | `MultiAgentInvokeOptions` | Optional per-invocation options (e.g., [InvocationState](/docs/api/typescript/InvocationState/index.md)) |

#### Returns

`Promise`<`MultiAgentResult`\>

Promise resolving to the final MultiAgentResult

#### Implementation of

`MultiAgent.invoke`

---

### addHook()

```ts
addHook<T>(eventType, callback): HookCleanup;
```

Defined in: [src/multiagent/graph.ts:239](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/multiagent/graph.ts#L239)

Register a hook callback for a specific graph event type.

#### Type Parameters

| Type Parameter |
| --- |
| `T` *extends* [`HookableEvent`](/docs/api/typescript/HookableEvent/index.md) |

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `eventType` | [`HookableEventConstructor`](/docs/api/typescript/HookableEventConstructor/index.md)<`T`\> | The event class constructor to register the callback for |
| `callback` | [`HookCallback`](/docs/api/typescript/HookCallback/index.md)<`T`\> | The callback function to invoke when the event occurs |

#### Returns

`HookCleanup`

Cleanup function that removes the callback when invoked

#### Implementation of

`MultiAgent.addHook`

---

### stream()

```ts
stream(input, options?): AsyncGenerator<MultiAgentStreamEvent, MultiAgentResult, undefined>;
```

Defined in: [src/multiagent/graph.ts:251](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/multiagent/graph.ts#L251)

Stream graph execution, yielding events as nodes execute. Invokes hook callbacks for each event before yielding.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `input` | `MultiAgentInput` | The input to pass to entry nodes |
| `options?` | `MultiAgentInvokeOptions` | Optional per-invocation options (e.g., [InvocationState](/docs/api/typescript/InvocationState/index.md)) |

#### Returns

`AsyncGenerator`<`MultiAgentStreamEvent`, `MultiAgentResult`, `undefined`\>

Async generator yielding streaming events and returning a MultiAgentResult

#### Implementation of

`MultiAgent.stream`
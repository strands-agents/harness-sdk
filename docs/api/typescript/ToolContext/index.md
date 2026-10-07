Defined in: [src/tools/tool.ts:13](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/tool.ts#L13)

Context provided to tool implementations during execution. Contains framework-level state and information from the agent invocation.

## Extends

-   `Interruptible`

## Properties

### toolUse

```ts
toolUse: ToolUse;
```

Defined in: [src/tools/tool.ts:18](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/tool.ts#L18)

The tool use request that triggered this tool execution. Contains the tool name, toolUseId, and input parameters.

---

### agent

```ts
agent: LocalAgent;
```

Defined in: [src/tools/tool.ts:24](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/tool.ts#L24)

The agent instance that is executing this tool. Provides access to agent state, conversation history, and cancellation state.

---

### invocationState

```ts
invocationState: InvocationState;
```

Defined in: [src/tools/tool.ts:35](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/tool.ts#L35)

Per-invocation state shared across hooks and tools for the current agent invocation. Mutable — read and write freely; changes are visible to subsequent hooks, tools, and on [AgentResult.invocationState](/docs/api/typescript/AgentResult/index.md#invocationstate).

Distinct from `agent.appState`: `invocationState` is ephemeral and accepts arbitrary values, while `appState` is durable, JSON-serializable, and deep-copied on read/write.

---

### cancelSignal

```ts
cancelSignal: AbortSignal;
```

Defined in: [src/tools/tool.ts:38](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/tool.ts#L38)

Execution-scoped cancellation signal for this tool call.

## Methods

### interrupt()

```ts
interrupt<T>(params): T;
```

Defined in: [src/interrupt.ts:398](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interrupt.ts#L398)

#### Type Parameters

| Type Parameter | Default type |
| --- | --- |
| `T` | [`JSONValue`](/docs/api/typescript/JSONValue/index.md) |

#### Parameters

| Parameter | Type |
| --- | --- |
| `params` | [`InterruptParams`](/docs/api/typescript/InterruptParams/index.md) |

#### Returns

`T`

#### Inherited from

```ts
Interruptible.interrupt
```
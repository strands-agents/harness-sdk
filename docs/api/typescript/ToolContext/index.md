Defined in: [src/tools/tool.ts:14](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/tool.ts#L14)

Context provided to tool implementations during execution. Contains framework-level state and information from the agent invocation.

## Extends

-   `Interruptible`

## Properties

### toolUse

```ts
toolUse: ToolUse;
```

Defined in: [src/tools/tool.ts:19](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/tool.ts#L19)

The tool use request that triggered this tool execution. Contains the tool name, toolUseId, and input parameters.

---

### agent

```ts
agent: LocalAgent;
```

Defined in: [src/tools/tool.ts:25](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/tool.ts#L25)

The agent instance that is executing this tool. Provides access to agent state, conversation history, and cancellation state.

---

### invocationState

```ts
invocationState: InvocationState;
```

Defined in: [src/tools/tool.ts:36](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/tool.ts#L36)

Per-invocation state shared across hooks and tools for the current agent invocation. Mutable — read and write freely; changes are visible to subsequent hooks, tools, and on [AgentResult.invocationState](/docs/api/typescript/AgentResult/index.md#invocationstate).

Distinct from `agent.appState`: `invocationState` is ephemeral and accepts arbitrary values, while `appState` is durable, JSON-serializable, and deep-copied on read/write.

---

### cancelSignal

```ts
cancelSignal: AbortSignal;
```

Defined in: [src/tools/tool.ts:39](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/tool.ts#L39)

Execution-scoped cancellation signal for this tool call.

---

### invocationContext?

```ts
readonly invocationContext?: InvocationContext;
```

Defined in: [src/tools/tool.ts:42](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/tool.ts#L42)

The request this tool call belongs to; pass it to [InvokeOptions.invocationContext](/docs/api/typescript/InvokeOptions/index.md#invocationcontext) to run a nested call in the same request.

## Methods

### interrupt()

```ts
interrupt<T>(params): T;
```

Defined in: [src/interrupt.ts:462](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interrupt.ts#L462)

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

`Interruptible.interrupt`
```ts
type InvocationState = Record<string, unknown>;
```

Defined in: [src/types/agent.ts:91](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L91)

Per-invocation state threaded through hooks and tools for a single agent invocation, and returned on [AgentResult.invocationState](/docs/api/typescript/AgentResult/index.md#invocationstate). One object per invocation, shared by reference; mutations by hooks or tools are visible to subsequent hooks, tools, and recursive loop cycles.

Typically used for request-scoped context (`userId`, `requestId`, `traceId`) or cross-hook counters. The core agent loop writes no keys into it — the key space is the caller’s. Transport bridges may populate reserved keys (e.g. `A2AExecutor` sets `a2aRequestContext`); those bridges document their own reserved keys.

Distinct from LocalAgent.appState: `appState` is durable across invocations, JSON-serializable, and deep-copied. `invocationState` is ephemeral and accepts arbitrary values.

Excluded from `toJSON()` on [AgentResult](/docs/api/typescript/AgentResult/index.md) and all hook events because values may not be serializable; callers produce a serialized form explicitly if needed.
Defined in: [src/agent/agent-as-tool.ts:30](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent-as-tool.ts#L30)

Options for creating an agent tool via [Agent.asTool](/docs/api/typescript/Agent/index.md#astool).

## Properties

### name?

```ts
optional name?: string;
```

Defined in: [src/agent/agent-as-tool.ts:38](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent-as-tool.ts#L38)

Tool name exposed to the parent agent’s model. Must match the pattern `[a-zA-Z0-9_-]{1,64}`.

Defaults to the agent’s name. Throws if the resolved name is not a valid tool name — provide an explicit name option to override.

---

### description?

```ts
optional description?: string;
```

Defined in: [src/agent/agent-as-tool.ts:47](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent-as-tool.ts#L47)

Tool description exposed to the parent agent’s model. Helps the model understand when to use this tool.

Defaults to the agent’s description, or a generic description if the agent has no description set.

---

### preserveContext?

```ts
optional preserveContext?: boolean;
```

Defined in: [src/agent/agent-as-tool.ts:63](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent-as-tool.ts#L63)

Whether to preserve the agent’s conversation history across invocations.

When `false` (default), the agent’s messages and state are reset to the values they had at the time the tool was created, ensuring every call starts from the same baseline. The orchestrator also stores the agent’s interrupted turn, so a sub-agent interrupt can be resumed after a restart.

When `true`, the agent retains its conversation history across invocations, allowing it to build context over multiple calls. It keeps its own state on an interrupt too, so it needs its own session manager to resume after a restart.

#### Default Value

```ts
false
```

---

### delegate?

```ts
optional delegate?: boolean;
```

Defined in: [src/agent/agent-as-tool.ts:74](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent-as-tool.ts#L74)

When true, the orchestrator treats this tool’s result as the final response and exits without an additional model call.

A delegation tool’s description is automatically suffixed with an instruction telling the model that this tool should be the only tool called in the turn.

#### Default Value

```ts
false
```
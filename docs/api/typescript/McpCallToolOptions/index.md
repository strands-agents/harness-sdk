Defined in: [src/mcp/client.ts:174](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L174)

Options for MCP tool invocation.

## Properties

### signal?

```ts
optional signal?: AbortSignal;
```

Defined in: [src/mcp/client.ts:176](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L176)

AbortSignal to cancel the in-flight request.

---

### timeoutMs?

```ts
optional timeoutMs?: number;
```

Defined in: [src/mcp/client.ts:178](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L178)

Overall time limit in milliseconds for this call. Overrides `tasksConfig.pollTimeout` when tasks are configured.
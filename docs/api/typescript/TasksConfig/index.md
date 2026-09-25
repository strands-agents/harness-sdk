Defined in: [src/mcp/client.ts:46](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L46)

Configuration for MCP task-augmented tool execution.

WARNING: MCP Tasks is an experimental feature in both the MCP specification and this SDK. The API may change without notice in future versions.

Task-augmented execution is temporarily unavailable while task support is rebuilt on the MCP tasks extension ([https://github.com/strands-agents/harness-sdk/issues/1659](https://github.com/strands-agents/harness-sdk/issues/1659)). A client constructed with `tasksConfig` throws from [McpClient.callTool](/docs/api/typescript/McpClient/index.md#calltool).

## Properties

### ttl?

```ts
optional ttl?: number;
```

Defined in: [src/mcp/client.ts:48](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L48)

Time-to-live in milliseconds for task polling.

---

### pollTimeout?

```ts
optional pollTimeout?: number;
```

Defined in: [src/mcp/client.ts:51](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L51)

Maximum time in milliseconds to wait for task completion during polling.
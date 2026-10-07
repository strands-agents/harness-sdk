Defined in: [src/mcp/client.ts:82](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L82)

Per-call overrides for [McpClient.listTools](/docs/api/typescript/McpClient/index.md#listtools).

## Properties

### prefix?

```ts
optional prefix?: string;
```

Defined in: [src/mcp/client.ts:84](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L84)

Prefix for agent-facing tool names. An empty string disables a prefix set on the client.

---

### toolFilters?

```ts
optional toolFilters?: McpToolFilters;
```

Defined in: [src/mcp/client.ts:86](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L86)

Tool filters. An empty object disables filters set on the client.
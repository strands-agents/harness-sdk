Defined in: [src/mcp/client.ts:89](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L89)

Per-call overrides for [McpClient.listTools](/docs/api/typescript/McpClient/index.md#listtools).

## Properties

### prefix?

```ts
optional prefix?: string;
```

Defined in: [src/mcp/client.ts:91](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L91)

Prefix for agent-facing tool names. An empty string disables a prefix set on the client.

---

### toolFilters?

```ts
optional toolFilters?: McpToolFilters;
```

Defined in: [src/mcp/client.ts:93](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L93)

Tool filters. An empty object disables filters set on the client.
Defined in: [src/mcp/client.ts:118](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L118)

Per-call overrides for [McpClient.listTools](/docs/api/typescript/McpClient/index.md#listtools).

## Properties

### prefix?

```ts
prefix?: string;
```

Defined in: [src/mcp/client.ts:120](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L120)

Prefix for agent-facing tool names. An empty string disables a prefix set on the client.

---

### toolFilters?

```ts
toolFilters?: McpToolFilters;
```

Defined in: [src/mcp/client.ts:122](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L122)

Tool filters. An empty object disables filters set on the client.
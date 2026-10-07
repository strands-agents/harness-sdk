Defined in: [src/mcp/client.ts:74](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L74)

Filters controlling which MCP tools a client exposes.

## Properties

### allowed?

```ts
optional allowed?: McpToolMatcher[];
```

Defined in: [src/mcp/client.ts:76](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L76)

When present, only tools matching at least one matcher are exposed.

---

### rejected?

```ts
optional rejected?: McpToolMatcher[];
```

Defined in: [src/mcp/client.ts:78](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L78)

Tools matching at least one matcher are excluded, even when also allowed.
Defined in: [src/mcp/client.ts:81](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L81)

Filters controlling which MCP tools a client exposes.

## Properties

### allowed?

```ts
optional allowed?: McpToolMatcher[];
```

Defined in: [src/mcp/client.ts:83](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L83)

When present, only tools matching at least one matcher are exposed.

---

### rejected?

```ts
optional rejected?: McpToolMatcher[];
```

Defined in: [src/mcp/client.ts:85](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L85)

Tools matching at least one matcher are excluded, even when also allowed.
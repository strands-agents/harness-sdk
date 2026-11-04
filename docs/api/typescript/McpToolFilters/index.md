Defined in: [src/mcp/client.ts:104](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L104)

Filters controlling which MCP tools a client exposes.

## Properties

### allowed?

```ts
allowed?: McpToolMatcher[];
```

Defined in: [src/mcp/client.ts:106](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L106)

When present, only tools matching at least one matcher are exposed.

---

### rejected?

```ts
rejected?: McpToolMatcher[];
```

Defined in: [src/mcp/client.ts:108](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L108)

Tools matching at least one matcher are excluded, even when also allowed.
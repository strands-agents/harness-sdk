```ts
type McpTransport = Omit<Transport, "sessionId"> & {
  sessionId?: string;
};
```

Defined in: [src/mcp/client.ts:28](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L28)

Widened transport type that accepts MCP transport implementations without requiring explicit casts.

The `sessionId` member is widened to `string | undefined` so that, under `exactOptionalPropertyTypes`, transport instances whose `sessionId` getter returns `string | undefined` — including transports constructed from the legacy `@modelcontextprotocol/sdk` package — are assignable without `as Transport`. The MCP `Transport` contract’s required members (`start`, `send`, `close`) are unchanged between the legacy package and `@modelcontextprotocol/client`, so legacy instances keep working.

## Type Declaration

| Name | Type | Defined in |
| --- | --- | --- |
| `sessionId?` | `string` | [src/mcp/client.ts:28](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L28) |
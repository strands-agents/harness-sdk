```ts
type McpClientConfig = McpClientOptions & {
  transport?: McpTransport;
  url?: string | URL;
  auth?: McpClientCredentials;
  authProvider?: OAuthClientProvider;
  headers?: Record<string, string>;
};
```

Defined in: [src/mcp/client.ts:210](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L210)

Arguments for configuring an MCP Client.

## Type Declaration

| Name | Type | Description | Defined in |
| --- | --- | --- | --- |
| `transport?` | [`McpTransport`](/docs/api/typescript/McpTransport/index.md) | Pre-constructed transport. Mutually exclusive with `url`. | [src/mcp/client.ts:212](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L212) |
| `url?` | `string` | `URL` | Server URL. When provided, a StreamableHTTP transport is constructed automatically. | [src/mcp/client.ts:215](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L215) |
| `auth?` | [`McpClientCredentials`](/docs/api/typescript/McpClientCredentials/index.md) | Client credentials for OAuth machine-to-machine auth. Requires `url`. | [src/mcp/client.ts:218](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L218) |
| `authProvider?` | `OAuthClientProvider` | Custom OAuth provider for advanced auth flows. Requires `url`. Mutually exclusive with `auth`. | [src/mcp/client.ts:221](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L221) |
| `headers?` | `Record`<`string`, `string`\> | Custom headers to include on every request to the server. Requires `url`. | [src/mcp/client.ts:224](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L224) |
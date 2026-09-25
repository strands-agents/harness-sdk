```ts
type McpClientConfig = McpClientOptions & {
  transport?: McpTransport;
  url?: string | URL;
  auth?: McpClientCredentials;
  authProvider?: OAuthClientProvider;
  headers?: Record<string, string>;
};
```

Defined in: [src/mcp/client.ts:130](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L130)

Arguments for configuring an MCP Client.

## Type Declaration

| Name | Type | Description | Defined in |
| --- | --- | --- | --- |
| `transport?` | [`McpTransport`](/docs/api/typescript/McpTransport/index.md) | Pre-constructed transport. Mutually exclusive with `url`. | [src/mcp/client.ts:132](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L132) |
| `url?` | `string` | `URL` | Server URL. When provided, a StreamableHTTP transport is constructed automatically. | [src/mcp/client.ts:135](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L135) |
| `auth?` | [`McpClientCredentials`](/docs/api/typescript/McpClientCredentials/index.md) | Client credentials for OAuth machine-to-machine auth. Requires `url`. | [src/mcp/client.ts:138](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L138) |
| `authProvider?` | `OAuthClientProvider` | Custom OAuth provider for advanced auth flows. Requires `url`. Mutually exclusive with `auth`. | [src/mcp/client.ts:141](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L141) |
| `headers?` | `Record`<`string`, `string`\> | Custom headers to include on every request to the server. Requires `url`. | [src/mcp/client.ts:144](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L144) |
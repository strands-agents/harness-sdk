Defined in: [src/mcp/config.ts:52](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/config.ts#L52)

Options controlling how `McpClient.loadServers` translates config entries into clients.

## Properties

### prefixWithServerName?

```ts
optional prefixWithServerName?: boolean;
```

Defined in: [src/mcp/config.ts:59](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/config.ts#L59)

When true, servers without an explicit `prefix` use their config key as the tool name prefix, so same-named tools from different servers no longer collide. Characters outside `[A-Za-z0-9_-]` in the key (e.g. the dot in `awslabs.foo`) are replaced with `_`. Takes precedence over a default `prefix`; a server can still opt out with `prefix: ''`.
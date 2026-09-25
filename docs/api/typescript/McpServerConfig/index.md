Defined in: [src/mcp/config.ts:22](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/config.ts#L22)

Configuration for a single MCP server entry in a config file or object.

Provide either `command` (stdio transport) or `url` (streamable-http/SSE), not both. When `transport` is omitted, it is auto-detected from the fields present.

## Properties

### command?

```ts
optional command?: string;
```

Defined in: [src/mcp/config.ts:24](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/config.ts#L24)

Command to spawn (stdio transport, supports `${VAR}` or `${env:VAR}` interpolation).

---

### args?

```ts
optional args?: string[];
```

Defined in: [src/mcp/config.ts:26](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/config.ts#L26)

Arguments passed to the command (supports `${VAR}` or `${env:VAR}` interpolation).

---

### env?

```ts
optional env?: Record<string, string>;
```

Defined in: [src/mcp/config.ts:28](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/config.ts#L28)

Environment variables passed to the child process (supports `${VAR}` or `${env:VAR}` interpolation).

---

### cwd?

```ts
optional cwd?: string;
```

Defined in: [src/mcp/config.ts:30](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/config.ts#L30)

Working directory for the spawned process (supports `${VAR}` or `${env:VAR}` interpolation).

---

### url?

```ts
optional url?: string;
```

Defined in: [src/mcp/config.ts:32](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/config.ts#L32)

Server endpoint URL (streamable-http or SSE transport, supports `${VAR}` or `${env:VAR}` interpolation).

---

### headers?

```ts
optional headers?: Record<string, string>;
```

Defined in: [src/mcp/config.ts:34](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/config.ts#L34)

HTTP headers sent with every request (supports `${VAR}` or `${env:VAR}` interpolation).

---

### transport?

```ts
optional transport?: "stdio" | "sse" | "streamable-http";
```

Defined in: [src/mcp/config.ts:36](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/config.ts#L36)

Explicit transport type. When omitted, auto-detected: `command` → stdio, `url` → streamable-http.

---

### auth?

```ts
optional auth?: McpClientCredentials;
```

Defined in: [src/mcp/config.ts:38](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/config.ts#L38)

Client credentials for OAuth machine-to-machine auth (streamable-http only).

---

### prefix?

```ts
optional prefix?: string;
```

Defined in: [src/mcp/config.ts:40](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/config.ts#L40)

Prefix for agent-facing tool names (supports `${VAR}` or `${env:VAR}` interpolation).

---

### toolFilters?

```ts
optional toolFilters?: SerializableMcpToolFilters;
```

Defined in: [src/mcp/config.ts:42](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/config.ts#L42)

Filters applied to tool names (patterns support `${VAR}` or `${env:VAR}` interpolation).

---

### disabled?

```ts
optional disabled?: boolean;
```

Defined in: [src/mcp/config.ts:44](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/config.ts#L44)

When true, this server is skipped during loadServers.

---

### continueOnError?

```ts
optional continueOnError?: boolean;
```

Defined in: [src/mcp/config.ts:46](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/config.ts#L46)

When true, config or connection failures skip this server instead of throwing.

---

### tasksConfig?

```ts
optional tasksConfig?: TasksConfig;
```

Defined in: [src/mcp/config.ts:53](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/config.ts#L53)

Task-augmented tool execution configuration (experimental).

Temporarily unavailable while task support is rebuilt on the MCP tasks extension ([https://github.com/strands-agents/harness-sdk/issues/1659](https://github.com/strands-agents/harness-sdk/issues/1659)). When set, tool calls throw.
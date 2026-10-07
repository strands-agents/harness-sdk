Defined in: [src/mcp/client.ts:107](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L107)

Configuration for MCP task execution.

MCP Tasks are experimental in both the MCP specification and this SDK. The API may change without notice in future versions.

`pollTimeout` bounds the complete automatic operation, including polling and input callbacks. `requestTimeout` limits each individual lifecycle request; progress resets it. The first limit reached ends the wait. A call’s `options.timeoutMs` overrides `pollTimeout`.

Field names and defaults match the Python SDK’s `TasksConfig` (milliseconds instead of timedeltas), except that `ttl` is a deprecated alias of `requestTimeout` and no legacy wire time-to-live is sent.

## Properties

### pollTimeout?

```ts
optional pollTimeout?: number;
```

Defined in: [src/mcp/client.ts:109](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L109)

Overall deadline in milliseconds for an automatic task operation. Defaults to 300000.

---

### requestTimeout?

```ts
optional requestTimeout?: number;
```

Defined in: [src/mcp/client.ts:112](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L112)

Timeout in milliseconds for each task lifecycle request; progress resets it. Defaults to 60000.

---

### pollInterval?

```ts
optional pollInterval?: number;
```

Defined in: [src/mcp/client.ts:115](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L115)

Polling delay in milliseconds when the server omits its polling interval. Defaults to 1000.

---

### ~ttl?~

```ts
optional ttl?: number;
```

Defined in: [src/mcp/client.ts:122](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L122)

Timeout in milliseconds for each task lifecycle request.

#### Deprecated

Use `requestTimeout`, which takes precedence when both are set.
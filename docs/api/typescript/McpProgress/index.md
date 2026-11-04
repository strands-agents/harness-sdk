Defined in: [src/mcp/client.ts:72](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L72)

A progress update reported by an MCP server during a tool call.

## Properties

### progress

```ts
progress: number;
```

Defined in: [src/mcp/client.ts:74](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L74)

Amount of work completed so far. Increases even when the total is unknown.

---

### total?

```ts
total?: number;
```

Defined in: [src/mcp/client.ts:77](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L77)

Total amount of work, when the server reports one.

---

### message?

```ts
message?: string;
```

Defined in: [src/mcp/client.ts:80](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L80)

Human-readable description of the current progress, when the server provides one.
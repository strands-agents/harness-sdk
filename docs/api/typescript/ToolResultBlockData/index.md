Defined in: [src/types/messages.ts:494](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L494)

Data for a tool result block.

## Properties

### toolUseId

```ts
toolUseId: string;
```

Defined in: [src/types/messages.ts:498](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L498)

The ID of the tool use that this result corresponds to.

---

### status

```ts
status: "success" | "error";
```

Defined in: [src/types/messages.ts:503](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L503)

Status of the tool execution.

---

### content

```ts
content: ToolResultContentData[];
```

Defined in: [src/types/messages.ts:508](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L508)

The content returned by the tool.

---

### error?

```ts
error?: Error;
```

Defined in: [src/types/messages.ts:515](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L515)

The original error object when status is ‘error’. Available for inspection by hooks, error handlers, and agent loop. Tools must wrap non-Error thrown values into Error objects.
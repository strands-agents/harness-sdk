Defined in: [src/types/messages.ts:366](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L366)

Data for a tool result block.

## Properties

### toolUseId

```ts
toolUseId: string;
```

Defined in: [src/types/messages.ts:370](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L370)

The ID of the tool use that this result corresponds to.

---

### status

```ts
status: "success" | "error";
```

Defined in: [src/types/messages.ts:375](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L375)

Status of the tool execution.

---

### content

```ts
content: ToolResultContentData[];
```

Defined in: [src/types/messages.ts:380](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L380)

The content returned by the tool.

---

### error?

```ts
error?: Error;
```

Defined in: [src/types/messages.ts:387](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L387)

The original error object when status is ‘error’. Available for inspection by hooks, error handlers, and agent loop. Tools must wrap non-Error thrown values into Error objects.
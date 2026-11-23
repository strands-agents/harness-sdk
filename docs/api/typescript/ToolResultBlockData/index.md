Defined in: [src/types/messages.ts:556](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L556)

Data for a tool result block.

## Properties

### toolUseId

```ts
toolUseId: string;
```

Defined in: [src/types/messages.ts:560](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L560)

The ID of the tool use that this result corresponds to.

---

### status

```ts
status: "success" | "error";
```

Defined in: [src/types/messages.ts:565](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L565)

Status of the tool execution.

---

### content

```ts
content: ToolResultContentData[];
```

Defined in: [src/types/messages.ts:570](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L570)

The content returned by the tool.

---

### error?

```ts
error?: Error;
```

Defined in: [src/types/messages.ts:577](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L577)

The original error object when status is ‘error’. Available for inspection by hooks, error handlers, and agent loop. Tools must wrap non-Error thrown values into Error objects.
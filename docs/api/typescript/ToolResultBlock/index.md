Defined in: [src/types/messages.ts:393](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L393)

Tool result content block.

## Implements

-   `JSONSerializable`<{ `toolResult`: [`ToolResultBlockData`](/docs/api/typescript/ToolResultBlockData/index.md); }>

## Constructors

### Constructor

```ts
new ToolResultBlock(data): ToolResultBlock;
```

Defined in: [src/types/messages.ts:421](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L421)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | { `toolUseId`: `string`; `status`: `"success"` | `"error"`; `content`: [`ToolResultContent`](/docs/api/typescript/ToolResultContent/index.md)\[\]; `error?`: `Error`; } |
| `data.toolUseId` | `string` |
| `data.status` | `"success"` | `"error"` |
| `data.content` | [`ToolResultContent`](/docs/api/typescript/ToolResultContent/index.md)\[\] |
| `data.error?` | `Error` |

#### Returns

`ToolResultBlock`

## Properties

### type

```ts
readonly type: "toolResultBlock";
```

Defined in: [src/types/messages.ts:397](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L397)

Discriminator for tool result content.

---

### toolUseId

```ts
readonly toolUseId: string;
```

Defined in: [src/types/messages.ts:402](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L402)

The ID of the tool use that this result corresponds to.

---

### status

```ts
readonly status: "success" | "error";
```

Defined in: [src/types/messages.ts:407](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L407)

Status of the tool execution.

---

### content

```ts
readonly content: ToolResultContent[];
```

Defined in: [src/types/messages.ts:412](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L412)

The content returned by the tool.

---

### error?

```ts
readonly error?: Error;
```

Defined in: [src/types/messages.ts:419](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L419)

The original error object when status is ‘error’. Available for inspection by hooks, error handlers, and agent loop. Tools must wrap non-Error thrown values into Error objects.

## Methods

### toJSON()

```ts
toJSON(): {
  toolResult: ToolResultBlockData;
};
```

Defined in: [src/types/messages.ts:435](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L435)

Serializes the ToolResultBlock to a JSON-compatible ContentBlockData object. Called automatically by JSON.stringify(). Note: The error field is not serialized (deferred for future implementation).

#### Returns

```ts
{
  toolResult: ToolResultBlockData;
}
```

| Name | Type | Defined in |
| --- | --- | --- |
| `toolResult` | [`ToolResultBlockData`](/docs/api/typescript/ToolResultBlockData/index.md) | [src/types/messages.ts:435](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L435) |

#### Implementation of

`JSONSerializable.toJSON`

---

### fromJSON()

```ts
static fromJSON(data): ToolResultBlock;
```

Defined in: [src/types/messages.ts:451](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L451)

Creates a ToolResultBlock instance from its wrapped data format.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `data` | { `toolResult`: [`ToolResultBlockData`](/docs/api/typescript/ToolResultBlockData/index.md); } | Wrapped ToolResultBlockData to deserialize |
| `data.toolResult` | [`ToolResultBlockData`](/docs/api/typescript/ToolResultBlockData/index.md) | \- |

#### Returns

`ToolResultBlock`

ToolResultBlock instance
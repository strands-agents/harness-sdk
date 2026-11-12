Defined in: [src/types/messages.ts:521](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L521)

Tool result content block.

## Implements

-   `JSONSerializable`<{ `toolResult`: [`ToolResultBlockData`](/docs/api/typescript/ToolResultBlockData/index.md); }>

## Constructors

### Constructor

```ts
new ToolResultBlock(data): ToolResultBlock;
```

Defined in: [src/types/messages.ts:549](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L549)

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

Defined in: [src/types/messages.ts:525](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L525)

Discriminator for tool result content.

---

### toolUseId

```ts
readonly toolUseId: string;
```

Defined in: [src/types/messages.ts:530](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L530)

The ID of the tool use that this result corresponds to.

---

### status

```ts
readonly status: "success" | "error";
```

Defined in: [src/types/messages.ts:535](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L535)

Status of the tool execution.

---

### content

```ts
readonly content: ToolResultContent[];
```

Defined in: [src/types/messages.ts:540](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L540)

The content returned by the tool.

---

### error?

```ts
readonly error?: Error;
```

Defined in: [src/types/messages.ts:547](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L547)

The original error object when status is ‘error’. Available for inspection by hooks, error handlers, and agent loop. Tools must wrap non-Error thrown values into Error objects.

## Methods

### with()

```ts
with(overrides): ToolResultBlock;
```

Defined in: [src/types/messages.ts:567](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L567)

**`Experimental`**

A shallow copy of this result with the given content in place of its own. The copy keeps this result’s tool use id, status, and error. Content left out, or set to `undefined`, keeps this result’s content.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `overrides` | { `content?`: [`ToolResultContent`](/docs/api/typescript/ToolResultContent/index.md)\[\]; } | The content of the copy |
| `overrides.content?` | [`ToolResultContent`](/docs/api/typescript/ToolResultContent/index.md)\[\] | \- |

#### Returns

`ToolResultBlock`

The copy

---

### toJSON()

```ts
toJSON(): {
  toolResult: ToolResultBlockData;
};
```

Defined in: [src/types/messages.ts:581](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L581)

Serializes the ToolResultBlock to a JSON-compatible ContentBlockData object. Called automatically by JSON.stringify(). Note: The error field is not serialized (deferred for future implementation).

#### Returns

```ts
{
  toolResult: ToolResultBlockData;
}
```

| Name | Type | Defined in |
| --- | --- | --- |
| `toolResult` | [`ToolResultBlockData`](/docs/api/typescript/ToolResultBlockData/index.md) | [src/types/messages.ts:581](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L581) |

#### Implementation of

`JSONSerializable.toJSON`

---

### fromJSON()

```ts
static fromJSON(data): ToolResultBlock;
```

Defined in: [src/types/messages.ts:598](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L598)

Creates a ToolResultBlock instance from its wrapped data format. Content of a type this version does not recognize becomes an [UnknownBlock](/docs/api/typescript/UnknownBlock/index.md), so data a newer SDK version saved still loads.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `data` | { `toolResult`: [`ToolResultBlockData`](/docs/api/typescript/ToolResultBlockData/index.md); } | Wrapped ToolResultBlockData to deserialize |
| `data.toolResult` | [`ToolResultBlockData`](/docs/api/typescript/ToolResultBlockData/index.md) | \- |

#### Returns

`ToolResultBlock`

ToolResultBlock instance
Defined in: [src/types/messages.ts:719](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L719)

Reasoning content block within a message.

## Implements

-   [`ReasoningBlockData`](/docs/api/typescript/ReasoningBlockData/index.md)
-   `JSONSerializable`<{ `reasoning`: `Serialized`<[`ReasoningBlockData`](/docs/api/typescript/ReasoningBlockData/index.md)\>; }>

## Constructors

### Constructor

```ts
new ReasoningBlock(data): ReasoningBlock;
```

Defined in: [src/types/messages.ts:742](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L742)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | [`ReasoningBlockData`](/docs/api/typescript/ReasoningBlockData/index.md) |

#### Returns

`ReasoningBlock`

## Properties

### type

```ts
readonly type: "reasoningBlock";
```

Defined in: [src/types/messages.ts:725](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L725)

Discriminator for reasoning content.

---

### text?

```ts
readonly text?: string;
```

Defined in: [src/types/messages.ts:730](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L730)

The text content of the reasoning process.

#### Implementation of

[`ReasoningBlockData`](/docs/api/typescript/ReasoningBlockData/index.md).[`text`](/docs/api/typescript/ReasoningBlockData/index.md#text)

---

### signature?

```ts
readonly signature?: string;
```

Defined in: [src/types/messages.ts:735](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L735)

A cryptographic signature for verification purposes.

#### Implementation of

[`ReasoningBlockData`](/docs/api/typescript/ReasoningBlockData/index.md).[`signature`](/docs/api/typescript/ReasoningBlockData/index.md#signature)

---

### redactedContent?

```ts
readonly redactedContent?: Uint8Array;
```

Defined in: [src/types/messages.ts:740](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L740)

The redacted content of the reasoning process.

#### Implementation of

[`ReasoningBlockData`](/docs/api/typescript/ReasoningBlockData/index.md).[`redactedContent`](/docs/api/typescript/ReasoningBlockData/index.md#redactedcontent)

## Methods

### toJSON()

```ts
toJSON(): {
  reasoning: {
     text?: string;
     signature?: string;
     redactedContent?: string;
  };
};
```

Defined in: [src/types/messages.ts:759](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L759)

Serializes the ReasoningBlock to a JSON-compatible ContentBlockData object. Called automatically by JSON.stringify(). Uint8Array redactedContent is encoded as base64 string.

#### Returns

```ts
{
  reasoning: {
     text?: string;
     signature?: string;
     redactedContent?: string;
  };
}
```

| Name | Type | Description | Defined in |
| --- | --- | --- | --- |
| `reasoning` | { `text?`: `string`; `signature?`: `string`; `redactedContent?`: `string`; } | \- | [src/types/messages.ts:759](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L759) |
| `reasoning.text?` | `string` | The text content of the reasoning process. | [src/types/messages.ts:703](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L703) |
| `reasoning.signature?` | `string` | A cryptographic signature for verification purposes. | [src/types/messages.ts:708](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L708) |
| `reasoning.redactedContent?` | `string` | The redacted content of the reasoning process. | [src/types/messages.ts:713](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L713) |

#### Implementation of

`JSONSerializable.toJSON`

---

### fromJSON()

```ts
static fromJSON(data): ReasoningBlock;
```

Defined in: [src/types/messages.ts:776](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L776)

Creates a ReasoningBlock instance from its wrapped data format. Base64-encoded redactedContent is decoded back to Uint8Array.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `data` | { `reasoning`: { `text?`: `string`; `signature?`: `string`; `redactedContent?`: `string` | `Uint8Array`<`ArrayBufferLike`\>; }; } | Wrapped ReasoningBlockData to deserialize (accepts both string and Uint8Array for redactedContent) |
| `data.reasoning` | { `text?`: `string`; `signature?`: `string`; `redactedContent?`: `string` | `Uint8Array`<`ArrayBufferLike`\>; } | \- |
| `data.reasoning.text?` | `string` | The text content of the reasoning process. |
| `data.reasoning.signature?` | `string` | A cryptographic signature for verification purposes. |
| `data.reasoning.redactedContent?` | `string` | `Uint8Array`<`ArrayBufferLike`\> | The redacted content of the reasoning process. |

#### Returns

`ReasoningBlock`

ReasoningBlock instance
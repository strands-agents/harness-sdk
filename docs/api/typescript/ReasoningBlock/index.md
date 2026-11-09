Defined in: [src/types/messages.ts:500](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L500)

Reasoning content block within a message.

## Implements

-   [`ReasoningBlockData`](/docs/api/typescript/ReasoningBlockData/index.md)
-   `JSONSerializable`<{ `reasoning`: `Serialized`<[`ReasoningBlockData`](/docs/api/typescript/ReasoningBlockData/index.md)\>; }>

## Constructors

### Constructor

```ts
new ReasoningBlock(data): ReasoningBlock;
```

Defined in: [src/types/messages.ts:523](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L523)

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

Defined in: [src/types/messages.ts:506](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L506)

Discriminator for reasoning content.

---

### text?

```ts
readonly text?: string;
```

Defined in: [src/types/messages.ts:511](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L511)

The text content of the reasoning process.

#### Implementation of

[`ReasoningBlockData`](/docs/api/typescript/ReasoningBlockData/index.md).[`text`](/docs/api/typescript/ReasoningBlockData/index.md#text)

---

### signature?

```ts
readonly signature?: string;
```

Defined in: [src/types/messages.ts:516](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L516)

A cryptographic signature for verification purposes.

#### Implementation of

[`ReasoningBlockData`](/docs/api/typescript/ReasoningBlockData/index.md).[`signature`](/docs/api/typescript/ReasoningBlockData/index.md#signature)

---

### redactedContent?

```ts
readonly redactedContent?: Uint8Array;
```

Defined in: [src/types/messages.ts:521](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L521)

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

Defined in: [src/types/messages.ts:540](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L540)

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
| `reasoning` | { `text?`: `string`; `signature?`: `string`; `redactedContent?`: `string`; } | \- | [src/types/messages.ts:540](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L540) |
| `reasoning.text?` | `string` | The text content of the reasoning process. | [src/types/messages.ts:484](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L484) |
| `reasoning.signature?` | `string` | A cryptographic signature for verification purposes. | [src/types/messages.ts:489](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L489) |
| `reasoning.redactedContent?` | `string` | The redacted content of the reasoning process. | [src/types/messages.ts:494](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L494) |

#### Implementation of

`JSONSerializable.toJSON`

---

### fromJSON()

```ts
static fromJSON(data): ReasoningBlock;
```

Defined in: [src/types/messages.ts:557](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L557)

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
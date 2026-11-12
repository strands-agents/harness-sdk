Defined in: [src/types/messages.ts:656](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L656)

Reasoning content block within a message.

## Implements

-   [`ReasoningBlockData`](/docs/api/typescript/ReasoningBlockData/index.md)
-   `JSONSerializable`<{ `reasoning`: `Serialized`<[`ReasoningBlockData`](/docs/api/typescript/ReasoningBlockData/index.md)\>; }>

## Constructors

### Constructor

```ts
new ReasoningBlock(data): ReasoningBlock;
```

Defined in: [src/types/messages.ts:679](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L679)

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

Defined in: [src/types/messages.ts:662](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L662)

Discriminator for reasoning content.

---

### text?

```ts
readonly text?: string;
```

Defined in: [src/types/messages.ts:667](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L667)

The text content of the reasoning process.

#### Implementation of

[`ReasoningBlockData`](/docs/api/typescript/ReasoningBlockData/index.md).[`text`](/docs/api/typescript/ReasoningBlockData/index.md#text)

---

### signature?

```ts
readonly signature?: string;
```

Defined in: [src/types/messages.ts:672](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L672)

A cryptographic signature for verification purposes.

#### Implementation of

[`ReasoningBlockData`](/docs/api/typescript/ReasoningBlockData/index.md).[`signature`](/docs/api/typescript/ReasoningBlockData/index.md#signature)

---

### redactedContent?

```ts
readonly redactedContent?: Uint8Array;
```

Defined in: [src/types/messages.ts:677](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L677)

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

Defined in: [src/types/messages.ts:696](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L696)

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
| `reasoning` | { `text?`: `string`; `signature?`: `string`; `redactedContent?`: `string`; } | \- | [src/types/messages.ts:696](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L696) |
| `reasoning.text?` | `string` | The text content of the reasoning process. | [src/types/messages.ts:640](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L640) |
| `reasoning.signature?` | `string` | A cryptographic signature for verification purposes. | [src/types/messages.ts:645](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L645) |
| `reasoning.redactedContent?` | `string` | The redacted content of the reasoning process. | [src/types/messages.ts:650](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L650) |

#### Implementation of

`JSONSerializable.toJSON`

---

### fromJSON()

```ts
static fromJSON(data): ReasoningBlock;
```

Defined in: [src/types/messages.ts:713](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L713)

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
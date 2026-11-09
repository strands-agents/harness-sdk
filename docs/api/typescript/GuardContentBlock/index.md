Defined in: [src/types/messages.ts:995](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L995)

Guard content block for guardrail evaluation. Marks content that should be evaluated by guardrails for safety, grounding, or other policies. Can be used in both message content and system prompts.

## Implements

-   [`GuardContentBlockData`](/docs/api/typescript/GuardContentBlockData/index.md)
-   `JSONSerializable`<{ `guardContent`: `Serialized`<[`GuardContentBlockData`](/docs/api/typescript/GuardContentBlockData/index.md)\>; }>

## Constructors

### Constructor

```ts
new GuardContentBlock(data): GuardContentBlock;
```

Defined in: [src/types/messages.ts:1013](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1013)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | [`GuardContentBlockData`](/docs/api/typescript/GuardContentBlockData/index.md) |

#### Returns

`GuardContentBlock`

## Properties

### type

```ts
readonly type: "guardContentBlock";
```

Defined in: [src/types/messages.ts:1001](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1001)

Discriminator for guard content.

---

### text?

```ts
readonly text?: GuardContentText;
```

Defined in: [src/types/messages.ts:1006](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1006)

Text content with evaluation qualifiers.

#### Implementation of

[`GuardContentBlockData`](/docs/api/typescript/GuardContentBlockData/index.md).[`text`](/docs/api/typescript/GuardContentBlockData/index.md#text)

---

### image?

```ts
readonly image?: GuardContentImage;
```

Defined in: [src/types/messages.ts:1011](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1011)

Image content with evaluation qualifiers.

#### Implementation of

[`GuardContentBlockData`](/docs/api/typescript/GuardContentBlockData/index.md).[`image`](/docs/api/typescript/GuardContentBlockData/index.md#image)

## Methods

### toJSON()

```ts
toJSON(): {
  guardContent: {
     text?: {
        qualifiers: GuardQualifier[];
        text: string;
     };
     image?: {
        format: GuardImageFormat;
        source: {
           bytes: string;
        };
     };
  };
};
```

Defined in: [src/types/messages.ts:1033](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1033)

Serializes the GuardContentBlock to a JSON-compatible ContentBlockData object. Called automatically by JSON.stringify(). Uint8Array image bytes are encoded as base64 string.

#### Returns

```ts
{
  guardContent: {
     text?: {
        qualifiers: GuardQualifier[];
        text: string;
     };
     image?: {
        format: GuardImageFormat;
        source: {
           bytes: string;
        };
     };
  };
}
```

| Name | Type | Description | Defined in |
| --- | --- | --- | --- |
| `guardContent` | { `text?`: { `qualifiers`: [`GuardQualifier`](/docs/api/typescript/GuardQualifier/index.md)\[\]; `text`: `string`; }; `image?`: { `format`: [`GuardImageFormat`](/docs/api/typescript/GuardImageFormat/index.md); `source`: { `bytes`: `string`; }; }; } | \- | [src/types/messages.ts:1033](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1033) |
| `guardContent.text?` | { `qualifiers`: [`GuardQualifier`](/docs/api/typescript/GuardQualifier/index.md)\[\]; `text`: `string`; } | Text content with evaluation qualifiers. | [src/types/messages.ts:982](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L982) |
| `guardContent.text.qualifiers` | [`GuardQualifier`](/docs/api/typescript/GuardQualifier/index.md)\[\] | Qualifiers that specify how this content should be evaluated. | [src/types/messages.ts:951](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L951) |
| `guardContent.text.text` | `string` | The text content to be evaluated. | [src/types/messages.ts:956](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L956) |
| `guardContent.image?` | { `format`: [`GuardImageFormat`](/docs/api/typescript/GuardImageFormat/index.md); `source`: { `bytes`: `string`; }; } | Image content with evaluation qualifiers. | [src/types/messages.ts:987](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L987) |
| `guardContent.image.format` | [`GuardImageFormat`](/docs/api/typescript/GuardImageFormat/index.md) | Image format. | [src/types/messages.ts:966](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L966) |
| `guardContent.image.source` | { `bytes`: `string`; } | Image source (bytes only). | [src/types/messages.ts:971](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L971) |
| `guardContent.image.source.bytes` | `string` | \- | [src/types/messages.ts:942](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L942) |

#### Implementation of

`JSONSerializable.toJSON`

---

### fromJSON()

```ts
static fromJSON(data): GuardContentBlock;
```

Defined in: [src/types/messages.ts:1054](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1054)

Creates a GuardContentBlock instance from its wrapped data format. Base64-encoded image bytes are decoded back to Uint8Array.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `data` | { `guardContent`: { `text?`: { `qualifiers`: [`GuardQualifier`](/docs/api/typescript/GuardQualifier/index.md)\[\]; `text`: `string`; }; `image?`: { `format`: [`GuardImageFormat`](/docs/api/typescript/GuardImageFormat/index.md); `source`: { `bytes`: `string` | `Uint8Array`<`ArrayBufferLike`\>; }; }; }; } | Wrapped GuardContentBlockData to deserialize (accepts both string and Uint8Array for image bytes) |
| `data.guardContent` | { `text?`: { `qualifiers`: [`GuardQualifier`](/docs/api/typescript/GuardQualifier/index.md)\[\]; `text`: `string`; }; `image?`: { `format`: [`GuardImageFormat`](/docs/api/typescript/GuardImageFormat/index.md); `source`: { `bytes`: `string` | `Uint8Array`<`ArrayBufferLike`\>; }; }; } | \- |
| `data.guardContent.text?` | { `qualifiers`: [`GuardQualifier`](/docs/api/typescript/GuardQualifier/index.md)\[\]; `text`: `string`; } | Text content with evaluation qualifiers. |
| `data.guardContent.text.qualifiers` | [`GuardQualifier`](/docs/api/typescript/GuardQualifier/index.md)\[\] | Qualifiers that specify how this content should be evaluated. |
| `data.guardContent.text.text` | `string` | The text content to be evaluated. |
| `data.guardContent.image?` | { `format`: [`GuardImageFormat`](/docs/api/typescript/GuardImageFormat/index.md); `source`: { `bytes`: `string` | `Uint8Array`<`ArrayBufferLike`\>; }; } | Image content with evaluation qualifiers. |
| `data.guardContent.image.format` | [`GuardImageFormat`](/docs/api/typescript/GuardImageFormat/index.md) | Image format. |
| `data.guardContent.image.source` | { `bytes`: `string` | `Uint8Array`<`ArrayBufferLike`\>; } | Image source (bytes only). |
| `data.guardContent.image.source.bytes` | `string` | `Uint8Array`<`ArrayBufferLike`\> | \- |

#### Returns

`GuardContentBlock`

GuardContentBlock instance
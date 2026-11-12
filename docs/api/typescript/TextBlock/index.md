Defined in: [src/types/messages.ts:259](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L259)

Text content block within a message.

## Extended by

-   [`OffloadedBlock`](/docs/api/typescript/OffloadedBlock/index.md)

## Implements

-   [`TextBlockData`](/docs/api/typescript/TextBlockData/index.md)
-   `JSONSerializable`<[`TextBlockData`](/docs/api/typescript/TextBlockData/index.md)\>

## Constructors

### Constructor

```ts
new TextBlock(data): TextBlock;
```

Defined in: [src/types/messages.ts:270](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L270)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | `string` |

#### Returns

`TextBlock`

## Properties

### type

```ts
readonly type: "textBlock";
```

Defined in: [src/types/messages.ts:263](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L263)

Discriminator for text content.

---

### text

```ts
readonly text: string;
```

Defined in: [src/types/messages.ts:268](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L268)

Plain text content.

#### Implementation of

[`TextBlockData`](/docs/api/typescript/TextBlockData/index.md).[`text`](/docs/api/typescript/TextBlockData/index.md#text)

## Methods

### toJSON()

```ts
toJSON(): TextBlockData;
```

Defined in: [src/types/messages.ts:278](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L278)

Serializes the TextBlock to a JSON-compatible TextBlockData object. Called automatically by JSON.stringify().

#### Returns

[`TextBlockData`](/docs/api/typescript/TextBlockData/index.md)

#### Implementation of

`JSONSerializable.toJSON`

---

### fromJSON()

```ts
static fromJSON(data): TextBlock;
```

Defined in: [src/types/messages.ts:288](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L288)

Creates a TextBlock instance from TextBlockData.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `data` | [`TextBlockData`](/docs/api/typescript/TextBlockData/index.md) | TextBlockData to deserialize |

#### Returns

`TextBlock`

TextBlock instance
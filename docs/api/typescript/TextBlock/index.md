Defined in: [src/types/messages.ts:221](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L221)

Text content block within a message.

## Implements

-   [`TextBlockData`](/docs/api/typescript/TextBlockData/index.md)
-   `JSONSerializable`<[`TextBlockData`](/docs/api/typescript/TextBlockData/index.md)\>

## Constructors

### Constructor

```ts
new TextBlock(data): TextBlock;
```

Defined in: [src/types/messages.ts:232](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L232)

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

Defined in: [src/types/messages.ts:225](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L225)

Discriminator for text content.

---

### text

```ts
readonly text: string;
```

Defined in: [src/types/messages.ts:230](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L230)

Plain text content.

#### Implementation of

[`TextBlockData`](/docs/api/typescript/TextBlockData/index.md).[`text`](/docs/api/typescript/TextBlockData/index.md#text)

## Methods

### toJSON()

```ts
toJSON(): TextBlockData;
```

Defined in: [src/types/messages.ts:240](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L240)

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

Defined in: [src/types/messages.ts:250](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L250)

Creates a TextBlock instance from TextBlockData.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `data` | [`TextBlockData`](/docs/api/typescript/TextBlockData/index.md) | TextBlockData to deserialize |

#### Returns

`TextBlock`

TextBlock instance
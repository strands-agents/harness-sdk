Defined in: [src/types/messages.ts:1303](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1303)

Content block of a type this SDK version does not recognize, kept when restoring data a newer version saved. Holds the raw data so it serializes back unchanged. Model providers skip it.

## Implements

-   `JSONSerializable`<`Record`<`string`, `unknown`\>>

## Constructors

### Constructor

```ts
new UnknownBlock(data): UnknownBlock;
```

Defined in: [src/types/messages.ts:1314](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1314)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | `Record`<`string`, `unknown`\> |

#### Returns

`UnknownBlock`

## Properties

### type

```ts
readonly type: "unknownBlock";
```

Defined in: [src/types/messages.ts:1307](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1307)

Discriminator for unrecognized content.

---

### data

```ts
readonly data: Record<string, unknown>;
```

Defined in: [src/types/messages.ts:1312](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1312)

The raw content block data.

## Methods

### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

Defined in: [src/types/messages.ts:1322](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1322)

Returns the raw content block data unchanged. Called automatically by JSON.stringify().

#### Returns

`Record`<`string`, `unknown`\>

#### Implementation of

`JSONSerializable.toJSON`

---

### fromJSON()

```ts
static fromJSON(data): UnknownBlock;
```

Defined in: [src/types/messages.ts:1332](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1332)

Creates an UnknownBlock instance from raw content block data.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `data` | `Record`<`string`, `unknown`\> | Raw content block data |

#### Returns

`UnknownBlock`

UnknownBlock instance
Defined in: [src/types/messages.ts:1366](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1366)

Content block of a type this SDK version does not recognize, kept when restoring data a newer version saved. Holds the raw data so it serializes back unchanged. Model providers skip it.

## Implements

-   `JSONSerializable`<`Record`<`string`, `unknown`\>>

## Constructors

### Constructor

```ts
new UnknownBlock(data): UnknownBlock;
```

Defined in: [src/types/messages.ts:1377](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1377)

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

Defined in: [src/types/messages.ts:1370](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1370)

Discriminator for unrecognized content.

---

### data

```ts
readonly data: Record<string, unknown>;
```

Defined in: [src/types/messages.ts:1375](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1375)

The raw content block data.

## Methods

### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

Defined in: [src/types/messages.ts:1385](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1385)

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

Defined in: [src/types/messages.ts:1395](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1395)

Creates an UnknownBlock instance from raw content block data.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `data` | `Record`<`string`, `unknown`\> | Raw content block data |

#### Returns

`UnknownBlock`

UnknownBlock instance
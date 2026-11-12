Defined in: [src/types/messages.ts:894](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L894)

JSON content block within a message. Used for structured data returned from tools or model responses.

## Implements

-   `JsonBlockData`
-   `JSONSerializable`<`JsonBlockData`\>

## Constructors

### Constructor

```ts
new JsonBlock(data): JsonBlock;
```

Defined in: [src/types/messages.ts:905](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L905)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | `JsonBlockData` |

#### Returns

`JsonBlock`

## Properties

### type

```ts
readonly type: "jsonBlock";
```

Defined in: [src/types/messages.ts:898](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L898)

Discriminator for JSON content.

---

### json

```ts
readonly json: JSONValue;
```

Defined in: [src/types/messages.ts:903](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L903)

Structured JSON data.

#### Implementation of

`JsonBlockData.json`

## Methods

### toJSON()

```ts
toJSON(): JsonBlockData;
```

Defined in: [src/types/messages.ts:913](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L913)

Serializes the JsonBlock to a JSON-compatible JsonBlockData object. Called automatically by JSON.stringify().

#### Returns

`JsonBlockData`

#### Implementation of

`JSONSerializable.toJSON`

---

### fromJSON()

```ts
static fromJSON(data): JsonBlock;
```

Defined in: [src/types/messages.ts:923](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L923)

Creates a JsonBlock instance from JsonBlockData.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `data` | `JsonBlockData` | JsonBlockData to deserialize |

#### Returns

`JsonBlock`

JsonBlock instance
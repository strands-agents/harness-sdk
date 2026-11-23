Defined in: [src/types/messages.ts:957](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L957)

JSON content block within a message. Used for structured data returned from tools or model responses.

## Implements

-   `JsonBlockData`
-   `JSONSerializable`<`JsonBlockData`\>

## Constructors

### Constructor

```ts
new JsonBlock(data): JsonBlock;
```

Defined in: [src/types/messages.ts:968](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L968)

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

Defined in: [src/types/messages.ts:961](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L961)

Discriminator for JSON content.

---

### json

```ts
readonly json: JSONValue;
```

Defined in: [src/types/messages.ts:966](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L966)

Structured JSON data.

#### Implementation of

`JsonBlockData.json`

## Methods

### toJSON()

```ts
toJSON(): JsonBlockData;
```

Defined in: [src/types/messages.ts:976](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L976)

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

Defined in: [src/types/messages.ts:986](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L986)

Creates a JsonBlock instance from JsonBlockData.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `data` | `JsonBlockData` | JsonBlockData to deserialize |

#### Returns

`JsonBlock`

JsonBlock instance
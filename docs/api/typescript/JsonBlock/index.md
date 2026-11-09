Defined in: [src/types/messages.ts:738](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L738)

JSON content block within a message. Used for structured data returned from tools or model responses.

## Implements

-   `JsonBlockData`
-   `JSONSerializable`<`JsonBlockData`\>

## Constructors

### Constructor

```ts
new JsonBlock(data): JsonBlock;
```

Defined in: [src/types/messages.ts:749](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L749)

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

Defined in: [src/types/messages.ts:742](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L742)

Discriminator for JSON content.

---

### json

```ts
readonly json: JSONValue;
```

Defined in: [src/types/messages.ts:747](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L747)

Structured JSON data.

#### Implementation of

`JsonBlockData.json`

## Methods

### toJSON()

```ts
toJSON(): JsonBlockData;
```

Defined in: [src/types/messages.ts:757](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L757)

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

Defined in: [src/types/messages.ts:767](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L767)

Creates a JsonBlock instance from JsonBlockData.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `data` | `JsonBlockData` | JsonBlockData to deserialize |

#### Returns

`JsonBlock`

JsonBlock instance
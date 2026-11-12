Defined in: [src/types/messages.ts:828](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L828)

A summary of earlier conversation history that takes the summarized messages’ place.

Through an agent, a model without `serverSideSummary`, or one that did not write it (`provider`), gets the text.

## Implements

-   [`SummaryBlockData`](/docs/api/typescript/SummaryBlockData/index.md)
-   `JSONSerializable`<{ `summary`: [`SummaryBlockData`](/docs/api/typescript/SummaryBlockData/index.md); }>

## Constructors

### Constructor

```ts
new SummaryBlock(data): SummaryBlock;
```

Defined in: [src/types/messages.ts:849](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L849)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | [`SummaryBlockData`](/docs/api/typescript/SummaryBlockData/index.md) |

#### Returns

`SummaryBlock`

## Properties

### type

```ts
readonly type: "summaryBlock";
```

Defined in: [src/types/messages.ts:832](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L832)

Discriminator for summary content.

---

### provider?

```ts
readonly provider?: string;
```

Defined in: [src/types/messages.ts:837](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L837)

Name of the provider that wrote the summary server-side, for example `'anthropic'`.

#### Implementation of

[`SummaryBlockData`](/docs/api/typescript/SummaryBlockData/index.md).[`provider`](/docs/api/typescript/SummaryBlockData/index.md#provider)

---

### signature?

```ts
readonly signature?: string;
```

Defined in: [src/types/messages.ts:842](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L842)

Signature the provider returned with the summary, sent back unchanged.

#### Implementation of

[`SummaryBlockData`](/docs/api/typescript/SummaryBlockData/index.md).[`signature`](/docs/api/typescript/SummaryBlockData/index.md#signature)

---

### text

```ts
readonly text: string;
```

Defined in: [src/types/messages.ts:847](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L847)

The summary text.

#### Implementation of

[`SummaryBlockData`](/docs/api/typescript/SummaryBlockData/index.md).[`text`](/docs/api/typescript/SummaryBlockData/index.md#text)

## Methods

### toJSON()

```ts
toJSON(): {
  summary: SummaryBlockData;
};
```

Defined in: [src/types/messages.ts:859](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L859)

Serializes the SummaryBlock to a JSON-compatible ContentBlockData object. Called automatically by JSON.stringify().

#### Returns

```ts
{
  summary: SummaryBlockData;
}
```

| Name | Type | Defined in |
| --- | --- | --- |
| `summary` | [`SummaryBlockData`](/docs/api/typescript/SummaryBlockData/index.md) | [src/types/messages.ts:859](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L859) |

#### Implementation of

`JSONSerializable.toJSON`

---

### fromJSON()

```ts
static fromJSON(data): SummaryBlock;
```

Defined in: [src/types/messages.ts:875](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L875)

Creates a SummaryBlock instance from its wrapped data format.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `data` | { `summary`: [`SummaryBlockData`](/docs/api/typescript/SummaryBlockData/index.md); } | Wrapped SummaryBlockData to deserialize |
| `data.summary` | [`SummaryBlockData`](/docs/api/typescript/SummaryBlockData/index.md) | \- |

#### Returns

`SummaryBlock`

SummaryBlock instance
Defined in: [src/types/messages.ts:325](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L325)

**`Experimental`**

The text a context-manager strategy left in place of content it offloaded, recording what that content was.

A text block to every reader of `agent.messages` and to every model provider — `type` stays `'textBlock'`, since the content really is text — so only code that cares about the provenance narrows to it with `instanceof`.

## Extends

-   [`TextBlock`](/docs/api/typescript/TextBlock/index.md)

## Implements

-   [`OffloadedBlockData`](/docs/api/typescript/OffloadedBlockData/index.md)

## Constructors

### Constructor

```ts
new OffloadedBlock(data): OffloadedBlock;
```

Defined in: [src/types/messages.ts:342](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L342)

**`Experimental`**

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | [`OffloadedBlockData`](/docs/api/typescript/OffloadedBlockData/index.md) |

#### Returns

`OffloadedBlock`

#### Overrides

[`TextBlock`](/docs/api/typescript/TextBlock/index.md).[`constructor`](/docs/api/typescript/TextBlock/index.md#constructor)

## Properties

### type

```ts
readonly type: "textBlock";
```

Defined in: [src/types/messages.ts:263](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L263)

**`Experimental`**

Discriminator for text content.

#### Inherited from

[`TextBlock`](/docs/api/typescript/TextBlock/index.md).[`type`](/docs/api/typescript/TextBlock/index.md#type)

---

### text

```ts
readonly text: string;
```

Defined in: [src/types/messages.ts:268](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L268)

**`Experimental`**

Plain text content.

#### Implementation of

[`OffloadedBlockData`](/docs/api/typescript/OffloadedBlockData/index.md).[`text`](/docs/api/typescript/OffloadedBlockData/index.md#text)

#### Inherited from

[`TextBlock`](/docs/api/typescript/TextBlock/index.md).[`text`](/docs/api/typescript/TextBlock/index.md#text)

---

### method

```ts
readonly method: OffloadMethod;
```

Defined in: [src/types/messages.ts:329](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L329)

**`Experimental`**

Offload method that left the placeholder.

#### Implementation of

[`OffloadedBlockData`](/docs/api/typescript/OffloadedBlockData/index.md).[`method`](/docs/api/typescript/OffloadedBlockData/index.md#method)

---

### ref?

```ts
readonly ref?: string;
```

Defined in: [src/types/messages.ts:334](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L334)

**`Experimental`**

Stash reference under which the original is retrievable; absent when it was not stashed.

#### Implementation of

[`OffloadedBlockData`](/docs/api/typescript/OffloadedBlockData/index.md).[`ref`](/docs/api/typescript/OffloadedBlockData/index.md#ref)

---

### tokens?

```ts
readonly tokens?: number;
```

Defined in: [src/types/messages.ts:340](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L340)

**`Experimental`**

Size of the content this placeholder stands for, in tokens, including any placeholder it replaced; absent when the token count could not measure it.

#### Implementation of

[`OffloadedBlockData`](/docs/api/typescript/OffloadedBlockData/index.md).[`tokens`](/docs/api/typescript/OffloadedBlockData/index.md#tokens)

## Methods

### toJSON()

```ts
toJSON(): TextBlockData & {
  offloaded: Omit<OffloadedBlockData, "text">;
};
```

Defined in: [src/types/messages.ts:356](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L356)

**`Experimental`**

Serializes the OffloadedBlock to a JSON-compatible object, with its provenance under `offloaded`. Called automatically by JSON.stringify().

One key holds the provenance so a text block’s own data keeps the rest of the namespace, and so the presence of that key alone decides whether stored data is a placeholder.

#### Returns

[`TextBlockData`](/docs/api/typescript/TextBlockData/index.md) & { `offloaded`: `Omit`<[`OffloadedBlockData`](/docs/api/typescript/OffloadedBlockData/index.md), `"text"`\>; }

#### Overrides

[`TextBlock`](/docs/api/typescript/TextBlock/index.md).[`toJSON`](/docs/api/typescript/TextBlock/index.md#tojson)

---

### fromJSON()

```ts
static fromJSON(data): OffloadedBlock;
```

Defined in: [src/types/messages.ts:373](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L373)

**`Experimental`**

Creates an OffloadedBlock instance from its serialized form.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `data` | [`TextBlockData`](/docs/api/typescript/TextBlockData/index.md) & { `offloaded`: `Omit`<[`OffloadedBlockData`](/docs/api/typescript/OffloadedBlockData/index.md), `"text"`\>; } | Serialized placeholder to deserialize |

#### Returns

`OffloadedBlock`

OffloadedBlock instance

#### Overrides

[`TextBlock`](/docs/api/typescript/TextBlock/index.md).[`fromJSON`](/docs/api/typescript/TextBlock/index.md#fromjson)
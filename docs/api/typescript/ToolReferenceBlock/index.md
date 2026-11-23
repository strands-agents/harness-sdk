Defined in: [src/types/messages.ts:517](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L517)

A tool whose input schema a tool result loads. `load_tools` returns one for each tool it loads, and any tool can return them too, such as a custom loader that searches the tool catalog.

It reaches the model as a reference only when the model defers tools natively (`modelInfo.capabilities.deferredToolLoading` is `'native'`), the request defers this tool, and the tool result holds only such references; the provider then sends a reference the API expands into the tool’s definition. Otherwise the model gets the parameters of the request’s tool with this name as text, so a tool that changed is shown as it is now.

## Example

```typescript
new ToolReferenceBlock({ name: weatherTool.name })
```

## Implements

-   [`ToolReferenceBlockData`](/docs/api/typescript/ToolReferenceBlockData/index.md)
-   `JSONSerializable`<{ `toolReference`: [`ToolReferenceBlockData`](/docs/api/typescript/ToolReferenceBlockData/index.md); }>

## Constructors

### Constructor

```ts
new ToolReferenceBlock(data): ToolReferenceBlock;
```

Defined in: [src/types/messages.ts:530](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L530)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | [`ToolReferenceBlockData`](/docs/api/typescript/ToolReferenceBlockData/index.md) |

#### Returns

`ToolReferenceBlock`

## Properties

### type

```ts
readonly type: "toolReferenceBlock";
```

Defined in: [src/types/messages.ts:523](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L523)

Discriminator for tool reference content.

---

### name

```ts
readonly name: string;
```

Defined in: [src/types/messages.ts:528](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L528)

Name of the tool the result loads.

#### Implementation of

[`ToolReferenceBlockData`](/docs/api/typescript/ToolReferenceBlockData/index.md).[`name`](/docs/api/typescript/ToolReferenceBlockData/index.md#name)

## Methods

### toJSON()

```ts
toJSON(): {
  toolReference: ToolReferenceBlockData;
};
```

Defined in: [src/types/messages.ts:538](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L538)

Serializes the ToolReferenceBlock to a JSON-compatible ToolResultContentData object. Called automatically by JSON.stringify().

#### Returns

```ts
{
  toolReference: ToolReferenceBlockData;
}
```

| Name | Type | Defined in |
| --- | --- | --- |
| `toolReference` | [`ToolReferenceBlockData`](/docs/api/typescript/ToolReferenceBlockData/index.md) | [src/types/messages.ts:538](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L538) |

#### Implementation of

`JSONSerializable.toJSON`

---

### fromJSON()

```ts
static fromJSON(data): ToolReferenceBlock;
```

Defined in: [src/types/messages.ts:548](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L548)

Creates a ToolReferenceBlock instance from its wrapped data format.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `data` | { `toolReference`: [`ToolReferenceBlockData`](/docs/api/typescript/ToolReferenceBlockData/index.md); } | Wrapped ToolReferenceBlockData to deserialize |
| `data.toolReference` | [`ToolReferenceBlockData`](/docs/api/typescript/ToolReferenceBlockData/index.md) | \- |

#### Returns

`ToolReferenceBlock`

ToolReferenceBlock instance
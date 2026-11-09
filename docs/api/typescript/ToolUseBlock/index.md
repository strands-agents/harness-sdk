Defined in: [src/types/messages.ts:285](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L285)

Tool use content block.

## Implements

-   [`ToolUseBlockData`](/docs/api/typescript/ToolUseBlockData/index.md)
-   `JSONSerializable`<{ `toolUse`: [`ToolUseBlockData`](/docs/api/typescript/ToolUseBlockData/index.md); }>

## Constructors

### Constructor

```ts
new ToolUseBlock(data): ToolUseBlock;
```

Defined in: [src/types/messages.ts:313](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L313)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | [`ToolUseBlockData`](/docs/api/typescript/ToolUseBlockData/index.md) |

#### Returns

`ToolUseBlock`

## Properties

### type

```ts
readonly type: "toolUseBlock";
```

Defined in: [src/types/messages.ts:289](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L289)

Discriminator for tool use content.

---

### name

```ts
readonly name: string;
```

Defined in: [src/types/messages.ts:294](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L294)

The name of the tool to execute.

#### Implementation of

[`ToolUseBlockData`](/docs/api/typescript/ToolUseBlockData/index.md).[`name`](/docs/api/typescript/ToolUseBlockData/index.md#name)

---

### toolUseId

```ts
readonly toolUseId: string;
```

Defined in: [src/types/messages.ts:299](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L299)

Unique identifier for this tool use instance.

#### Implementation of

[`ToolUseBlockData`](/docs/api/typescript/ToolUseBlockData/index.md).[`toolUseId`](/docs/api/typescript/ToolUseBlockData/index.md#tooluseid)

---

### input

```ts
readonly input: JSONValue;
```

Defined in: [src/types/messages.ts:305](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L305)

The input parameters for the tool. This can be any JSON-serializable value.

#### Implementation of

[`ToolUseBlockData`](/docs/api/typescript/ToolUseBlockData/index.md).[`input`](/docs/api/typescript/ToolUseBlockData/index.md#input)

---

### reasoningSignature?

```ts
readonly reasoningSignature?: string;
```

Defined in: [src/types/messages.ts:311](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L311)

Reasoning signature from thinking models (e.g., Gemini). Must be preserved and sent back to the model for multi-turn tool use.

#### Implementation of

[`ToolUseBlockData`](/docs/api/typescript/ToolUseBlockData/index.md).[`reasoningSignature`](/docs/api/typescript/ToolUseBlockData/index.md#reasoningsignature)

## Methods

### toJSON()

```ts
toJSON(): {
  toolUse: ToolUseBlockData;
};
```

Defined in: [src/types/messages.ts:326](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L326)

Serializes the ToolUseBlock to a JSON-compatible ContentBlockData object. Called automatically by JSON.stringify().

#### Returns

```ts
{
  toolUse: ToolUseBlockData;
}
```

| Name | Type | Defined in |
| --- | --- | --- |
| `toolUse` | [`ToolUseBlockData`](/docs/api/typescript/ToolUseBlockData/index.md) | [src/types/messages.ts:326](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L326) |

#### Implementation of

`JSONSerializable.toJSON`

---

### fromJSON()

```ts
static fromJSON(data): ToolUseBlock;
```

Defined in: [src/types/messages.ts:343](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L343)

Creates a ToolUseBlock instance from its wrapped data format.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `data` | { `toolUse`: [`ToolUseBlockData`](/docs/api/typescript/ToolUseBlockData/index.md); } | Wrapped ToolUseBlockData to deserialize |
| `data.toolUse` | [`ToolUseBlockData`](/docs/api/typescript/ToolUseBlockData/index.md) | \- |

#### Returns

`ToolUseBlock`

ToolUseBlock instance
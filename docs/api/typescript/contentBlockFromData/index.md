```ts
function contentBlockFromData(data): ContentBlock;
```

Defined in: [src/types/messages.ts:1151](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1151)

Converts ContentBlockData to a ContentBlock instance. Handles all content block types including text, tool use/result, reasoning, cache points, guard content, injected, and media blocks.

## Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `data` | [`ContentBlockData`](/docs/api/typescript/ContentBlockData/index.md) | The content block data to convert |

## Returns

[`ContentBlock`](/docs/api/typescript/ContentBlock/index.md)

A ContentBlock instance of the appropriate type

## Throws

Error if the content block type is unknown
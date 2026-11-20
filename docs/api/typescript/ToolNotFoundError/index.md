Defined in: [src/errors.ts:264](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/errors.ts#L264)

Error thrown when a tool cannot be found by name.

Thrown by ToolRegistry.resolve when the requested tool name doesn’t match any registered tool, even after underscore-to-hyphen normalization and case-insensitive matching.

## Extends

-   `Error`

## Constructors

### Constructor

```ts
new ToolNotFoundError(toolName): ToolNotFoundError;
```

Defined in: [src/errors.ts:273](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/errors.ts#L273)

Creates a new ToolNotFoundError.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `toolName` | `string` | The tool name that was not found |

#### Returns

`ToolNotFoundError`

#### Overrides

`Error.constructor`

## Properties

### toolName

```ts
readonly toolName: string;
```

Defined in: [src/errors.ts:266](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/errors.ts#L266)

The tool name that was requested but not found.
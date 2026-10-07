Defined in: [src/mcp/client.ts:150](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L150)

Error thrown when a server reports a task as cancelled.

## Extends

-   `Error`

## Constructors

### Constructor

```ts
new McpTaskCancelledError(statusMessage?): McpTaskCancelledError;
```

Defined in: [src/mcp/client.ts:154](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L154)

#### Parameters

| Parameter | Type |
| --- | --- |
| `statusMessage?` | `string` |

#### Returns

`McpTaskCancelledError`

#### Overrides

```ts
Error.constructor
```

## Properties

### statusMessage

```ts
readonly statusMessage: string;
```

Defined in: [src/mcp/client.ts:152](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L152)

Optional server-provided context for the cancellation.
Defined in: [src/mcp/client.ts:162](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L162)

Error thrown when a server reports a task as failed.

## Extends

-   `Error`

## Constructors

### Constructor

```ts
new McpTaskFailedError(statusMessage?): McpTaskFailedError;
```

Defined in: [src/mcp/client.ts:166](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L166)

#### Parameters

| Parameter | Type |
| --- | --- |
| `statusMessage?` | `string` |

#### Returns

`McpTaskFailedError`

#### Overrides

```ts
Error.constructor
```

## Properties

### statusMessage

```ts
readonly statusMessage: string;
```

Defined in: [src/mcp/client.ts:164](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L164)

Optional server-provided context for the failure.
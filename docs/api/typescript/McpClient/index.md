Defined in: [src/mcp/client.ts:319](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L319)

MCP client using SDK v2, including legacy task execution.

## Example

```typescript
const client = new McpClient({ url: 'https://example.com/mcp', tasksConfig: {} })
const agent = new Agent({ tools: [client] })
```

## Constructors

### Constructor

```ts
new McpClient(args): McpClient;
```

Defined in: [src/mcp/client.ts:401](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L401)

#### Parameters

| Parameter | Type |
| --- | --- |
| `args` | [`McpClientConfig`](/docs/api/typescript/McpClientConfig/index.md) |

#### Returns

`McpClient`

## Properties

### ~DEFAULT\_TTL~

```ts
readonly static DEFAULT_TTL: 60000 = 60000;
```

Defined in: [src/mcp/client.ts:325](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L325)

Default task lifecycle request timeout in milliseconds.

#### Deprecated

Use [McpClient.DEFAULT\_REQUEST\_TIMEOUT](#default_request_timeout).

---

### DEFAULT\_POLL\_TIMEOUT

```ts
readonly static DEFAULT_POLL_TIMEOUT: 300000 = 300000;
```

Defined in: [src/mcp/client.ts:328](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L328)

Default overall task operation deadline in milliseconds.

---

### DEFAULT\_REQUEST\_TIMEOUT

```ts
readonly static DEFAULT_REQUEST_TIMEOUT: 60000 = 60000;
```

Defined in: [src/mcp/client.ts:331](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L331)

Default task lifecycle request timeout in milliseconds.

---

### DEFAULT\_POLL\_INTERVAL\_MS

```ts
readonly static DEFAULT_POLL_INTERVAL_MS: 1000 = 1000;
```

Defined in: [src/mcp/client.ts:334](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L334)

Default polling interval when a legacy task response omits `pollInterval`.

## Accessors

### client

#### Get Signature

```ts
get client(): Client;
```

Defined in: [src/mcp/client.ts:511](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L511)

##### Returns

`Client`

---

### serverCapabilities

#### Get Signature

```ts
get serverCapabilities(): any;
```

Defined in: [src/mcp/client.ts:515](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L515)

##### Returns

`any`

---

### serverVersion

#### Get Signature

```ts
get serverVersion(): any;
```

Defined in: [src/mcp/client.ts:519](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L519)

##### Returns

`any`

---

### serverInstructions

#### Get Signature

```ts
get serverInstructions(): string;
```

Defined in: [src/mcp/client.ts:523](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L523)

##### Returns

`string`

---

### connectionState

#### Get Signature

```ts
get connectionState(): McpConnectionState;
```

Defined in: [src/mcp/client.ts:527](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L527)

##### Returns

[`McpConnectionState`](/docs/api/typescript/McpConnectionState/index.md)

---

### clientName

#### Get Signature

```ts
get clientName(): string;
```

Defined in: [src/mcp/client.ts:531](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L531)

##### Returns

`string`

---

### continueOnError

#### Get Signature

```ts
get continueOnError(): boolean;
```

Defined in: [src/mcp/client.ts:535](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L535)

##### Returns

`boolean`

---

### onToolsChanged

#### Set Signature

```ts
set onToolsChanged(callback): void;
```

Defined in: [src/mcp/client.ts:751](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L751)

Sets a callback invoked when the MCP server’s tool list changes at runtime.

##### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `callback` | (`oldTools`, `newTools`) => `void` | Handler receiving the previous tool names and the refreshed tool instances, or undefined to remove the callback. |

##### Returns

`void`

## Methods

### loadServers()

```ts
static loadServers(
   config,
   defaults?,
   options?
): Promise<McpClient[]>;
```

Defined in: [src/mcp/client.ts:344](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L344)

Parses an MCP servers config (file path or object) and returns McpClient instances.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `config` | | `string` | `Record`<`string`, [`McpServerConfig`](/docs/api/typescript/McpServerConfig/index.md)\> | A file path to a JSON config, or a flat server map object. |
| `defaults?` | [`McpClientOptions`](/docs/api/typescript/McpClientOptions/index.md) | Options applied to all clients unless overridden per-server. |
| `options?` | [`McpLoadServersOptions`](/docs/api/typescript/McpLoadServersOptions/index.md) | Loader behavior, such as prefixing tools with the server name. |

#### Returns

`Promise`<`McpClient`\[\]>

An array of McpClient instances ready to be passed to an Agent.

---

### connect()

```ts
connect(reconnect?, options?): Promise<void>;
```

Defined in: [src/mcp/client.ts:569](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L569)

Connects the MCP client to the server.

Called lazily before any operation that requires a connection. When `continueOnError` is true, connection failures are swallowed and the client enters a `'failed'` state. Subsequent calls are then no-ops until `connect(true)` is called explicitly to retry.

A client configured with `url` retries on a fresh transport and connection. A client configured with a `transport` instance reuses it, so the retry only works when that transport can be started again (a `StreamableHTTPClientTransport` cannot, so construct a new `McpClient` instead).

#### Parameters

| Parameter | Type | Default value | Description |
| --- | --- | --- | --- |
| `reconnect?` | `boolean` | `false` | When true, forces a reconnect even if already connected or failed. |
| `options?` | { `signal?`: `AbortSignal`; } | `undefined` | Optional abort signal that stops this caller’s wait. The connection attempt itself continues for other callers awaiting it. |
| `options.signal?` | `AbortSignal` | `undefined` | \- |

#### Returns

`Promise`<`void`\>

A promise that resolves when the connection is established.

---

### disconnect()

```ts
disconnect(): Promise<void>;
```

Defined in: [src/mcp/client.ts:650](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L650)

Disconnects the MCP client from the server and cleans up resources.

#### Returns

`Promise`<`void`\>

A promise that resolves when the disconnection is complete.

---

### \[asyncDispose\]()

```ts
[asyncDispose](): Promise<void>;
```

Defined in: [src/mcp/client.ts:667](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L667)

Enables the `await using` pattern for automatic resource cleanup. Delegates to [McpClient.disconnect](#disconnect).

#### Returns

`Promise`<`void`\>

---

### listTools()

```ts
listTools(options?): Promise<McpTool[]>;
```

Defined in: [src/mcp/client.ts:683](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L683)

Lists the tools available on the server and returns them as executable McpTool instances.

A prefix renames tools for the agent only; tools are always invoked, and matched by string and `RegExp` filters, under their server-side name. Overlong prefixed names are skipped with a warning when `continueOnError` is true; otherwise, listing throws. Unprefixed names are not length-checked.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `options?` | [`McpListToolsOptions`](/docs/api/typescript/McpListToolsOptions/index.md) | Overrides for the prefix and filters set on the client. An omitted field uses the client’s value; an explicit empty string or empty object disables it. |

#### Returns

`Promise`<`McpTool`\[\]>

A promise that resolves with an array of McpTool instances.

#### Throws

ToolValidationError When a prefixed name exceeds the registry limit and `continueOnError` is false.

---

### listPrompts()

```ts
listPrompts(options?): Promise<ListPromptsResult>;
```

Defined in: [src/mcp/client.ts:789](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L789)

Lists the prompts available on the server.

Without a `paginationToken` the client aggregates every page into one result with no `nextCursor`, and throws `ListPaginationExceeded` when the server pages past `listMaxPages` (64 unless configured). With a token it fetches a single page whose `nextCursor` feeds the next call.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `options?` | [`McpListOptions`](/docs/api/typescript/McpListOptions/index.md) | Pagination options. |

#### Returns

`Promise`<`ListPromptsResult`\>

A promise that resolves with the raw MCP list prompts result.

#### Throws

Error when an earlier connect attempt failed with `continueOnError` set. Call `connect(true)` to retry.

---

### getPrompt()

```ts
getPrompt(promptId, args?): Promise<GetPromptResult>;
```

Defined in: [src/mcp/client.ts:802](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L802)

Retrieves a prompt from the server by name.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `promptId` | `string` | The name of the prompt to retrieve. |
| `args?` | `Record`<`string`, `string`\> | Arguments for the prompt’s template substitution. |

#### Returns

`Promise`<`GetPromptResult`\>

A promise that resolves with the raw MCP prompt result.

#### Throws

Error when an earlier connect attempt failed with `continueOnError` set. Call `connect(true)` to retry.

---

### listResources()

```ts
listResources(options?): Promise<ListResourcesResult>;
```

Defined in: [src/mcp/client.ts:819](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L819)

Lists the resources available on the server.

Without a `paginationToken` the client aggregates every page into one result with no `nextCursor`, and throws `ListPaginationExceeded` when the server pages past `listMaxPages` (64 unless configured). With a token it fetches a single page whose `nextCursor` feeds the next call.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `options?` | [`McpListOptions`](/docs/api/typescript/McpListOptions/index.md) | Pagination options. |

#### Returns

`Promise`<`ListResourcesResult`\>

A promise that resolves with the raw MCP list resources result.

#### Throws

Error when an earlier connect attempt failed with `continueOnError` set. Call `connect(true)` to retry.

---

### readResource()

```ts
readResource(uri): Promise<ReadResourceResult>;
```

Defined in: [src/mcp/client.ts:831](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L831)

Reads a resource from the server.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `uri` | `string` | `URL` | The URI of the resource to read. |

#### Returns

`Promise`<`ReadResourceResult`\>

A promise that resolves with the raw MCP resource content.

#### Throws

Error when an earlier connect attempt failed with `continueOnError` set. Call `connect(true)` to retry.

---

### listResourceTemplates()

```ts
listResourceTemplates(options?): Promise<ListResourceTemplatesResult>;
```

Defined in: [src/mcp/client.ts:848](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L848)

Lists the resource templates available on the server.

Without a `paginationToken` the client aggregates every page into one result with no `nextCursor`, and throws `ListPaginationExceeded` when the server pages past `listMaxPages` (64 unless configured). With a token it fetches a single page whose `nextCursor` feeds the next call.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `options?` | [`McpListOptions`](/docs/api/typescript/McpListOptions/index.md) | Pagination options. |

#### Returns

`Promise`<`ListResourceTemplatesResult`\>

A promise that resolves with the raw MCP list resource templates result.

#### Throws

Error when an earlier connect attempt failed with `continueOnError` set. Call `connect(true)` to retry.

---

### callTool()

```ts
callTool(
   tool,
   args,
   options?
): Promise<JSONValue>;
```

Defined in: [src/mcp/client.ts:867](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L867)

Invoke a tool on the connected MCP server using an McpTool instance.

When `tasksConfig` is set, task-backed execution is completed automatically on both server generations: SEP-2663 tasks on servers that advertise the tasks extension, and the legacy 2025-11-25 task protocol. Direct tool results are returned unchanged.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `tool` | `McpTool` | The McpTool instance to invoke. |
| `args` | [`JSONValue`](/docs/api/typescript/JSONValue/index.md) | The arguments to pass to the tool. |
| `options?` | [`McpCallToolOptions`](/docs/api/typescript/McpCallToolOptions/index.md) | Optional settings for the request. |

#### Returns

`Promise`<[`JSONValue`](/docs/api/typescript/JSONValue/index.md)\>

The final tool result.

#### Throws

[McpTaskCancelledError](/docs/api/typescript/McpTaskCancelledError/index.md) When the server reports a cancelled task.

#### Throws

[McpTaskFailedError](/docs/api/typescript/McpTaskFailedError/index.md) When the server reports a failed task.

---

### submitTool()

```ts
submitTool(
   tool,
   args,
   options?
): Promise<any>;
```

Defined in: [src/mcp/client.ts:910](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L910)

Invokes a tool once and returns either its direct result or a server-created task handle.

This operation never polls or consumes a returned task handle. Task creation is controlled by the server; the client only advertises support when `tasksConfig` is configured.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `tool` | `McpTool` | The McpTool instance to invoke. |
| `args` | [`JSONValue`](/docs/api/typescript/JSONValue/index.md) | The arguments to pass to the tool. |
| `options?` | [`McpCallToolOptions`](/docs/api/typescript/McpCallToolOptions/index.md) | Optional settings for the request. |

#### Returns

`Promise`<`any`\>

The direct tool result or task handle returned by the server.

---

### getTask()

```ts
getTask(taskId, options?): Promise<McpGetTaskResult>;
```

Defined in: [src/mcp/client.ts:960](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L960)

Retrieves the current state of a SEP-2663 task.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `taskId` | `string` | Server-issued task identifier. |
| `options?` | [`McpTaskRequestOptions`](/docs/api/typescript/McpTaskRequestOptions/index.md) | Optional lifecycle request settings. |

#### Returns

`Promise`<[`McpGetTaskResult`](/docs/api/typescript/McpGetTaskResult/index.md)\>

The validated task state, including terminal result or error data when present.

---

### updateTask()

```ts
updateTask(
   taskId,
   inputResponses,
   options?
): Promise<McpUpdateTaskResult>;
```

Defined in: [src/mcp/client.ts:982](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L982)

Supplies one or more responses to outstanding task input requests.

Partial response sets are supported; the server may keep the task in `input_required` until every outstanding request has been answered.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `taskId` | `string` | Server-issued task identifier. |
| `inputResponses` | [`McpInputResponses`](/docs/api/typescript/McpInputResponses/index.md) | Responses keyed by the corresponding input request key. |
| `options?` | [`McpTaskRequestOptions`](/docs/api/typescript/McpTaskRequestOptions/index.md) | Optional lifecycle request settings. |

#### Returns

`Promise`<[`McpUpdateTaskResult`](/docs/api/typescript/McpUpdateTaskResult/index.md)\>

The server’s validated acknowledgement.

---

### cancelTask()

```ts
cancelTask(taskId, options?): Promise<McpCancelTaskResult>;
```

Defined in: [src/mcp/client.ts:1012](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L1012)

Requests cooperative cancellation of a SEP-2663 task.

A successful acknowledgement does not guarantee that the server stopped the work or that the task will eventually report `cancelled`.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `taskId` | `string` | Server-issued task identifier. |
| `options?` | [`McpTaskRequestOptions`](/docs/api/typescript/McpTaskRequestOptions/index.md) | Optional lifecycle request settings. |

#### Returns

`Promise`<[`McpCancelTaskResult`](/docs/api/typescript/McpCancelTaskResult/index.md)\>

The server’s validated acknowledgement.
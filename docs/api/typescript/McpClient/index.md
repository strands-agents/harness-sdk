Defined in: [src/mcp/client.ts:236](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L236)

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

Defined in: [src/mcp/client.ts:304](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L304)

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

Defined in: [src/mcp/client.ts:242](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L242)

Default task lifecycle request timeout in milliseconds.

#### Deprecated

Use [McpClient.DEFAULT\_REQUEST\_TIMEOUT](#default_request_timeout).

---

### DEFAULT\_POLL\_TIMEOUT

```ts
readonly static DEFAULT_POLL_TIMEOUT: 300000 = 300000;
```

Defined in: [src/mcp/client.ts:245](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L245)

Default overall task operation deadline in milliseconds.

---

### DEFAULT\_REQUEST\_TIMEOUT

```ts
readonly static DEFAULT_REQUEST_TIMEOUT: 60000 = 60000;
```

Defined in: [src/mcp/client.ts:248](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L248)

Default task lifecycle request timeout in milliseconds.

---

### DEFAULT\_POLL\_INTERVAL\_MS

```ts
readonly static DEFAULT_POLL_INTERVAL_MS: 1000 = 1000;
```

Defined in: [src/mcp/client.ts:251](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L251)

Default polling interval when a task response omits `pollIntervalMs`.

## Accessors

### client

#### Get Signature

```ts
get client(): Client;
```

Defined in: [src/mcp/client.ts:381](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L381)

##### Returns

`Client`

---

### serverCapabilities

#### Get Signature

```ts
get serverCapabilities(): any;
```

Defined in: [src/mcp/client.ts:385](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L385)

##### Returns

`any`

---

### serverVersion

#### Get Signature

```ts
get serverVersion(): any;
```

Defined in: [src/mcp/client.ts:389](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L389)

##### Returns

`any`

---

### serverInstructions

#### Get Signature

```ts
get serverInstructions(): string;
```

Defined in: [src/mcp/client.ts:393](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L393)

##### Returns

`string`

---

### connectionState

#### Get Signature

```ts
get connectionState(): McpConnectionState;
```

Defined in: [src/mcp/client.ts:397](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L397)

##### Returns

[`McpConnectionState`](/docs/api/typescript/McpConnectionState/index.md)

---

### clientName

#### Get Signature

```ts
get clientName(): string;
```

Defined in: [src/mcp/client.ts:401](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L401)

##### Returns

`string`

---

### continueOnError

#### Get Signature

```ts
get continueOnError(): boolean;
```

Defined in: [src/mcp/client.ts:405](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L405)

##### Returns

`boolean`

---

### onToolsChanged

#### Set Signature

```ts
set onToolsChanged(callback): void;
```

Defined in: [src/mcp/client.ts:593](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L593)

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

Defined in: [src/mcp/client.ts:261](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L261)

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

Defined in: [src/mcp/client.ts:421](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L421)

Connects the MCP client to the server.

Called lazily before any operation that requires a connection. When `continueOnError` is true, connection failures are swallowed and the client enters a `'failed'` state — subsequent calls are no-ops until `connect(true)` is called explicitly to retry.

#### Parameters

| Parameter | Type | Default value | Description |
| --- | --- | --- | --- |
| `reconnect` | `boolean` | `false` | When true, forces a reconnect even if already connected or failed. |
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

Defined in: [src/mcp/client.ts:494](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L494)

Disconnects the MCP client from the server and cleans up resources.

#### Returns

`Promise`<`void`\>

A promise that resolves when the disconnection is complete.

---

### \[asyncDispose\]()

```ts
asyncDispose: Promise<void>;
```

Defined in: [src/mcp/client.ts:510](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L510)

Enables the `await using` pattern for automatic resource cleanup. Delegates to [McpClient.disconnect](#disconnect).

#### Returns

`Promise`<`void`\>

---

### listTools()

```ts
listTools(options?): Promise<McpTool[]>;
```

Defined in: [src/mcp/client.ts:526](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L526)

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

### callTool()

```ts
callTool(
   tool,
   args,
   options?
): Promise<JSONValue>;
```

Defined in: [src/mcp/client.ts:633](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L633)

Invoke a tool on the connected MCP server using an McpTool instance.

When `tasksConfig` is set and a legacy (2025-11-25) server executes the tool as a task, this method polls until the task reaches a terminal state and returns the final result. Direct tool results are returned unchanged.

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

[McpTaskFailedError](/docs/api/typescript/McpTaskFailedError/index.md) When a legacy task reports the `failed` status.
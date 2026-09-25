Defined in: [src/mcp/client.ts:148](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L148)

MCP Client for interacting with Model Context Protocol servers.

## Constructors

### Constructor

```ts
new McpClient(args): McpClient;
```

Defined in: [src/mcp/client.ts:198](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L198)

#### Parameters

| Parameter | Type |
| --- | --- |
| `args` | [`McpClientConfig`](/docs/api/typescript/McpClientConfig/index.md) |

#### Returns

`McpClient`

## Properties

### DEFAULT\_TTL

```ts
readonly static DEFAULT_TTL: 60000 = 60000;
```

Defined in: [src/mcp/client.ts:154](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L154)

Default TTL for task polling in milliseconds (60 seconds).

Unused while task support is rebuilt on the MCP tasks extension (#1659).

---

### DEFAULT\_POLL\_TIMEOUT

```ts
readonly static DEFAULT_POLL_TIMEOUT: 300000 = 300000;
```

Defined in: [src/mcp/client.ts:161](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L161)

Default poll timeout for task completion in milliseconds (5 minutes).

Unused while task support is rebuilt on the MCP tasks extension (#1659).

## Accessors

### client

#### Get Signature

```ts
get client(): Client;
```

Defined in: [src/mcp/client.ts:278](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L278)

##### Returns

`Client`

---

### serverCapabilities

#### Get Signature

```ts
get serverCapabilities(): any;
```

Defined in: [src/mcp/client.ts:282](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L282)

##### Returns

`any`

---

### serverVersion

#### Get Signature

```ts
get serverVersion(): any;
```

Defined in: [src/mcp/client.ts:286](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L286)

##### Returns

`any`

---

### serverInstructions

#### Get Signature

```ts
get serverInstructions(): string;
```

Defined in: [src/mcp/client.ts:290](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L290)

##### Returns

`string`

---

### connectionState

#### Get Signature

```ts
get connectionState(): McpConnectionState;
```

Defined in: [src/mcp/client.ts:294](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L294)

##### Returns

[`McpConnectionState`](/docs/api/typescript/McpConnectionState/index.md)

---

### clientName

#### Get Signature

```ts
get clientName(): string;
```

Defined in: [src/mcp/client.ts:298](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L298)

##### Returns

`string`

---

### continueOnError

#### Get Signature

```ts
get continueOnError(): boolean;
```

Defined in: [src/mcp/client.ts:302](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L302)

##### Returns

`boolean`

---

### onToolsChanged

#### Set Signature

```ts
set onToolsChanged(callback): void;
```

Defined in: [src/mcp/client.ts:432](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L432)

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

Defined in: [src/mcp/client.ts:171](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L171)

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
connect(reconnect?): Promise<void>;
```

Defined in: [src/mcp/client.ts:316](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L316)

Connects the MCP client to the server.

Called lazily before any operation that requires a connection. When `continueOnError` is true, connection failures are swallowed and the client enters a `'failed'` state — subsequent calls are no-ops until `connect(true)` is called explicitly to retry.

#### Parameters

| Parameter | Type | Default value | Description |
| --- | --- | --- | --- |
| `reconnect` | `boolean` | `false` | When true, forces a reconnect even if already connected or failed. |

#### Returns

`Promise`<`void`\>

A promise that resolves when the connection is established.

---

### disconnect()

```ts
disconnect(): Promise<void>;
```

Defined in: [src/mcp/client.ts:350](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L350)

Disconnects the MCP client from the server and cleans up resources.

#### Returns

`Promise`<`void`\>

A promise that resolves when the disconnection is complete.

---

### \[asyncDispose\]()

```ts
asyncDispose: Promise<void>;
```

Defined in: [src/mcp/client.ts:361](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L361)

Enables the `await using` pattern for automatic resource cleanup. Delegates to [McpClient.disconnect](#disconnect).

#### Returns

`Promise`<`void`\>

---

### listTools()

```ts
listTools(options?): Promise<McpTool[]>;
```

Defined in: [src/mcp/client.ts:375](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L375)

Lists the tools available on the server and returns them as executable McpTool instances.

A prefix renames tools for the agent only; tools are always invoked, and matched by string and `RegExp` filters, under their server-side name.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `options?` | [`McpListToolsOptions`](/docs/api/typescript/McpListToolsOptions/index.md) | Overrides for the prefix and filters set on the client. An omitted field uses the client’s value; an explicit empty string or empty object disables it. |

#### Returns

`Promise`<`McpTool`\[\]>

A promise that resolves with an array of McpTool instances.

---

### callTool()

```ts
callTool(
   tool,
   args,
   options?
): Promise<JSONValue>;
```

Defined in: [src/mcp/client.ts:469](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L469)

Invoke a tool on the connected MCP server using an McpTool instance.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `tool` | `McpTool` | The McpTool instance to invoke. |
| `args` | [`JSONValue`](/docs/api/typescript/JSONValue/index.md) | The arguments to pass to the tool. |
| `options?` | [`McpCallToolOptions`](/docs/api/typescript/McpCallToolOptions/index.md) | Optional settings for the request. |

#### Returns

`Promise`<[`JSONValue`](/docs/api/typescript/JSONValue/index.md)\>

A promise that resolves with the result of the tool invocation.

#### Throws

Error when the client was constructed with `tasksConfig`: task-augmented execution is temporarily unavailable while task support is rebuilt on the MCP tasks extension ([https://github.com/strands-agents/harness-sdk/issues/1659](https://github.com/strands-agents/harness-sdk/issues/1659)).
Defined in: [src/mcp/client.ts:182](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L182)

Behavioral options shared by all MCP client configurations.

## Extends

-   `RuntimeConfig`

## Properties

### applicationName?

```ts
optional applicationName?: string;
```

Defined in: [src/mcp/client.ts:49](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L49)

#### Inherited from

```ts
RuntimeConfig.applicationName
```

---

### applicationVersion?

```ts
optional applicationVersion?: string;
```

Defined in: [src/mcp/client.ts:50](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L50)

#### Inherited from

```ts
RuntimeConfig.applicationVersion
```

---

### disableMcpInstrumentation?

```ts
optional disableMcpInstrumentation?: boolean;
```

Defined in: [src/mcp/client.ts:184](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L184)

Disable OpenTelemetry MCP instrumentation.

---

### prefix?

```ts
optional prefix?: string;
```

Defined in: [src/mcp/client.ts:187](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L187)

Prefix for agent-facing tool names, applied as `<prefix>_<toolName>`.

---

### toolFilters?

```ts
optional toolFilters?: McpToolFilters;
```

Defined in: [src/mcp/client.ts:190](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L190)

Filters controlling which tools this client exposes.

---

### tasksConfig?

```ts
optional tasksConfig?: TasksConfig;
```

Defined in: [src/mcp/client.ts:193](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L193)

Enables automatic execution for legacy task tools. Experimental: subject to change.

---

### elicitationCallback?

```ts
optional elicitationCallback?: ElicitationCallback;
```

Defined in: [src/mcp/client.ts:200](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L200)

Callback to handle server-initiated elicitation requests. When provided, the client advertises elicitation support (form + url modes) and routes incoming elicitation requests to this callback.

---

### continueOnError?

```ts
optional continueOnError?: boolean;
```

Defined in: [src/mcp/client.ts:203](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L203)

When true, connection failures and overlong prefixed names during tool listing are skipped with warnings.

---

### logHandler?

```ts
optional logHandler?: (params) => void;
```

Defined in: [src/mcp/client.ts:206](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L206)

Called when the server emits a log message. Defaults to routing through the Strands logger.

#### Parameters

| Parameter | Type |
| --- | --- |
| `params` | `LoggingMessageNotificationParams` |

#### Returns

`void`
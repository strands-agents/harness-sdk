Defined in: [src/mcp/client.ts:97](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L97)

Behavioral options shared by all MCP client configurations.

## Extends

-   `RuntimeConfig`

## Properties

### applicationName?

```ts
optional applicationName?: string;
```

Defined in: [src/mcp/client.ts:32](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L32)

#### Inherited from

```ts
RuntimeConfig.applicationName
```

---

### applicationVersion?

```ts
optional applicationVersion?: string;
```

Defined in: [src/mcp/client.ts:33](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L33)

#### Inherited from

```ts
RuntimeConfig.applicationVersion
```

---

### disableMcpInstrumentation?

```ts
optional disableMcpInstrumentation?: boolean;
```

Defined in: [src/mcp/client.ts:99](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L99)

Disable OpenTelemetry MCP instrumentation.

---

### prefix?

```ts
optional prefix?: string;
```

Defined in: [src/mcp/client.ts:102](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L102)

Prefix for agent-facing tool names, applied as `<prefix>_<toolName>`.

---

### toolFilters?

```ts
optional toolFilters?: McpToolFilters;
```

Defined in: [src/mcp/client.ts:105](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L105)

Filters controlling which tools this client exposes.

---

### tasksConfig?

```ts
optional tasksConfig?: TasksConfig;
```

Defined in: [src/mcp/client.ts:113](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L113)

Configuration for task-augmented tool execution (experimental).

Temporarily unavailable while task support is rebuilt on the MCP tasks extension ([https://github.com/strands-agents/harness-sdk/issues/1659](https://github.com/strands-agents/harness-sdk/issues/1659)). When set, `callTool` throws.

---

### elicitationCallback?

```ts
optional elicitationCallback?: ElicitationCallback;
```

Defined in: [src/mcp/client.ts:120](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L120)

Callback to handle server-initiated elicitation requests. When provided, the client advertises elicitation support (form + url modes) and routes incoming elicitation requests to this callback.

---

### continueOnError?

```ts
optional continueOnError?: boolean;
```

Defined in: [src/mcp/client.ts:123](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L123)

When true, connection failures are logged as warnings instead of throwing.

---

### logHandler?

```ts
optional logHandler?: (params) => void;
```

Defined in: [src/mcp/client.ts:126](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L126)

Called when the server emits a log message. Defaults to routing through the Strands logger.

#### Parameters

| Parameter | Type |
| --- | --- |
| `params` | `LoggingMessageNotificationParams` |

#### Returns

`void`
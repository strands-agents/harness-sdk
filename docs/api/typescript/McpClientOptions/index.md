Defined in: [src/mcp/client.ts:254](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L254)

Behavioral options shared by all MCP client configurations.

## Extends

-   `RuntimeConfig`

## Properties

### applicationName?

```ts
applicationName?: string;
```

Defined in: [src/mcp/client.ts:64](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L64)

#### Inherited from

`RuntimeConfig.applicationName`

---

### applicationVersion?

```ts
applicationVersion?: string;
```

Defined in: [src/mcp/client.ts:65](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L65)

#### Inherited from

`RuntimeConfig.applicationVersion`

---

### disableMcpInstrumentation?

```ts
disableMcpInstrumentation?: boolean;
```

Defined in: [src/mcp/client.ts:256](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L256)

Disable OpenTelemetry MCP instrumentation.

---

### prefix?

```ts
prefix?: string;
```

Defined in: [src/mcp/client.ts:259](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L259)

Prefix for agent-facing tool names, applied as `<prefix>_<toolName>`.

---

### toolFilters?

```ts
toolFilters?: McpToolFilters;
```

Defined in: [src/mcp/client.ts:262](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L262)

Filters controlling which tools this client exposes.

---

### tasksConfig?

```ts
tasksConfig?: TasksConfig;
```

Defined in: [src/mcp/client.ts:265](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L265)

Enables automatic execution for legacy task tools. Experimental: subject to change.

---

### listMaxPages?

```ts
listMaxPages?: number;
```

Defined in: [src/mcp/client.ts:268](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L268)

Page cap for the no-token list methods, which aggregate every page. 0 disables the cap. Defaults to the MCP client’s 64.

---

### progressCallback?

```ts
progressCallback?: McpProgressCallback;
```

Defined in: [src/mcp/client.ts:276](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L276)

Callback for progress notifications during tool calls, including calls an agent makes. Not delivered for calls the server runs as a task (`tasksConfig` with a task-capable server). The `total` and `message` fields may be absent when the server does not provide them. A per-call `progressCallback` takes precedence.

---

### elicitationCallback?

```ts
elicitationCallback?: ElicitationCallback;
```

Defined in: [src/mcp/client.ts:283](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L283)

Callback to handle server-initiated elicitation requests. When provided, the client advertises elicitation support (form + url modes) and routes incoming elicitation requests to this callback.

---

### continueOnError?

```ts
continueOnError?: boolean;
```

Defined in: [src/mcp/client.ts:286](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L286)

When true, connection failures and overlong prefixed names during tool listing are skipped with warnings.

---

### logHandler?

```ts
logHandler?: (params) => void;
```

Defined in: [src/mcp/client.ts:289](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts#L289)

Called when the server emits a log message. Defaults to routing through the Strands logger.

#### Parameters

| Parameter | Type |
| --- | --- |
| `params` | `LoggingMessageNotificationParams` |

#### Returns

`void`
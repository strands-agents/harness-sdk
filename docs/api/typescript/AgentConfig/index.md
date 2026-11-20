```ts
type AgentConfig = {
  model?:   | Model<BaseModelConfig>
     | ModelRouter
     | string;
  auxModel?:   | Model<BaseModelConfig>
     | string;
  messages?:   | Message[]
     | MessageData[];
  tools?: ToolList;
  sortTools?: boolean;
  systemPrompt?:   | SystemPrompt
     | SystemPromptData;
  appState?: Record<string, JSONValue>;
  modelState?: Record<string, JSONValue>;
  printer?: boolean;
  conversationManager?: ConversationManager;
  contextManager?: ContextManagerStrategy;
  plugins?: Plugin[];
  backgroundTasks?:   | boolean
     | BackgroundTasksConfig;
  retryStrategy?:   | RetryStrategy
     | RetryStrategy[]
     | null;
  interventions?: InterventionHandler[];
  structuredOutputSchema?: z.ZodSchema;
  sessionManager?: SessionManager;
  memoryManager?:   | MemoryManager
     | MemoryManagerConfig;
  traceAttributes?: Record<string, AttributeValue>;
  baggageAttributes?: Record<string, string>;
  name?: string;
  description?: string;
  id?: string;
  toolExecutor?:   | ConcurrentToolExecutor
     | SequentialToolExecutor
     | ToolExecutorStrategy;
  checkpointing?: boolean;
  sandbox?: Sandbox | false;
  storage?: Storage;
};
```

Defined in: [src/agent/agent.ts:163](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L163)

Configuration object for creating a new Agent.

## Properties

### model?

```ts
model?:
  | Model<BaseModelConfig>
  | ModelRouter
  | string;
```

Defined in: [src/agent/agent.ts:186](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L186)

The model instance or router that the agent will use to make decisions. Accepts a Model, ModelRouter, or a string representing a Bedrock model ID. When a router is provided, `agent.model` remains its default concrete model.

#### Example

```typescript
// Using a string model ID (creates BedrockModel)
const agent = new Agent({
  model: 'global.anthropic.claude-sonnet-4-6'
})

// Using an explicit BedrockModel instance with configuration
const agent = new Agent({
  model: new BedrockModel({
    modelId: 'global.anthropic.claude-sonnet-4-6',
    temperature: 0.7,
    maxTokens: 2048
  })
})
```

---

### auxModel?

```ts
auxModel?:
  | Model<BaseModelConfig>
  | string;
```

Defined in: [src/agent/agent.ts:196](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L196)

Model for the auxiliary side calls the SDK makes outside the main agent loop: context summarization, memory extraction, the HITL risk classifier, LLM steering, the goal judge, and the `web_fetch` analyst. Defaults to `model`, so leaving it unset changes nothing; set it (typically to a smaller, cheaper model) to move every side call off the main model at once. Each side call resolves its model as `component's own model > auxModel > model`. Accepts a Model or a string representing a Bedrock model ID, like `model`; a ModelRouter is not accepted because auxiliary calls run outside the agent loop a router attaches to.

---

### messages?

```ts
messages?:
  | Message[]
  | MessageData[];
```

Defined in: [src/agent/agent.ts:198](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L198)

An initial set of messages to seed the agent’s conversation history.

---

### tools?

```ts
tools?: ToolList;
```

Defined in: [src/agent/agent.ts:204](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L204)

An initial set of tools to register with the agent. Accepts nested arrays of tools at any depth, which will be flattened automatically. [Agent](/docs/api/typescript/Agent/index.md) instances are automatically wrapped as tools via [Agent.asTool](/docs/api/typescript/Agent/index.md#astool).

---

### sortTools?

```ts
sortTools?: boolean;
```

Defined in: [src/agent/agent.ts:211](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L211)

Send tool specs to the model sorted by name, on every request (model calls, context summaries, token counts), to keep prompt-cache prefixes stable when the same tools are registered in a different order, e.g. from MCP servers. Sorting happens before middleware, which can still reorder them. Defaults to false, which keeps registration order.

---

### systemPrompt?

```ts
systemPrompt?:
  | SystemPrompt
  | SystemPromptData;
```

Defined in: [src/agent/agent.ts:215](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L215)

A system prompt which guides model behavior.

---

### appState?

```ts
appState?: Record<string, JSONValue>;
```

Defined in: [src/agent/agent.ts:217](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L217)

Optional initial state values for the agent.

---

### modelState?

```ts
modelState?: Record<string, JSONValue>;
```

Defined in: [src/agent/agent.ts:222](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L222)

Optional initial model-provider state (e.g., restoring `responseId` from a prior session). Typically only set when hydrating from a snapshot.

---

### printer?

```ts
printer?: boolean;
```

Defined in: [src/agent/agent.ts:228](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L228)

Enable automatic printing of agent output to console. When true, prints text generation, reasoning, and tool usage as they occur. Defaults to true.

---

### conversationManager?

```ts
conversationManager?: ConversationManager;
```

Defined in: [src/agent/agent.ts:233](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L233)

Conversation manager for handling message history and context overflow. Defaults to SlidingWindowConversationManager with windowSize of 40.

---

### contextManager?

```ts
contextManager?: ContextManagerStrategy;
```

Defined in: [src/agent/agent.ts:248](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L248)

Context management strategy that controls how messages are compressed and offloaded.

-   `"auto"`: Proactive truncation of tool results + summarization at 85% utilization.
-   `"agentic"`: (Experimental) Lets the model drive context management via injected tools, with a higher truncation threshold and summarization only on overflow. This mode may change in future versions.
-   `ContextManagerConfig` object: Custom strategy pipeline and stash configuration.
-   `ContextManager` instance: Used as-is. An instance binds to one agent; construct one per `Agent`.
-   `false`: Explicitly disable context management (no compression, no offloading).

When set (except `false`), any co-provided `conversationManager` is ignored. Defaults to undefined (SlidingWindowConversationManager).

---

### plugins?

```ts
plugins?: Plugin[];
```

Defined in: [src/agent/agent.ts:252](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L252)

Plugins to register with the agent.

---

### backgroundTasks?

```ts
backgroundTasks?:
  | boolean
  | BackgroundTasksConfig;
```

Defined in: [src/agent/agent.ts:254](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L254)

Background tool execution configuration.

---

### retryStrategy?

```ts
retryStrategy?:
  | RetryStrategy
  | RetryStrategy[]
  | null;
```

Defined in: [src/agent/agent.ts:265](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L265)

Retry strategy (or strategies) for failed model/tool calls.

-   Omitted: a sensible default [DefaultModelRetryStrategy](/docs/api/typescript/DefaultModelRetryStrategy/index.md) with exponential backoff is used.
-   Single strategy: the given strategy is used.
-   Array of strategies: all are registered, in the given order. Passing two instances of the same concrete class logs a warning — they will collide on `plugin.name` when the plugin registry initializes.
-   `null` or `[]`: retries are explicitly disabled; failures propagate to the caller.

---

### interventions?

```ts
interventions?: InterventionHandler[];
```

Defined in: [src/agent/agent.ts:269](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L269)

Intervention handlers evaluated in registration order at each lifecycle point.

---

### structuredOutputSchema?

```ts
structuredOutputSchema?: z.ZodSchema;
```

Defined in: [src/agent/agent.ts:273](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L273)

Zod schema for structured output validation.

---

### sessionManager?

```ts
sessionManager?: SessionManager;
```

Defined in: [src/agent/agent.ts:277](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L277)

Session manager for saving and restoring agent sessions

---

### memoryManager?

```ts
memoryManager?:
  | MemoryManager
  | MemoryManagerConfig;
```

Defined in: [src/agent/agent.ts:283](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L283)

Memory manager for cross-session memory retrieval and storage. Manages one or more memory stores and exposes search/add tools. Accepts a [MemoryManager](/docs/api/typescript/MemoryManager/index.md) instance or a [MemoryManagerConfig](/docs/api/typescript/MemoryManagerConfig/index.md) object (auto-wrapped).

---

### traceAttributes?

```ts
traceAttributes?: Record<string, AttributeValue>;
```

Defined in: [src/agent/agent.ts:289](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L289)

Custom trace attributes to include in all spans. These attributes are merged with standard attributes in telemetry spans. Telemetry must be enabled globally via telemetry.setupTracer() for these to take effect.

---

### baggageAttributes?

```ts
baggageAttributes?: Record<string, string>;
```

Defined in: [src/agent/agent.ts:294](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L294)

OpenTelemetry baggage entries attached to the context for the whole invocation. Baggage propagates to downstream services via the W3C `baggage` header.

---

### name?

```ts
name?: string;
```

Defined in: [src/agent/agent.ts:298](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L298)

Optional name for the agent. Defaults to “Strands Agent”.

---

### description?

```ts
description?: string;
```

Defined in: [src/agent/agent.ts:302](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L302)

Optional description of what the agent does.

---

### id?

```ts
id?: string;
```

Defined in: [src/agent/agent.ts:306](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L306)

Optional unique identifier for the agent. Defaults to “agent”.

---

### toolExecutor?

```ts
toolExecutor?:
  | ConcurrentToolExecutor
  | SequentialToolExecutor
  | ToolExecutorStrategy;
```

Defined in: [src/agent/agent.ts:314](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L314)

Executor for tool calls from a single assistant turn.

Accepts a [ConcurrentToolExecutor](/docs/api/typescript/ConcurrentToolExecutor/index.md), a [SequentialToolExecutor](/docs/api/typescript/SequentialToolExecutor/index.md), or the corresponding [ToolExecutorStrategy](/docs/api/typescript/ToolExecutorStrategy/index.md) string shorthand. Defaults to concurrent execution.

---

### checkpointing?

```ts
checkpointing?: boolean;
```

Defined in: [src/agent/agent.ts:327](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L327)

**`Experimental`**

When `true`, the agent loop pauses at cycle boundaries (`afterModel`, `afterTools`) and returns `stopReason: 'checkpoint'` with a populated `checkpoint` field. Resume by passing the checkpoint back as `{ checkpointResume: { checkpoint: ... } }`.

The SDK does not capture conversation state in the checkpoint; pair with a `SessionManager` for cross-process state continuity. Defaults to `false`. See the experimental checkpoint module.

---

### sandbox?

```ts
sandbox?: Sandbox | false;
```

Defined in: [src/agent/agent.ts:341](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L341)

Execution environment for running commands, code, and file operations. When provided, sandbox-aware tools route operations through it.

Two distinct intents, even though they resolve to the same host execution in Node today:

-   Omitted: use the environment’s default sandbox (host execution in Node). This default is the slot reserved for richer behavior later.
-   `false`: explicitly opt out of a managed sandbox and run on the host.

Keep `false` distinct from omitting so the opt-out stays stable even if the default changes.

---

### storage?

```ts
storage?: Storage;
```

Defined in: [src/agent/agent.ts:351](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts#L351)

Default storage backend for agent subsystems.

When provided, subsystems that do not have their own explicit storage (e.g., SessionManager, ContextManager) resolve from this value. Each subsystem auto-namespaces under its own prefix to avoid key collisions. Storage specified directly on a subsystem always takes precedence over this agent-level default.
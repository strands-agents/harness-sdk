Defined in: [src/models/model.ts:250](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L250)

Options interface for configuring streaming model invocation.

## Properties

### cancelSignal?

```ts
cancelSignal?: AbortSignal;
```

Defined in: [src/models/model.ts:255](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L255)

Optional cancellation signal that a provider implementation can forward to abort an in-flight request. Support is provider-dependent.

---

### systemPrompt?

```ts
systemPrompt?: SystemPrompt;
```

Defined in: [src/models/model.ts:261](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L261)

System prompt to guide the model’s behavior. Can be a simple string or an array of content blocks for advanced caching.

---

### toolSpecs?

```ts
toolSpecs?: ToolSpec[];
```

Defined in: [src/models/model.ts:266](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L266)

Array of tool specifications that the model can use.

---

### toolChoice?

```ts
toolChoice?: ToolChoice;
```

Defined in: [src/models/model.ts:271](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L271)

Controls how the model selects tools to use.

---

### modelState?

```ts
modelState?: StateStore;
```

Defined in: [src/models/model.ts:279](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L279)

Runtime state for model providers that manage server-side conversation state. The model can read and write this state during streaming (e.g., to store a response ID for conversation chaining). Mutations via `set`/`delete` are visible to the caller after the stream completes.

---

### dynamicTrailingBlocks?

```ts
dynamicTrailingBlocks?: number;
```

Defined in: [src/models/model.ts:282](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L282)

How many trailing blocks of the last user message are rebuilt on every call.

---

### agentMetadata?

```ts
agentMetadata?: AgentMetadata;
```

Defined in: [src/models/model.ts:285](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L285)

Metadata of the invoking agent, supplied per request.

---

### structuredOutputSchema?

```ts
structuredOutputSchema?: ZodSchema;
```

Defined in: [src/models/model.ts:292](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L292)

Schema this call must produce, set by the agent on its structured output retry so the provider can choose how to enforce it. The response must then be either a call to the tool named in `toolChoice` or a final text response whose text is exactly one JSON object that validates against this schema.
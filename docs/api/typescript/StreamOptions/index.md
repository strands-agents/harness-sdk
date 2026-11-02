Defined in: [src/models/model.ts:249](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L249)

Options interface for configuring streaming model invocation.

## Properties

### cancelSignal?

```ts
cancelSignal?: AbortSignal;
```

Defined in: [src/models/model.ts:254](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L254)

Optional cancellation signal that a provider implementation can forward to abort an in-flight request. Support is provider-dependent.

---

### systemPrompt?

```ts
systemPrompt?: SystemPrompt;
```

Defined in: [src/models/model.ts:260](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L260)

System prompt to guide the model’s behavior. Can be a simple string or an array of content blocks for advanced caching.

---

### toolSpecs?

```ts
toolSpecs?: ToolSpec[];
```

Defined in: [src/models/model.ts:265](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L265)

Array of tool specifications that the model can use.

---

### toolChoice?

```ts
toolChoice?: ToolChoice;
```

Defined in: [src/models/model.ts:270](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L270)

Controls how the model selects tools to use.

---

### modelState?

```ts
modelState?: StateStore;
```

Defined in: [src/models/model.ts:278](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L278)

Runtime state for model providers that manage server-side conversation state. The model can read and write this state during streaming (e.g., to store a response ID for conversation chaining). Mutations via `set`/`delete` are visible to the caller after the stream completes.

---

### dynamicTrailingBlocks?

```ts
dynamicTrailingBlocks?: number;
```

Defined in: [src/models/model.ts:281](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L281)

How many trailing blocks of the last user message are rebuilt on every call.

---

### agentMetadata?

```ts
agentMetadata?: AgentMetadata;
```

Defined in: [src/models/model.ts:284](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L284)

Metadata of the invoking agent, supplied per request.

---

### structuredOutputSchema?

```ts
structuredOutputSchema?: ZodSchema;
```

Defined in: [src/models/model.ts:291](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L291)

Schema this call must produce, set by the agent on its structured output retry so the provider can choose how to enforce it. The response must then be either a call to the tool named in `toolChoice` or a final text response whose text is exactly one JSON object that validates against this schema.
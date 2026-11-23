Defined in: [src/models/model.ts:323](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L323)

Options for [Model.summarize](/docs/api/typescript/Model/index.md#summarize).

## Properties

### systemPrompt?

```ts
systemPrompt?: SystemPrompt;
```

Defined in: [src/models/model.ts:327](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L327)

The request’s system prompt.

---

### toolSpecs?

```ts
toolSpecs?: ToolSpec[];
```

Defined in: [src/models/model.ts:332](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L332)

The request’s tool specifications.

---

### instructions?

```ts
instructions?: string;
```

Defined in: [src/models/model.ts:338](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L338)

Summarization instructions replacing the default ones, which `undefined` or `''` keeps. The base implementation’s instruction not to act on the request or call tools is always sent.

---

### cancelSignal?

```ts
cancelSignal?: AbortSignal;
```

Defined in: [src/models/model.ts:343](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L343)

Signal that aborts the call.

---

### agentMetadata?

```ts
agentMetadata?: AgentMetadata;
```

Defined in: [src/models/model.ts:349](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L349)

Metadata of the invoking agent, as passed to `stream()`. A provider may consult it to derive a prompt-cache routing key, so a replay can share the agent’s cache.
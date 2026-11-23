Defined in: [src/middleware/stages.ts:77](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/middleware/stages.ts#L77)

Context passed to model-stage middleware. All inputs to the model call are explicit — middleware can inspect and transform any of them by passing a modified context to next(). Collection fields are defensive copies; invocationState and model are shared references.

## Properties

### agent

```ts
readonly agent: LocalAgent;
```

Defined in: [src/middleware/stages.ts:79](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/middleware/stages.ts#L79)

The agent instance (escape hatch for advanced use cases).

---

### model

```ts
readonly model: Model;
```

Defined in: [src/middleware/stages.ts:81](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/middleware/stages.ts#L81)

The model this call invokes. Initialized from agent.model and replaceable per call.

---

### messages

```ts
readonly messages: readonly Message[];
```

Defined in: [src/middleware/stages.ts:83](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/middleware/stages.ts#L83)

The messages to send to the model.

---

### systemPrompt?

```ts
readonly systemPrompt?: SystemPrompt;
```

Defined in: [src/middleware/stages.ts:85](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/middleware/stages.ts#L85)

System prompt to guide the model’s behavior.

---

### toolSpecs

```ts
readonly toolSpecs: readonly ToolSpec[];
```

Defined in: [src/middleware/stages.ts:87](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/middleware/stages.ts#L87)

Tool specifications available to the model.

---

### toolChoice?

```ts
readonly toolChoice?: ToolChoice;
```

Defined in: [src/middleware/stages.ts:89](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/middleware/stages.ts#L89)

Controls how the model selects tools.

---

### invocationState

```ts
readonly invocationState: InvocationState;
```

Defined in: [src/middleware/stages.ts:91](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/middleware/stages.ts#L91)

Per-invocation state. Shared by reference — mutations are visible to hooks, tools, and AgentResult.

---

### projectedInputTokens?

```ts
readonly projectedInputTokens?: number;
```

Defined in: [src/middleware/stages.ts:93](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/middleware/stages.ts#L93)

Estimated input token count for this model call, or undefined if estimation failed.

---

### dynamicTrailingBlocks?

```ts
readonly dynamicTrailingBlocks?: number;
```

Defined in: [src/middleware/stages.ts:102](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/middleware/stages.ts#L102)

How many trailing blocks of the last user message are rebuilt on every call.

Producers add to this; a provider placing cache points keeps its own ahead of the count, since a prefix that changes every call is never read back. Counted from the end of the message so it survives a provider’s content cleaning, which only drops earlier blocks.

---

### structuredOutputSchema?

```ts
readonly structuredOutputSchema?: ZodSchema;
```

Defined in: [src/middleware/stages.ts:105](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/middleware/stages.ts#L105)

Schema this call must produce, set on the structured output retry and passed to the provider.

---

### invocationContext?

```ts
readonly invocationContext?: InvocationContext;
```

Defined in: [src/middleware/stages.ts:116](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/middleware/stages.ts#L116)

The request this model call belongs to, if any. See [InvokeOptions.invocationContext](/docs/api/typescript/InvokeOptions/index.md#invocationcontext).
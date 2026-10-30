Defined in: [src/types/agent.ts:188](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L188)

Limits for the request a top-level `invoke()` / `stream()` call starts. Each is optional; omit a field for no limit on that dimension. Token limits count every model call in the request, unlike a provider’s per-call `maxTokens`, and are checked before each turn, so the last turn can go over a limit, more so when nested calls run in parallel. A model response counts as one failed structured output attempt when it calls the structured output tool with invalid input, or doesn’t return valid structured output while the tool is forced, including when a content filter or guardrail stops it. See [InvokeOptions.limits](/docs/api/typescript/InvokeOptions/index.md#limits) for what they cover.

## Properties

### turns?

```ts
turns?: number;
```

Defined in: [src/types/agent.ts:190](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L190)

Maximum turns (one model call plus the tool calls it requests) across the request.

---

### outputTokens?

```ts
outputTokens?: number;
```

Defined in: [src/types/agent.ts:193](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L193)

Maximum model-generated tokens across every model call in the request.

---

### totalTokens?

```ts
totalTokens?: number;
```

Defined in: [src/types/agent.ts:196](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L196)

Maximum input + output tokens across every model call in the request; input grows each turn, so this compounds.

---

### structuredOutputAttempts?

```ts
structuredOutputAttempts?: number;
```

Defined in: [src/types/agent.ts:199](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L199)

Maximum failed structured output attempts across the request; when omitted, retries are unbounded and a failed forced response throws `StructuredOutputError`.
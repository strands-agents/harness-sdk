Defined in: [src/types/agent.ts:490](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L490)

Result returned by the agent loop.

## Constructors

### Constructor

```ts
new AgentResult(data): AgentResult;
```

Defined in: [src/types/agent.ts:555](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L555)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | { `stopReason`: [`StopReason`](/docs/api/typescript/StopReason/index.md); `lastMessage`: [`Message`](/docs/api/typescript/Message/index.md); `invocationState`: [`InvocationState`](/docs/api/typescript/InvocationState/index.md); `traces?`: [`AgentTrace`](/docs/api/typescript/AgentTrace/index.md)\[\]; `metrics?`: [`AgentMetrics`](/docs/api/typescript/AgentMetrics/index.md); `invocationContext?`: [`InvocationContext`](/docs/api/typescript/InvocationContext/index.md); `structuredOutput?`: `output`<`ZodType`\>; `interrupts?`: [`Interrupt`](/docs/api/typescript/Interrupt/index.md)\[\]; `checkpoint?`: `Checkpoint`; } |
| `data.stopReason` | [`StopReason`](/docs/api/typescript/StopReason/index.md) |
| `data.lastMessage` | [`Message`](/docs/api/typescript/Message/index.md) |
| `data.invocationState` | [`InvocationState`](/docs/api/typescript/InvocationState/index.md) |
| `data.traces?` | [`AgentTrace`](/docs/api/typescript/AgentTrace/index.md)\[\] |
| `data.metrics?` | [`AgentMetrics`](/docs/api/typescript/AgentMetrics/index.md) |
| `data.invocationContext?` | [`InvocationContext`](/docs/api/typescript/InvocationContext/index.md) |
| `data.structuredOutput?` | `output`<`ZodType`\> |
| `data.interrupts?` | [`Interrupt`](/docs/api/typescript/Interrupt/index.md)\[\] |
| `data.checkpoint?` | `Checkpoint` |

#### Returns

`AgentResult`

## Properties

### type

```ts
readonly type: "agentResult";
```

Defined in: [src/types/agent.ts:491](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L491)

---

### stopReason

```ts
readonly stopReason: StopReason;
```

Defined in: [src/types/agent.ts:496](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L496)

The stop reason from the final model response.

---

### lastMessage

```ts
readonly lastMessage: Message;
```

Defined in: [src/types/agent.ts:501](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L501)

The last message added to the messages array.

---

### traces?

```ts
readonly traces?: AgentTrace[];
```

Defined in: [src/types/agent.ts:507](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L507)

Local execution traces collected during the agent invocation. Contains timing and hierarchy of operations within the agent loop.

---

### structuredOutput?

```ts
readonly structuredOutput?: output<ZodType>;
```

Defined in: [src/types/agent.ts:513](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L513)

The validated structured output from the LLM, if a schema was provided. Type represents any validated Zod schema output.

---

### metrics?

```ts
readonly metrics?: AgentMetrics;
```

Defined in: [src/types/agent.ts:519](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L519)

Aggregated metrics for the agent’s loop execution. Tracks cycle counts, token usage, tool execution stats, and model latency.

---

### invocationContext?

```ts
readonly invocationContext?: InvocationContext;
```

Defined in: [src/types/agent.ts:530](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L530)

The invocation context this call ran in. Its `usage` covers the whole request (this agent, its nested calls, and auxiliary calls), unlike [metrics](#metrics), which covers this agent only; for a nested call that set its own limits, it is that call’s context and covers its share. Pass it as [InvokeOptions.invocationContext](/docs/api/typescript/InvokeOptions/index.md#invocationcontext) to continue on the same limits and usage. It is live, so work that finishes after this call returns (for example a background task) still adds to it.

---

### invocationState

```ts
readonly invocationState: InvocationState;
```

Defined in: [src/types/agent.ts:538](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L538)

Per-invocation state passed into the agent, threaded through hooks and tools, and surfaced here at the end of the invocation. See [InvocationState](/docs/api/typescript/InvocationState/index.md) for details. Always defined — defaults to `{}` when no `invocationState` was provided in [InvokeOptions](/docs/api/typescript/InvokeOptions/index.md).

---

### interrupts?

```ts
readonly interrupts?: Interrupt[];
```

Defined in: [src/types/agent.ts:544](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L544)

Interrupts that caused the agent to stop, when `stopReason` is `'interrupt'`. Contains the unanswered interrupts that require human input to resume.

---

### checkpoint?

```ts
readonly checkpoint?: Checkpoint;
```

Defined in: [src/types/agent.ts:553](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L553)

**`Experimental`**

Checkpoint captured when the agent paused for durable execution. Populated only when `stopReason` is `'checkpoint'`. See the experimental checkpoint module for usage.

## Accessors

### contextSize

#### Get Signature

```ts
get contextSize(): number;
```

Defined in: [src/types/agent.ts:594](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L594)

The total prompt the model processed on the last invocation, including cached tokens. Convenience accessor that delegates to `metrics.latestContextSize`. Returns `undefined` when no metrics or invocations are available.

##### Returns

`number`

---

### projectedContextSize

#### Get Signature

```ts
get projectedContextSize(): number;
```

Defined in: [src/types/agent.ts:604](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L604)

Projected context size for the next model call (total prompt including cached tokens plus the generated output from the last call). Convenience accessor that delegates to `metrics.projectedContextSize`. Returns `undefined` when no metrics or invocations are available.

##### Returns

`number`

## Methods

### toJSON()

```ts
toJSON(): object;
```

Defined in: [src/types/agent.ts:619](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L619)

Custom JSON serialization that excludes traces, metrics, invocationContext, and invocationState. Traces and metrics are excluded to avoid sending large payloads over the wire in API responses; `invocationContext` is excluded because it is live and can still change; `invocationState` is excluded because its values are caller-owned and may not be serializable (see [InvocationState](/docs/api/typescript/InvocationState/index.md)).

All four remain accessible via their properties for debugging.

#### Returns

`object`

Object representation for safe serialization

---

### toString()

```ts
toString(): string;
```

Defined in: [src/types/agent.ts:639](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L639)

Extracts a string representation of the result.

Priority order:

1.  `interrupts` serialized as JSON, if any are present
2.  `structuredOutput` serialized as JSON
3.  Text from `textBlock`, `reasoningBlock`, and `citationsBlock` content blocks

#### Returns

`string`

String representation of the result: JSON for interrupts/structuredOutput, or text content joined by newlines.
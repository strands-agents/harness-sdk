Defined in: [src/types/agent.ts:95](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L95)

Options for a single agent invocation.

## Properties

### structuredOutputSchema?

```ts
structuredOutputSchema?: ZodSchema;
```

Defined in: [src/types/agent.ts:99](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L99)

Zod schema for structured output validation, overriding the constructor-provided schema for this invocation only.

---

### invocationState?

```ts
invocationState?: InvocationState;
```

Defined in: [src/types/agent.ts:108](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L108)

Per-invocation state. Passed to lifecycle hook events and tools, and returned on [AgentResult.invocationState](/docs/api/typescript/AgentResult/index.md#invocationstate). Mutable — hooks and tools may read and write. See [InvocationState](/docs/api/typescript/InvocationState/index.md) for details.

Defaults to an empty object when omitted.

---

### cancelSignal?

```ts
cancelSignal?: AbortSignal;
```

Defined in: [src/types/agent.ts:138](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L138)

External AbortSignal for cancelling the agent invocation.

Use this when cancellation is driven by something outside the agent — for example, a client disconnect, a framework-managed request lifecycle, or a declarative timeout. The agent composes this signal with its own internal controller, so both `agent.cancel()` and this signal can trigger cancellation independently.

When the signal fires, the agent stops at the next cancellation checkpoint and returns an AgentResult with `stopReason: 'cancelled'`. See LocalAgent.cancelSignal for how tools can participate in cancellation.

#### Example

```typescript
// Timeout-based cancellation
const result = await agent.invoke('Hello', {
  cancelSignal: AbortSignal.timeout(5000),
})

// Framework-driven cancellation (e.g., client disconnect)
app.post('/chat', async (req, res) => {
  const result = await agent.invoke(req.body.message, {
    cancelSignal: req.signal,
  })
  res.json(result)
})
```

---

### invocationContext?

```ts
invocationContext?: InvocationContext;
```

Defined in: [src/types/agent.ts:141](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L141)

Runs this call as a nested call in the request a hook event’s or [ToolContext.invocationContext](/docs/api/typescript/ToolContext/index.md#invocationcontext) handle belongs to, sharing its limits and usage even after that request returned; `limits` set alongside it only add stricter limits.

---

### limits?

```ts
limits?: InvokeLimits;
```

Defined in: [src/types/agent.ts:174](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L174)

Limits for the whole request this `invoke()` / `stream()` call starts. They apply to this agent’s loop and to every nested call: agents passed as tools, and any Graph or Swarm you pass the request’s `invocationContext` to. A Graph or Swarm can also start a limited request itself through MultiAgentInvokeOptions.limits. An agent run by a hand-written tool joins only when the tool forwards [ToolContext.invocationContext](/docs/api/typescript/ToolContext/index.md#invocationcontext) as [InvokeOptions.invocationContext](#invocationcontext); otherwise it runs standalone under its own limits. A nested call can also set its own `limits`: it stops at whichever limit is reached first, its own or the request’s.

Auxiliary calls (summarization, routing, memory extraction, steering, HITL, goal judging, web-fetch, and decision models asked with the request’s `invocationContext`) add their tokens to the request’s usage, but no limits apply to them. The same holds for an agent that an extension point (a conversation manager, context or routing strategy, or memory extractor) runs with the `invocationContext` it receives, unless the extension point also passes `limits`. Usage starts from zero on each top-level call; pass [AgentResult.invocationContext](/docs/api/typescript/AgentResult/index.md#invocationcontext) to a later call to continue on the same limits and usage.

Limits are checked before each turn, so tools requested by the previous turn finish first and `agent.messages` stays reinvokable. Each limit, when set, must be a positive finite number; omit a field (or `limits` itself) for no limit on that dimension.

Priority when several are reached at once (highest first): `turns`, `totalTokens`, `outputTokens`, `structuredOutputAttempts`, with `stopReason` `'limitTurns'`, `'limitTotalTokens'`, `'limitOutputTokens'`, or `'limitStructuredOutputAttempts'`.
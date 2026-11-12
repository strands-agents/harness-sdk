Defined in: [src/types/agent.ts:261](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L261)

Options for LocalAgent.cancel.

## Properties

### message?

```ts
message?: string;
```

Defined in: [src/types/agent.ts:268](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L268)

Final assistant message for the cancelled invocation. When set, the agent appends it to history and returns it as `AgentResult.lastMessage`. Last write wins when several callers set one; `cancel()` without a message leaves a previously stored one intact.

---

### afterCurrentTools?

```ts
afterCurrentTools?: boolean;
```

Defined in: [src/types/agent.ts:277](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L277)

Defer cancellation until the running tool batch finishes, letting sibling tools complete normally instead of receiving cancellation errors. A deferred cancel that never gets to apply — the model answers with plain text and no tools in the same turn — is a no-op, and the invocation returns its natural `stopReason`.
Defined in: [src/types/agent.ts:260](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L260)

Options for LocalAgent.cancel.

## Properties

### message?

```ts
message?: string;
```

Defined in: [src/types/agent.ts:267](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L267)

Final assistant message for the cancelled invocation. When set, the agent appends it to history and returns it as `AgentResult.lastMessage`. Last write wins when several callers set one; `cancel()` without a message leaves a previously stored one intact.

---

### afterCurrentTools?

```ts
afterCurrentTools?: boolean;
```

Defined in: [src/types/agent.ts:276](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts#L276)

Defer cancellation until the running tool batch finishes, letting sibling tools complete normally instead of receiving cancellation errors. A deferred cancel that never gets to apply — the model answers with plain text and no tools in the same turn — is a no-op, and the invocation returns its natural `stopReason`.
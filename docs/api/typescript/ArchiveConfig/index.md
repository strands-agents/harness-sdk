Defined in: [src/context-manager/types.ts:101](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L101)

Configuration for the L1 archive (offloaded content persistence).

Each agent archives under `context/<sessionId>/scopes/agent/<agentId>/`. The prefix is dropped only when a namespaced view from a built-in backend’s `namespace()` is passed as this config’s `storage`; that view becomes the exact archive root, so agents given the same view share one archive. Deleting a session leaves a caller-scoped archive in place, and on in-memory storage each session snapshot captures and restores the whole view.

## Example

```typescript
const storage = new S3Storage('my-bucket')

// Namespaced view passed to the archive: archives at "team/" (prefix dropped, shared).
new ContextManager({ archive: { storage: storage.namespace('team') } })

// Plain storage passed to the archive:
// archives at "context/<sessionId>/scopes/agent/<agentId>/".
new ContextManager({ archive: { storage } })

// Namespaced view passed as agent-level storage: prefix still applies, under the view:
// archives at "team/context/<sessionId>/scopes/agent/<agentId>/".
new Agent({ storage: storage.namespace('team'), contextManager: new ContextManager() })
```

## Properties

### storage?

```ts
storage?: Storage;
```

Defined in: [src/context-manager/types.ts:103](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L103)

Storage backend. Defaults to the agent’s `storage`, then InMemoryStorage, when omitted.

---

### retrievalTool?

```ts
retrievalTool?: false;
```

Defined in: [src/context-manager/types.ts:110](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L110)

Whether to register the `retrieve_context` tool for the agent. Set to `false` to keep archive persistence without exposing the retrieval tool. Defaults to `true`.
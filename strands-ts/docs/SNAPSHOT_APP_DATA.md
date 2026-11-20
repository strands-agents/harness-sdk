# Application metadata in session snapshots

Use `SessionManagerConfig.snapshotAppData` to include experiment settings,
round identifiers, or other application-owned data in every snapshot capture:

```typescript
import { Agent, SessionManager } from '@strands-agents/sdk'
import { InMemoryStorage } from '@strands-agents/sdk/storage'

const experiment = { round: 0, seed: 42 }
const session = new SessionManager({
  storage: new InMemoryStorage(),
  sessionId: 'experiment',
  snapshotAppData: ({ scope, target, sessionId }) => ({
    ...experiment,
    targetId: target.id,
    scope,
    sessionId,
  }),
})
const agent = new Agent({ sessionManager: session })
experiment.round = 1
await agent.invoke('Run the next step')
```

The synchronous provider returns the complete `Record<string, JSONValue>`
stored in `snapshot.appData`. It receives `SnapshotAppDataContext`: `scope`
discriminates between an agent (`target: LocalAgent`) and a multi-agent
orchestrator (`target: Graph | Swarm`). Both contexts include `sessionId`.
The provider and context types are exported from the main SDK entry point.

The provider runs once per **capture**, including manual saves, automatic
message/invocation saves, guardrail redaction flushes, immutable snapshot
triggers, and multi-agent node/invocation saves. A trigger's immutable snapshot
and latest snapshot share one capture. With the default invocation auto-save
and a true trigger, there are two captures and three writes. Do not count
rounds inside the provider: update application variables beforehand, then use
a pure reader. Do not mutate the target, invoke it, or recursively save a
snapshot from the provider. For static metadata, return a constant object.

Metadata is validated and deep-copied synchronously before awaiting stash or
storage operations. Later changes to the returned object do not affect the
captured copy. Each capture replaces the entire record; it does not merge with
previous metadata. Omitting the provider preserves the target's existing
snapshot behavior (an empty object for standard SDK snapshots).

The top-level value must be an object, including after JSON serialization.
Arrays, null, primitives, promises, circular references, functions, symbols,
and undefined values are rejected. Nested data follows the SDK's existing
JSON serialization rules (for example, non-finite numbers serialize as null).
Async providers are rejected by TypeScript and at runtime.

For normal saves, a provider or metadata validation error propagates before
any snapshot is written. For an already-enabled **guardrail redaction flush**,
the SDK still saves the captured redacted state and stash with `appData: {}`,
then rethrows the metadata error. It does not call the provider again. If
persistence fails too, the persistence error propagates. The existing
`saveLatestOn: 'trigger'` policy remains in control of redaction saves.

`restoreSnapshot` restores SDK-owned state and returns its existing boolean;
it does not restore external application variables or call the metadata
provider. Applications that need the saved metadata can read it through their
configured snapshot storage and decide how to apply it. This option does not
add a metadata restore API, a snapshot schema version, or transactional
guarantees across SDK state, metadata, stash, and storage writes.

Strands harness has two independent ways to remember, and they answer different questions. A **session** (checkpoint) persists one conversation so you can resume that exact task after a restart. **Long-term memory** distills durable facts and recalls them across every conversation, whether or not a session is involved. They are orthogonal: you can run with neither, either, or both.

Out of the box Strands harness keeps **sessions on** and **memory on**, so a fresh agent already carries knowledge between unrelated runs, but does not resume a specific conversation until you give it a session id.

## Which do you need?

| You want to… | Use | How |
| --- | --- | --- |
| Resume a specific task where it left off after a restart | A **session** | Pass `session={"id": ...}` |
| Carry facts, preferences, or decisions across unrelated runs | **Long-term memory** | On by default |
| Both — a resumable task *and* accumulated knowledge | **Both** | Set `session={"id": ...}`, leave memory on |
| A one-shot task that should leave no trace | Neither | Set `session=False`, `memory=False` |

The rest of this page is the detail behind that table, and the honest operational answers (concurrency, isolation, deletion) for running either in production.

## Checkpoints: resume one conversation

A session persists a single conversation and replays it only when you resume that id. Give the agent `session={"id": ...}` and Strands harness writes its state to disk, then rehydrates it next time you build an agent with the same id:

(( tab "Python" ))
```python
from strands_harness import create_harness

agent = create_harness(session={"id": "refactor-parser"})
agent("Let's refactor the parser. Where should we start?")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { createHarness } from '@strands-agents/harness'

const agent = await createHarness({ session: { id: 'refactor-parser' } })
await agent.invoke("Let's refactor the parser. Where should we start?")
```
(( /tab "TypeScript" ))

State is written under `./.agent/sessions` (override with `session={"dir": ...}` / `session: { dir }`), and offloaded tool results from context management are kept there too, so a long task survives restarts intact. Under the hood the Python SDK uses a `SnapshotSessionManager` backed by `LocalFileStorage`; the TypeScript SDK uses a `SessionManager` over file storage. Both restore the latest checkpoint during construction. To use a different backend (for example S3), pass your own session manager through to the agent — your explicit manager wins over the one Strands harness builds from `session`.

For the full option set see [persist sessions](/docs/user-guide/harness/configure/sessions/index.md). The Strands Harness SDK-level [session management](/docs/user-guide/sdk/agents/session-management/index.md) and [snapshots](/docs/user-guide/sdk/agents/snapshots/index.md) pages cover immutable, time-travel checkpoints and manual save/restore.

## Long-term memory: carry facts across conversations

Memory is on by default. Strands harness distills durable facts into files under `./.agent/memory`, searches them before each user turn, and folds the top matches into context — so knowledge survives across sessions and works with sessions off. The agent also gets a `search_memory` tool for on-demand recall, and extraction runs in the background every few turns on a small model, so keeping memory costs little.

Because memory persistence is plain files, independent of any session, it is the right tool for preferences, project facts, and decisions that should outlive a single task. Turn it off for a stateless run with `memory=False` (`memory: false`), point it at a different directory with `memory={"dir": ...}` / `memory: { dir }`, or swap the backing store with `memory={"stores": [...]}`. See [give long-term memory](/docs/user-guide/harness/configure/memory/index.md) and the Strands Harness SDK’s [memory overview](/docs/user-guide/sdk/memory/overview/index.md).

They are not the same thing

A session persists *one conversation*, replayed only when you resume its id. Memory distills *durable facts* recalled across every conversation. Use a session to continue a specific task; rely on memory to carry knowledge between unrelated runs.

## Backends: what ships, and what doesn’t

Both sessions and memory sit on the Strands Harness SDK’s `Storage` abstraction. Three backends ship first-party:

-   `LocalFileStorage` — the default; atomic writes (temp file + rename).
-   `S3Storage` — for production and multi-instance deployments.
-   `InMemoryStorage` — process memory, for tests and short-lived agents.

A custom backend implements four async methods (`write`, `read`, `delete`, `list`), so you can put sessions or memory on any store you operate.

Some backends people expect are **not** first-party yet, and the docs are honest about it:

-   **SQLite and PostgreSQL** — no first-party session manager or storage backend. A Postgres-backed store is straightforward to write against the `Storage` or `MemoryStore` interface, but you own it.
-   **Redis / Valkey** — available only through the community [`strands-valkey-session-manager`](/docs/integrations/session-managers/strands-valkey-session-manager/index.md) (Python), not a first-party package.
-   **Amazon Bedrock AgentCore Memory** — a third-party session manager, [`AgentCoreMemorySessionManager`](/docs/integrations/session-managers/agentcore-memory/index.md), when you want managed short- and long-term memory.

## Concurrency, isolation, and deletion

**Concurrency is single-writer.** Session management is designed around one live writer per conversation. The built-in managers take no distributed lock, and the in-process guard cannot see a writer running elsewhere, so overlapping invocations on the same session id overwrite each other’s turns and neither call errors. Session creation is a check followed by a write, not an atomic operation, so two simultaneous cold starts on a new id can both succeed with the later write winning — effectively **last-write-wins**. Run one writer per session id; if you fan out, add your own lock or route each id to a single worker.

**Isolation is by namespace and scoped stores.** Each subsystem keeps its data under its own namespace (the context manager’s archive under `context/`, for example) so data never collides, and long-term memory supports a scoped store per tenant rather than one shared store. The session directory is a trusted data store: restrict filesystem permissions to the agent process, and note the Strands Harness SDK does not block symlinks inside it.

**Deletion.** Deleting a session removes its entire root directory (filesystem) or every object under its prefix (S3, which needs `s3:DeleteObject`). Memory is plain files under the memory directory, so removing a tenant’s memory is deleting its directory or store.

## Where to go next

-   [Persist sessions](/docs/user-guide/harness/configure/sessions/index.md) — every session option.
-   [Give long-term memory](/docs/user-guide/harness/configure/memory/index.md) — tune, scope, or disable memory.
-   [Manage context and caching](/docs/user-guide/harness/configure/context-and-caching/index.md) — the third kind of state: keeping one conversation inside the model’s window.

## Implementation

### Python

- [harness-sdk/harness-py/src/strands_harness/agent.py](https://github.com/strands-agents/harness-sdk/blob/main/harness-py/src/strands_harness/agent.py)

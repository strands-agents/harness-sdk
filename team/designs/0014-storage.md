# Unified Storage Primitive

**Status**: Proposed

**Date**: 2026-06-29

**Issue**: TBD

---

<details>
<summary><strong>Definitions</strong></summary>

| Term | Status | Description |
|------|--------|-------------|
| Context Offloader | Shipped | Plugin that caches oversized tool results. Has its own `Storage` interface (`store`/`retrieve`). |
| Session Manager | Shipped | Manages conversation snapshots. Has its own `SnapshotStorage` interface (6 methods). |
| Memory Stores | Shipped | `LocalMemoryStore` persists to disk via raw `node:fs`. No storage abstraction. |
| Context Manager (v2) | Proposed | Agentic context management with L1 history batches. Storage param planned but not yet implemented. |
| Transcripts | Proposed | Immutable audit log of agent interactions. Not yet implemented. |

</details>

---

[Problem](#problem) · [Proposal](#proposal) · [API](#proposed-api) · [DX](#developer-experience)

Appendices: [Interface Mapping](#a-interface-mapping) · [Migration](#b-migration-path) · [Python](#c-python-parity) · [Naming](#d-naming-rationale) · [Query](#e-future-query-extension) · [DX Examples](#f-developer-experience-walkthrough) · [Full Plan](#g-development-plan) · [Alternatives](#h-alternatives-considered)

---

## Problem

The SDK requires data persistence in at least five independent subsystems — tool result caching, session snapshots, long-term memory, context history, and transcripts. Today each subsystem defines its own storage abstraction and its own implementations. This creates real cost for users, contributors, and the SDK team.

### Current State

Today each subsystem either defines its own storage interface or uses raw `node:fs` calls directly. There is no shared contract. What concretely breaks:

1. **Every new SDK feature re-invents storage.** When the team builds a new subsystem that persists data (transcripts, context manager v2), they must write `FileStorage` + `S3Storage` + `InMemoryStorage` from scratch for that subsystem. That's not shared code with existing storage implementations — it's net-new classes, net-new tests, net-new bugs. This is real engineering time multiplied across every feature we ship.

2. **Adding a new backend costs 5× what it should.** Anyone who wants a backend the SDK doesn't ship — whether a community contributor adding Redis support or a user implementing their own DynamoDB adapter — must implement five separate interfaces with different method signatures, naming conventions, and semantics. In practice, nobody contributes storage backends and most users give up and stay on the defaults.

3. **Production deployment requires per-subsystem migration.** Moving from local development to production means swapping storage configuration in every subsystem independently. There's no single place to change "use S3 now" — each subsystem has its own storage constructor that must be found and updated.

4. **Maintenance cost scales multiplicatively.** Every new subsystem adds another set of storage implementations to maintain. Every new backend adds another implementation per subsystem. Without shared code, a bug fixed in one doesn't fix the others.

### What "run an agent in the browser" looks like today vs. with unified Storage

A user wants to run an agent in a browser tab with persistent sessions, memory, and context. The existing implementations assume a Node.js server environment — `FileStorage` uses `node:fs`, `S3Storage` uses server-side AWS credentials. Neither works in a browser without significant modification. They need IndexedDB.

**Today:**
```
1. Read context-offloader Storage interface → implement IndexedDBOffloaderStorage
2. Read session SnapshotStorage interface → implement IndexedDBSnapshotStorage
3. Read LocalMemoryStore source → figure out fs calls → implement IndexedDBMemoryBackend
4. Read context manager storage (once it exists) → implement IndexedDBContextStorage
5. Read transcript storage (once it exists) → implement IndexedDBTranscriptStorage
   Total: 5 classes, 5 different interfaces, ~500 LOC
```

**With unified Storage:**
```
1. Implement Storage (put/get/delete/list) backed by IndexedDB → done
   Total: 1 class, 4 methods, ~50 LOC
```

The same applies to any backend the SDK doesn't ship — GCP, Azure, Redis, DynamoDB, mandated enterprise infrastructure. Today the SDK only ships AWS storage backends, so users on anything else either don't use persistence features or give up. Unified storage makes it practical for the community to add their own backends, making the SDK truly cloud-agnostic.

Transcripts and context manager v2 both need a storage interface. We're going to design one for them either way — the question is whether we design bespoke interfaces that further increase the `subsystems × backends` problem, or design the unified one first and build them on it from day one, changing the scaling model to `subsystems + backends`.

---

## Goals and Non-Goals

**Goals:**
- One low-level interface for blob persistence that all subsystems build on
- Configure once, pass everywhere
- Cross-SDK parity
- Backwards-compatible migration

**Non-goals:**
- Replacing `MemoryStore` (implementations like `LocalMemoryStore` *use* a `Storage` internally for persistence but don't implement it — see [FileMemoryStore design](https://github.com/strands-agents/harness-sdk/pull/2895))
- Replacing the `Sandbox` abstraction (`Sandbox` handles execution isolation; `LocalFileStorage` can route I/O through one via `forSandbox()`, but they're different layers — see [PR #2649](https://github.com/strands-agents/harness-sdk/pull/2649))
- Transactions or locking, query or indexing, and streaming reads/writes — all of which can be added as optional extensions later without breaking the base interface

---

## Proposal

### Recommended: Unified `Storage` Interface

Reclaim the `Storage` name for the SDK-wide primitive. One interface with four operations — `put`, `get`, `delete`, `list` — representing what every storage backend natively supports. Higher-level operations (atomic JSON snapshots, eviction, manifests) are layered by consumers. See [Proposed API](#proposed-api) for the full interface definition.

An optional `query` method for metadata filtering is planned but out of scope for this doc — see [Appendix E](#e-future-query-extension).

**Type hierarchy:**

```
Storage (interface)
├── InMemoryStorage (implements Storage directly)
└── FileStorageBase (abstract, implements Storage — shared path/key logic)
    ├── LocalFileStorage (+ forSandbox())
    ├── S3Storage
    └── GithubStorage
```

`FileStorageBase` is an abstract base class that provides shared logic for file-path-based backends: key/path normalization and key sanitization. Concrete implementations (`LocalFileStorage`, `S3Storage`, `GithubStorage`) extend it with backend-specific I/O. `LocalFileStorage` additionally exposes `forSandbox()` for sandbox-backed I/O. `InMemoryStorage` implements `Storage` directly — it has no file paths or sandbox concept.

**Shipped implementations:**

| Class | Backend |
|-------|---------|
| `InMemoryStorage` | `Map<string, entry>` (optional eviction: `evictAfterTurns`, defaults to 20) |
| `LocalFileStorage` | Local filesystem (extends `FileStorageBase`) |
| `S3Storage` | AWS S3 (extends `FileStorageBase`) |

All exported from `@strands-agents/sdk/storage`. `S3Storage` lazy-imports `@aws-sdk/client-s3` (optional peer dep) — users who don't use it never need the AWS SDK installed.

**Future / community backends:**

| Backend | Notes |
|---------|-------|
| GithubStorage | GitHub-backed (extends `FileStorageBase`) — part of Maisie's intern project |
| DynamoDB | Single-table design, native metadata filtering via `query` |
| Redis | Low-latency, good for ephemeral or cache-heavy workloads |
| GCS | Google Cloud equivalent of S3 (extends `FileStorageBase`) |
| Azure Blob Storage | Azure equivalent of S3 (extends `FileStorageBase`) |
| SQLite | Embedded, zero-config, single-file persistence |
| PostgreSQL / MySQL | Existing infrastructure, ACID guarantees |
| IndexedDB | Browser-compatible storage for client-side agents |

Any first-class or community implementation of `Storage` works with every subsystem that accepts it — sessions, memory, transcripts, context manager, and offloader all benefit without per-backend adapters.

### Top-Level `storage` on Agent

`Agent` accepts a top-level `storage` parameter. All subsystems (sessions, memory, context manager, transcripts, offloader) inherit it automatically unless they provide their own override. This includes the auto-added `ContextOffloader` — today it defaults to `InMemoryStorage`, but with a top-level `storage` configured it uses that instead:

```typescript
const agent = new Agent({
  model,
  storage: new LocalFileStorage({ rootPath: './.agent-data' }),
})
// Sessions, memory, transcripts, context, offloader — all use LocalFileStorage automatically.
```

Per-subsystem overrides are still possible:

```typescript
const agent = new Agent({
  model,
  storage: new LocalFileStorage({ rootPath: './.agent-data' }),
  sessionManager: { storage: new S3Storage({ bucket: 'sessions' }) },  // sessions go to S3
})
```

### How Each Subsystem Uses `Storage`

Every subsystem accepts a `Storage` instance and uses the same pattern: serialize data, `put` it at a namespaced key, `get` it back later. No subsystem-specific storage interfaces needed.

| Subsystem | Prefix | Operations used |
|-----------|--------|-----------------|
| Context Offloader | `offloader/` | `put`, `get` |
| Session Manager | `sessions/` | `put`, `get`, `list`, `delete` |
| Memory Stores | `memory/` | `put`, `get` |
| Context Manager | `context/` | `put`, `get`, `list` |
| Transcripts | `transcripts/` | `put`, `list`, `delete` |

Each subsystem owns its key prefix — no coordination needed between them beyond not colliding (enforced by convention above).

**Breaking changes:** None. Existing subsystem APIs (`SessionManager`, `ContextOffloader`, etc.) widen their `storage` config to accept the unified `Storage` type alongside their current interfaces. Existing code continues to work unchanged — see [Appendix B](#b-migration-path) for the deprecation timeline.

---

### Sandbox Relationship

`Sandbox` and `Storage` are different layers. `Sandbox` handles execution isolation (running code, agent-initiated file I/O). `Storage` handles persistence (data that outlives a turn or session). They don't replace each other.

The connection point: `LocalFileStorage` exposes a `forSandbox()` method that returns a new instance routing all I/O through the agent's sandbox instead of raw `node:fs`. This is only used by subsystems that operate within the agent's execution environment (today: the context offloader, which stores tool results generated inside the sandbox). Subsystems that persist durable data outside execution (sessions, memory, transcripts) write directly to the host filesystem. The pattern already exists in the context-offloader (see PR [#2649](https://github.com/strands-agents/harness-sdk/pull/2649)) and carries forward unchanged with the unified `Storage` interface.

```typescript
// Default: LocalFileStorage uses node:fs directly
const storage = new LocalFileStorage({ rootPath: './.agent-data' })

// Sandbox-backed: routes all I/O through the agent's sandbox
const sandboxedStorage = storage.forSandbox(agent.sandbox)
```

---

## Proposed API

```typescript
export interface Storage {
  put(key: string, data: Uint8Array): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<string[]>
}
```

Options like `contentType`, `metadata`, pagination (`limit`/`startAfter`), and richer return types can be added later as optional trailing parameters (e.g. `put(key, data, options?)`) without breaking existing implementations.

---

## Developer Experience

The core DX is: configure storage once, pass it everywhere.

```typescript
import { Agent } from '@strands-agents/sdk'
import { LocalFileStorage } from '@strands-agents/sdk/storage'

const agent = new Agent({
  model,
  storage: new LocalFileStorage({ rootPath: './.agent-data' }),
})
```

Swapping to S3 for production is a one-line change — replace `LocalFileStorage` with `S3Storage`. Custom backends implement the four-method `Storage` interface and work with every subsystem automatically.

Each subsystem accepts a `Storage` instance, so you can configure them independently:

```typescript
const agent = new Agent({
  model,
  sessionManager: { storage: new S3Storage({ bucket: 'sessions' }) },
  contextManager: { storage: new LocalFileStorage({ rootPath: './.context' }) },
  transcript: { storage: new S3Storage({ bucket: 'audit-logs' }) },
})
```

See [Appendix F](#f-developer-experience-walkthrough) for full examples (filesystem, S3, custom Redis backend, backwards compatibility).

---

<details>
<summary><strong>A: Interface Mapping</strong></summary>

| Subsystem | Current | Unified |
|---|---|---|
| Offloader | `store(key, content, contentType)` | `put(key, encode(content))` |
| Offloader | `retrieve(reference)` | `get(reference)` |
| Session | `saveSnapshot(...)` | `put(key, encode(snapshot))` |
| Session | `loadSnapshot(...)` | `get(key)` |
| Session | `listSnapshotIds(...)` | `list(prefix)` |
| Session | `deleteSession(...)` | `list(prefix)` + `delete(key)` |
| Session | `saveManifest(...)` / `loadManifest(...)` | `put` / `get` |
| Memory | `_flush(records)` / `_readFromDisk()` | `put` / `get` |
| Context (v2) | batch write / history browse | `put` / `list` |
| Transcripts | append / list / delete | `put` / `list` / `delete` |

</details>

<details>
<summary><strong>B: Migration Path</strong></summary>

**Phase 1 — Ship (non-breaking).** Add `src/storage/` with the interface and implementations. Subsystems accept both unified `Storage` and their legacy interfaces via duck-typing. No warnings.

**Phase 2 — Deprecate (next minor).** Emit warnings on legacy interfaces. Rename offloader's `Storage` → `OffloaderStorage`. Update docs.

**Phase 3 — Remove (next major).** Drop legacy interfaces. All subsystems accept only `Storage`.

</details>

<details>
<summary><strong>C: Python Parity</strong></summary>

```python
@runtime_checkable
class Storage(Protocol):
    async def put(self, key: str, data: bytes) -> None: ...
    async def get(self, key: str) -> bytes | None: ...
    async def delete(self, key: str) -> None: ...
    async def list(self, prefix: str) -> list[str]: ...
```

Same names, same semantics. Methods are single-word so they're byte-identical across SDKs. Implementations: `InMemoryStorage`, `LocalFileStorage`, `S3Storage`. Key strings identical (`"sessions/"`, `"memory/"`, etc.).

</details>

<details>
<summary><strong>D: Naming Rationale</strong></summary>

**Why `Storage`?** It's the single storage primitive for the SDK — no qualifier needed. The existing offloader `Storage` lives under a subpath import (`vended-plugins/context-offloader/`) so there's no collision.

Alternatives considered: `BlobStorage`, `ObjectStorage`, `DataStore`, `KeyValueStore`, `PersistenceBackend`. All add noise without disambiguating anything — there's only one storage interface in the SDK.

**Why `InMemoryStorage` / `LocalFileStorage` / `S3Storage`?** Names describe the backend. One `Storage` interface means no disambiguation prefix needed.

Alternatives considered: `MemoryStorage` (ambiguous with `MemoryStore`), `FileStorage` (conflicts with existing class during migration), `DiskStorage` (overly specific — could be tmpfs, NFS, etc.).

</details>

<details>
<summary><strong>E: Future Query Extension</strong></summary>

Optional `query` method for backends with native filtering (DynamoDB, S3 tags, databases):

```typescript
query?(prefix: string, filter: Record<string, string>): Promise<string[]>
```

Consumers feature-detect (`if (storage.query)`) and fall back to `list` + client-side filtering. Additive — doesn't break existing implementations.

</details>

<details>
<summary><strong>F: Developer Experience Walkthrough</strong></summary>

**Local dev (top-level storage, inherited by all subsystems):**
```typescript
const agent = new Agent({
  model,
  storage: new LocalFileStorage({ rootPath: './.agent-data' }),
})
// Sessions, memory, transcripts, context, offloader — all inherit automatically.
```

**Local dev (per-subsystem overrides):**
```typescript
const storage = new LocalFileStorage({ rootPath: './.agent-data' })
const agent = new Agent({
  model,
  storage,
  sessionManager: { storage: new S3Storage({ bucket: 'sessions' }) },
  memoryManager: new MemoryManager({ stores: [new LocalMemoryStore({ name: 'user-prefs', storage })] }),
})
```

**Production (S3):**
```typescript
const storage = new S3Storage({ bucket: 'my-agent-data', prefix: 'prod/', region: 'us-west-2' })
const agent = new Agent({ model, storage })
```

**Custom backend:**
```typescript
class RedisStorage implements Storage {
  async put(key: string, data: Uint8Array): Promise<void> { await this.client.set(key, Buffer.from(data)) }
  async get(key: string): Promise<Uint8Array | null> { return await this.client.getBuffer(key) }
  async delete(key: string): Promise<void> { await this.client.del(key) }
  async list(prefix: string): Promise<string[]> { return await this.scanPrefix(prefix) }
}
```

**Backwards compat:** Legacy `OffloaderStorage` and `SnapshotStorage` still accepted during deprecation window — warnings emitted, no breakage.

</details>

<details>
<summary><strong>G: Development Plan</strong></summary>

**TypeScript first:**
1. `Storage` interface + `FileStorageBase` + `InMemoryStorage` + `LocalFileStorage` → `src/storage/`, export `"./storage"`
2. `S3Storage` extends `FileStorageBase` → lazy-imports `@aws-sdk/client-s3` (optional peer dep)
3. Adapt `ContextOffloader` — accept `Storage`, duck-type legacy for backwards compat
4. Adapt `SessionManager` — accept `Storage` via internal adapter
5. Adapt `LocalMemoryStore` — optional `storage` field replaces raw `fs`
6. Wire into `ContextManagerConfig` (v2)

**Python second:**
7. Port `Storage` protocol + `InMemoryStorage` + `FileStorageBase` + `LocalFileStorage`
8. Adapt context offloader + session repository

</details>

<details>
<summary><strong>H: Alternatives Considered</strong></summary>

**Share implementations internally, keep separate public interfaces.**

Each subsystem keeps its own typed interface but delegates to a shared private `Storage`.

- *Pros:* No breaking change to any public type. Each subsystem retains domain-specific contracts with precise types. Internal code deduplication.
- *Cons:* Users still configure storage per-subsystem. "Configure once" is not solved from the user's perspective — same problem, just hidden. Every new subsystem still needs its own public interface wrapping the internal one.

**Adopt a third-party library (`unstorage`, `keyv`).**

- *Pros:* Dozens of backends for free. Battle-tested. No implementation cost for the storage layer itself.
- *Cons:* Runtime dependency. `unstorage` is string-oriented (not bytes). No Python equivalent for cross-SDK parity. We'd depend on upstream for bug fixes and API evolution. Mismatches with our key-prefix conventions would need adapters anyway.

**Do nothing.**

- *Pros:* Zero migration cost. No learning curve. No risk of getting the abstraction wrong.
- *Cons:* The problems compound with every new subsystem. Community backends remain impractical. Production configuration stays fragmented.

</details>

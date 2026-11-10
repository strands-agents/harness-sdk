# Design Doc: File-Based Agent Memory

| Field  | Value          |
|--------|----------------|
| Status | Proposed       |
| Date   | June 12, 2026  |
| Issue  | TBD            |
| Scope  | TypeScript SDK |

---

## Context

The Strands SDK has no local memory store. The existing store implementation, `BedrockKnowledgeBaseStore`, requires provisioned AWS infrastructure (Bedrock Knowledge Base, credentials, optional S3). This is well-suited for production and enterprise deployments where teams already have AWS infrastructure, but developers who want to prototype, run integration tests, or experiment with agent memory in non-production environments have no option that works without standing up a managed service. `FileMemoryStore` fills this gap: a local store that requires zero external infrastructure, just a filesystem.

Separately, any long-lived memory system needs a maintenance mechanism. As memory accumulates over extended interactions, quality degrades — redundancy grows, contradictions go unresolved, and retrieval becomes less reliable. Managed stores like `BedrockKnowledgeBaseStore` handle this server-side — deduplication, indexing, and retrieval quality are responsibilities of the backend service. This works because the infrastructure runs outside the agent loop: it can process knowledge asynchronously, build embeddings, and serve semantic search without adding latency to agent sessions. A local store needs an equivalent offline step to prevent quality from degrading over time.

`FileMemoryStore` addresses both needs. It organizes knowledge as a structured file hierarchy that the agent can navigate directly, and exposes consolidation as an offline maintenance step, analogous to how managed backends process knowledge asynchronously. Because it operates through the unified `Storage` interface, the backend can be extended to git-based storage, S3, or any other persistence layer without changing the core memory model.

---

## Decision

This proposal introduces **`FileMemoryStore`**, which implements the `MemoryStore` interface (for `MemoryManager` L2, long-term memory). It handles knowledge: extracted facts, progressive disclosure, search, and consolidation.

For L1 (session history), the existing `ContextManager` already accepts a `Storage` instance and provides file operations (`put`, `get`, `list`, `delete`). No additional wrapper class is needed.

`FileMemoryStore` uses a `Storage` instance for its file operations. When none is provided, it defaults to `LocalFileStorage` at `~/.strands/`.

Both L1 and L2 can share the same `Storage` instance pointed at the same root directory, giving a unified, inspectable filesystem containing everything an agent has learned and experienced, without conflating L1 and L2 into a single construct.

The existing Strands API remains unchanged. `MemoryManager` still owns L1 → L2 extraction. What changes is the physical storage: instead of separate, disconnected backends for each layer, both can write to the same file hierarchy. FileMemoryStore writes to `knowledge/` for L2, and a file-backed L1 could write to `context/` under the same root.

### File Hierarchy

`FileMemoryStore` stores memories in `knowledge/` and consolidation metadata to `consolidation/`, all under one root. Because the storage interface is layer-agnostic, the same root could also hold session history (L1) under `context/`— shown below for illustration. L1 file persistence is out of scope for this proposal (it uses a snapshot-based backend today), so nothing currently writes to `context/`.

```
~/.strands/
├── context/                         # L1 - ContextManager writes here; illustrative only, and requires file-backed L1 (out of scope)
│   ├── current.md
│   └── history/
│       ├── 2026-06-10-session-a.md
│       └── 2026-06-11-session-b.md
├── knowledge/                       # L2 - MemoryStore writes here (called by MemoryManager)
│   └── facts/                       # visible by name + description; loaded on demand
│       ├── testing-philosophy.md
│       └── project-context.md
└── consolidation-changelog.md                 # human-readable log of consolidation
```

---

## Progressive Disclosure

Not everything loads into context every turn. The agent retrieves relevant knowledge on demand by navigating the file hierarchy directly. LLMs are precise and accurate at scoped filesystem calls (listing directories, grepping for keywords, reading specific files), and progressive disclosure leverages this skill as the primary retrieval mechanism.

### Relationship to MemoryManager Retrieval

`MemoryManager` provides two retrieval mechanisms: automatic injection (searches stores every turn, injects results into model input) and the `search_memory` tool (agent-initiated). Both call `store.search()` on the store. Progressive disclosure is a *third*, independent retrieval path. The agent navigates the file hierarchy using the `read_<store_name>_file` tool registered by `FileMemoryStore` via `getTools()`.

These are not mutually exclusive, and the user controls which are active:

| Mechanism | Controlled by | How it works with `FileMemoryStore` |
|-----------|---------------|-------------------------------------|
| Injection | `MemoryManager` config (`injection: true`) | Calls `FileMemoryStore.search()` (keyword matching) → injects results as `<memory>` XML |
| `search_memory` tool | Agent-initiated | Same — calls `FileMemoryStore.search()` |
| Progressive disclosure | `progressiveDisclosure: true` on the store (default) | Store returns a ContextInjector plugin (trigger: 'everyTurn') that renders the file listing, and a per-store read tool (`read_<store_name>_file`) via getTools() |

**`injection: false` is recommended** when progressive disclosure is on, as the file listing already tells the model what exists, so also running keyword search + injection each turn wastes tokens on the same problem. search_memory remains available (controlled independently by searchToolConfig) as ranked full-content retrieval in a single tool call, and is the only path that searches across multiple stores in a multi-backend setup.


### How It Works

`FileMemoryStore` contributes two things to the agent, both wired through mechanisms `MemoryManager` already supports:

**1. The file listing (injected every turn via `getPlugins()`)**

`getPlugins()` returns a `ContextInjector` with `trigger: 'everyTurn'`. Each turn it calls `listFiles()` — every entry's path and `description`, sorted, changelog excluded — and injects them as XML, so the agent knows what memory exists without loading any content:

```xml
<memory-files>
Read any file whose description looks relevant with read_agent_memory_file before answering — the descriptions are summaries, not the content.

<file path="facts/testing-philosophy.md">Integration-first, mock at boundaries</file>
<file path="facts/deploy-process.md">Team's deployment pipeline and rollback procedures</file>
<file path="facts/project-architecture.md">Service boundaries and data flow</file>
</memory-files>
```

The trigger is `everyTurn`, not `userTurn`: an autonomous turn that just read one file still needs the listing to pick the next. An empty store injects nothing, so a fresh store costs zero tokens.

**2. The read tool (registered via `getTools()`)**

`getTools()` returns one tool, `read_<store_name>_file` (e.g. `read_agent_memory_file`). It takes a `path` from the listing and returns that file's body with frontmatter stripped. Setting `progressiveDisclosure: false` returns `[]` from both methods, leaving the store searchable through `search_memory` only.

### Retrieval in Practice

The agent judges relevance from the listing's paths and descriptions, then reads specific files with `read_<store_name>_file`. The model can also fall back to the `search_memory` tool, which keyword-scores across file bodies, if it deems that nothing in the file listing matches what it's searching for. See [Appendix A](#appendix-a-retrieval-worked-examples) for worked examples.

### File Format

Knowledge files are markdown with YAML frontmatter containing one field — `description`. The description is what appears in the file listing every turn, letting the agent judge relevance without reading every file:

```markdown
---
description: "How the user approaches testing: integration-first, mock at boundaries"
---

- Prefers integration tests over unit tests for API layers
- Uses VS Code with vim keybindings
- Mocks external services at the HTTP boundary, not at the module level
```

---

### Architecture

#### FileMemoryStore

`FileMemoryStore` implements the `MemoryStore` interface (called by `MemoryManager`). It handles L2 — knowledge storage, progressive disclosure, search, and consolidation. It operates on `knowledge/` through a `Storage` instance for file operations.

```typescript
interface FileMemoryStoreConfig {
  // Required
  name: string;

  // Optional
  storage?: Storage;                // default: LocalFileStorage at ./.strands/ (keys scoped under memory/<name>/)
  description?: string;
  writable?: boolean;               // default: true; set false for a read-only knowledge base
  maxSearchResults?: number;
  extraction?: boolean | ExtractionConfig;
  progressiveDisclosure?: boolean;  // default: true; false → search_memory only
}

interface ConsolidateConfig {
  model?: Model;            // default: the Agent's default model
  operations?: ("deduplicate" | "resolveContradictions" | "deriveInsights" | "prune" | "reorganize")[];
  maxDirectories?: number;  // default: 8
  maxFiles?: number;        // default: 100 — caps planner input by file count
  maxActionsPerPlan?: number; // default: 1000 — caps planner output
}

class FileMemoryStore implements MemoryStore {
  constructor(config: FileMemoryStoreConfig)

  // --- MemoryStore (MemoryManager L2) ---
  async search(query: string, options?: SearchOptions): Promise<MemoryEntry[]>
  async add(content: string, metadata?: Record<string, JSONValue>): Promise<string>  // returns the stored key

  // --- Progressive disclosure (wired by MemoryManager) ---
  getPlugins(): Plugin[]   // file-listing injector
  getTools(): Tool[]       // read_<name>_file tool
  async listFiles(): Promise<{ path: string; description: string }[]>

  // --- Consolidation ---
  async consolidate(config: ConsolidateConfig): Promise<void>
}
```

### Method Behavior

#### FileMemoryStore

**`add(content, metadata?)`**

Writes a new markdown file to `knowledge/facts/` by default. No model call. Pass `metadata.path` to write to a custom location under `knowledge/` (e.g., `operations/debugging` → `knowledge/operations/debugging.md`).

- **Filename:** `metadata.path` if present (used as the target path), otherwise `metadata.title` if present, otherwise first few words of the content plus a timestamp (e.g., `testing-preferences.md` or `user-prefers-dark-mode-1718234.md`)
- **Frontmatter `description`:** `metadata.description` if present, otherwise first sentence of the content

The `metadata` fields come from the `ModelExtractor` when automatic extraction is configured, and its system prompt instructs it to produce a title and description for each extracted fact (see [Appendix B](#appendix-b-extraction-configuration) for the configuration example). When the agent uses the `store_memory` tool instead (explicit write), no extractor is involved — `add()` receives raw content with no metadata and falls back to deriving both from the content. The `path` override is primarily for programmatic writes (setup scripts, external tools) that know exactly where content belongs.

**`search(query, options?)`**

Required by the `MemoryStore` interface. The default implementation performs keyword matching against filenames, `description` frontmatter, and file content. Returns the top matches as `MemoryEntry[]`, ranked by term frequency. No model call, no embeddings.

`search_memory` calls this method. It provides ranked full-content retrieval in a single tool call — useful when the agent can't identify the right file from the file tree alone, or when searching across multiple stores in a multi-backend setup. Progressive disclosure's tool `read_<store_name>_file` complement this with direct file access within the file hierarchy.

---

## Integration with Existing Features

Minimal setup (defaults to `LocalFileStorage` at `./.strands/`):

```typescript
import { Agent, MemoryManager } from "@strands-agents/sdk";
import { FileMemoryStore } from "@strands-agents/sdk/vended-memory-stores/file-memory-store";

const memoryStore = new FileMemoryStore({ name: "agent-memory" });

const agent = new Agent({
    model,
    memoryManager: new MemoryManager({
        stores: [memoryStore],
        injection: false, // progressive disclosure already injects the file listing; automatic search-injection is redundant
    }),
});
```

Point the store at a custom `Storage` backend: here a GitHub repo, so L2 memory is versioned and shareable across a team:

```typescript
import { GithubStorage } from "./github-storage"; // a custom Storage implementation
import { FileMemoryStore } from "@strands-agents/sdk/vended-memory-stores/file-memory-store";

const storage = new GithubStorage({ owner: "myorg", repo: "agent-memory", branch: "main" });
const memoryStore = new FileMemoryStore({ name: "agent-memory", storage });

const agent = new Agent({
    model,
    memoryManager: new MemoryManager({
        stores: [memoryStore],
        injection: false,
    }),
});
```

---

## Consolidation

Consolidation improves memory quality after facts accumulate. It is a developer-invoked offline maintenance method on `FileMemoryStore`. It reads stored knowledge, uses an LLM to produce a validated action plan, and writes changes through `Storage`.

All extracted facts land in `knowledge/facts/` by default — `FileMemoryStore.add()` writes there unless an explicit `metadata.path` override is provided. This avoids a classification model call on every extraction while still allowing programmatic writes (setup scripts, external tools) to target a specific directory. Consolidation is responsible for reorganizing files into appropriate subdirectories during offline maintenance — it may create new directories when the content warrants it (subject to programmatic guardrails), since it has full cross-file context to make informed categorization decisions.

### How It Works

Consolidation uses a **plan-then-execute** strategy: a single structured-output LLM call over all files produces a structured action plan (Zod-validated JSON), programmatic validation ensures the plan obeys structural invariants, and execution applies the validated plan deterministically.

```
myStore.consolidate(config)
│
├─ 1. SCOPE: read every file in the store into a path → content snapshot.
│     An empty store is a no-op; a non-writable store throws.
│
├─ 2. BOUND: reject an oversized store before reading content.
│     - maxFiles (default 100): throw if the store holds more files than one call can plan over.
│     (maxActionsPerPlan and maxDirectories are enforced later, against the returned plan.)
│
├─ 3. PLAN: one structured-output LLM call over the whole snapshot.
│     - model:         config.model, or the Agent's default model when unset
│     - system prompt: built from config.operations
│     - output schema: ConsolidationPlanSchema (discriminated union: merge/update/delete/move)
│
│     The model returns a JSON plan — it does NOT execute changes itself.
│
├─ 4. VALIDATE: parse the plan, then check it against guardrails.
│     - action count ≤ maxActionsPerPlan (default 1000)
│     - every referenced path exists in the snapshot; sandboxed to the store; depth ≤ 1;
│       ≤ maxDirectories; naming format enforced
│     - action types match the requested operations; no path is both written and deleted
│     Any failure throws — no retry, and nothing is mutated.
│
├─ 5. EXECUTE: apply the validated plan, writes before deletes.
│     A crash between the two passes leaves duplicated content, never lost content.
│     Deletes are best-effort — failures are collected, not thrown mid-pass.
│
└─ 6. RECORD: append a summary to consolidation-changelog.md (even on partial failure),
       then throw if any delete failed.
```

`consolidate()` returns `void`; the applied changes are visible in the file hierarchy and summarized in `consolidation-changelog.md`. It throws if the store is not writable, if a run is already in flight on the same instance, or if any delete fails after the writes land.

A single whole-store call keeps the initial implementation simple and gives the model full cross-file context (so cross-directory deduplication and reorganization fall out of one plan). Per-directory clustering (which lifts the context ceiling and enables parallelism) is the natural follow-up and is deferred until it can be benchmarked.

### Operations

The `operations` config controls which directives go into the system prompt. They are prompt instructions — the LLM decides how to apply them using the file content and change history available in its context.

| Operation | Model behavior | Example |
|-----------|---------------|---------|
| `deduplicate` | Merge files expressing the same fact | "User prefers dark mode" + "Theme preference: dark" → one file |
| `resolveContradictions` | Keep the more recent fact (per change history), delete the other | "Uses tabs" (April) vs "Uses spaces" (June) → keeps spaces |
| `deriveInsights` | Combine related facts into a higher-level pattern | 3 testing facts → "Testing philosophy: high-fidelity, boundary-mocked" |
| `prune` | Delete entries whose content is fully covered by a newer file | `old-deploy-process.md` superseded by `deploy-process.md` → deleted |
| `reorganize` | Move files to appropriate subdirectories based on content; may create new directories. The single whole-store call already has full cross-directory visibility, so moves are planned alongside the other operations rather than in a separate pass. | Fact about debugging patterns in `facts/` → moved to `operations/debugging.md` |

### Directory Management: Hybrid Guardrails

Consolidation uses a hybrid of model reasoning and programmatic constraints for directory management. The model decides *which* directory a file belongs in and *what* new directories should be called — these are judgment-based decisions that benefit from cross-file context. Programmatic validation of the returned plan enforces structural invariants the model cannot violate:

| Concern | Mechanism |
|---------|-----------|
| Which directory a file belongs in | Model reasoning (in the structured-output plan) |
| What to name a new directory | Model reasoning (in the structured-output plan) |
| Max number of directories (`maxDirectories`, default 8) | Programmatic — plan rejected at validation |
| Max nesting depth (one level under `knowledge/`) | Programmatic — plan rejected at validation |
| Directory naming format (lowercase, alphanumeric, hyphens, ≤30 chars) | Programmatic — plan rejected at validation |

This avoids relying solely on prompt engineering for structural constraints (which can be ignored or misinterpreted by the model) while preserving model creativity for the organizational decisions that genuinely require judgment.

### Usage

Since Strands is a client-side SDK with no server process, consolidation needs an external trigger:

```typescript
// Execute consolidation — changes are applied and recorded in consolidation-changelog.md
await myStore.consolidate({
  model,
  operations: ["deduplicate", "resolveContradictions"],
});
```

Scheduling frequency is controlled by the developer — e.g., after each session for incremental cleanup, or weekly for a deep clean. See [Appendix D](#appendix-d-consolidation-examples) for the nightly vs. weekly patterns for option 2, and [Appendix E](#appendix-e-github-action-yaml) for an example GitHub Action trigger.

---

## Alternatives Considered

### 1. Branching: Separate branch per session

Each session writes to its own branch, merges back to `main` on close.

**Why rejected:** Path-based isolation (`context/{id}.md`) achieves the same separation without branch management overhead or merge conflicts.

### 2. Consolidation: Inline during agent sessions

Trigger consolidation within the agent loop (e.g., every N turns) instead of externally.

**Why rejected:** Consolidation reads many files and calls a model — running it mid-session adds latency to agent responses. Since Strands is a client-side SDK with no background process, there's no way to run it asynchronously without blocking the user. External invocation (GitHub Action, CLI) keeps the agent loop fast and gives developers cost control.

### 3. Consolidation: Deterministic rules instead of LLM

Hard-coded deduplication rules (e.g., cosine similarity > 0.95 → merge).

**Why rejected:** Rules miss semantic duplicates ("User prefers dark mode" vs. "Theme preference: dark") and can't derive insights from combining related facts. LLM judgment handles nuance. Non-determinism is mitigated by every change being versioned and reversible.

### 4. File placement: Classify at extraction time

Have `FileMemoryStore.add()` call a model to categorize each fact (e.g., preference, procedure, project fact) and write it directly to the appropriate subdirectory.

**Why rejected:** Adds a classification model call to every extraction, increasing latency and token cost during agent sessions. The classifier also only sees a single fact in isolation, leading to worse categorization than consolidation, which sees all files together and can make informed cross-file decisions. Writing everything to `facts/` by default keeps `add()` fast and simple, and lets consolidation handle reorganization with full context during offline maintenance.

### 5. Retrieval: Heuristic scoring with metadata

Score files using frontmatter metadata (tags, recency, access frequency) and load top-K within a token budget. No agent involvement in retrieval.

**Why rejected:** Requires building metadata infrastructure (tag extraction, scoring weights, access counters). Vector store backends like Bedrock Knowledge Bases have embeddings and similarity scoring server-side, making programmatic scoring natural. For a filesystem store there is no equivalent infrastructure — the agent's own judgment (navigating via filenames and descriptions) is the better retrieval engine.

### 6. Consolidation: Per-directory tool-calling agents

Spawn a Strands agent per file cluster, each equipped with `read_file`, `write_file`, and `delete_file` tools. The agent reads its cluster's files, reasons about what to change, and applies modifications as it goes via tool calls.

**Why rejected:** Non-deterministic execution — the agent applies changes as it goes, making partial failures hard to recover from. No pre-execution validation of a complete plan, so invalid operations (path violations, directory limit breaches) are caught mid-flight. Higher token cost from multi-turn tool-call overhead. Structured output gives an inspectable, validatable plan before any filesystem mutation.

### 7. Consolidation: Per-directory clustered calls (deferred, not rejected)

Instead of one call over the whole store, cluster files by subdirectory and make one structured-output call per cluster, running clusters in parallel over disjoint file sets.

**Why deferred:** Clustering is the answer to the single whole-store call's one real limit — context size (~50–100 files). It also unlocks parallelism. But it adds orchestration (clustering, a join, a cross-directory reorganize pass) whose payoff only materializes once a store spans multiple directories or exceeds the file/byte budget. Phase 1 ships the single whole-store call with `maxFiles` / `maxInputBytes` guards that fail loudly at the ceiling; clustering lifts that ceiling when real corpora demand it. The single call also gives the model full cross-file context in one shot, so cross-directory dedup and reorganization fall out of one plan.

---

## Consequences

### What Becomes Easier

- No ongoing infrastructure costs for storage and retrieval — everything runs locally. Only LLM calls (extraction, consolidation) cost tokens, and those are controlled by the developer.
- Cross-session knowledge with zero external infrastructure (no vector DB, no managed service)
- Developer debugging — inspect the file hierarchy directly; changes are diffable
- Portability — memory directory can be copied, shared, or used to seed other agents with a knowledge base

### What Becomes Harder

- Scaling beyond ~1,000 knowledge files — file listing and search may slow down with very large trees
- Concurrent writes from multiple agent instances — simultaneous writes require coordination (file locking or single-writer constraint)
- Retrieval quality depends on model judgment — the agent must recognize when to search and what to read; if it doesn't look, relevant memories stay hidden
- Consolidation cost and non-determinism — each run calls a model, costs tokens, and may produce different results on re-runs
- Storage growth — sessions accumulate indefinitely; may need a retention policy for old session files



---

## Security Model

`FileMemoryStore` assumes single-tenant compute — one instance per user/agent. `Storage` is identity-unaware; it takes a path and performs I/O without knowledge of who is asking. It is not a multi-tenancy boundary. Deployments serving multiple users must isolate at the container or credential layer (e.g., separate containers per tenant), not within a shared `Storage` instance. Path validation is defense-in-depth against bugs, not an access control mechanism.

---

## Willingness to Implement

Yes.


---
<details>
  <summary><b>Appendix A: Retrieval Worked Examples</b></summary>

```
User asks: "how should I structure these tests?"

Agent sees file tree → spots "testing-philosophy.md" (description: "Integration-first, mock at boundaries")
Agent calls: `read_<store_name>_file`("knowledge/facts/testing-philosophy.md")
→ full content loaded into context, agent answers using the loaded knowledge
```

For broader queries:

```
User asks: "what do you know about our deploy process?"

Agent sees file tree → spots "deploy-process.md" (description: "Team's deployment pipeline and rollback procedures")
Agent also sees "project-architecture.md" (description: "Service boundaries and data flow")
Agent calls: `read_<store_name>_file`("knowledge/facts/deploy-process.md")
→ full content loaded into context, agent answers from it
```

When filenames and descriptions aren't enough:

```
User asks: "what was that thing about retrying failed requests?"

Agent sees file tree → no filename or description obviously matches "retrying failed requests"
Agent calls: search_memory("retry failed requests")
→ FileMemoryStore.search() keyword-matches against file content, returns relevant entries
→ agent gets content directly without guessing which file to read
```

</details>

<details>
  <summary><b>Appendix B: Extraction Configuration</b></summary>

```typescript
const myStore = new FileMemoryStore({
  name: "agent-memory",
  extraction: {
    triggers: [new InvocationTrigger()],
    extractor: new ModelExtractor({
      model,
      systemPrompt: `Extract discrete facts from the conversation. For each fact, return:
- content: the fact itself
- metadata.title: a 2-4 word slug (e.g., "testing-preferences")
- metadata.description: a one-line summary for discoverability`,
    }),
  },
});
```

</details>

<details>
  <summary><b>Appendix C: Versioning and Rollback (Nice to Have)</b></summary>

The core `FileMemoryStore` operates on `Storage` alone — no versioning required. For developers who want rollback support and richer change tracking (e.g., undoing bad consolidation), `Storage` implementations can optionally expose versioning methods. This is a nice-to-have extension, not a requirement for the initial implementation.

### Versioning Extension

Backends that support versioning can additionally implement `changesSince()` and `rollback()`:

```typescript
interface VersionedFileStorage extends Storage {
  changesSince(timestamp: number): Promise<FileChange[]>;
  rollback(path: string, timestamp: number): Promise<void>;
}

interface FileChange {
  path: string;
  timestamp: number;
  operation: "write" | "delete";
}
```

**`changesSince(timestamp)`** returns all writes and deletes after the given timestamp — would enable a future `scope: 'latest'` option for incremental consolidation (processing only files changed since the last run). **`rollback(path, timestamp)`** restores a file to its state at the given timestamp — used to undo bad consolidation.

| Implementation | How it versions |
|---------------|----------------|
| `LocalFileStorage` | Copies previous content to `.versions/{path}/{timestamp}` before overwriting; maintains a `.journal` file for `changesSince()` |
| `S3Storage` | S3 object versioning — managed by the service |
| `GithubStorage` | Git commits — `changesSince` maps to commit history, `rollback` restores from a prior commit |

### Git-Based Example

```typescript
class GithubStorage implements VersionedFileStorage {
  // Storage methods
  async put(key: string, data: Uint8Array) { /* GitHub Contents API PUT (creates commit) */ }
  async get(key: string) { /* GitHub Contents API GET */ }
  async delete(key: string) { /* GitHub Contents API DELETE */ }
  async list(prefix: string) { /* GitHub Trees API */ }

  // Versioning methods
  async changesSince(timestamp: number) { /* git log --since via Commits API */ }
  async rollback(path: string, timestamp: number) { /* restore file content from prior commit */ }
}
```

### Call Flow

When the agent extracts a fact, `FileMemoryStore.add()` writes through its `Storage` instance:

```
agent extracts "user prefers dark mode"
  → FileMemoryStore.add(content, { title: "dark-mode" })
    → Storage.put("knowledge/facts/dark-mode.md", data)
      → fs.writeFile("~/.strands/knowledge/facts/dark-mode.md", data)    // LocalFileStorage
      → s3.PutObject(...)                                                 // S3Storage
      → github.createOrUpdateFileContents(...)                            // GithubStorage
```

When consolidation runs, files are read/written through the storage backend:

```
myStore.consolidate({ model, operations: ["deduplicate"] })
  → storage.list("knowledge/")            // all files in scope
  → consolidation plans and executes changes via Storage
```

### Usage

```typescript
const storage = new GithubStorage({ owner: "myorg", repo: "agent-memory", branch: "main" });

const memoryStore = new FileMemoryStore({
    name: "agent-memory",
    storage,
});

const agent = new Agent({
    model,
    memoryManager: new MemoryManager({ stores: [memoryStore] }),
});
`

</details>

<details>
  <summary><b>Appendix D: Consolidation Examples</b></summary>

### Full Usage Script

```typescript
// consolidate.ts — run via cron, GitHub Action, or manually
import { FileMemoryStore } from "@strands-agents/sdk/memory";

const myStore = new FileMemoryStore({ name: "agent-memory" });

// Nightly (targeted operations only)
await myStore.consolidate({
  model,
  operations: ["deduplicate", "resolveContradictions"],
});

// Weekly deep clean (all operations by default)
await myStore.consolidate({ model });
```

Applied changes are recorded in `consolidation/changelog.md`.

### Example Output

Each operation is recorded in `consolidation/changelog.md` (serves as both audit log and potential cursor for future incremental scoping):

```markdown
## 2026-06-15 02:00 (nightly)
- Consolidate(deduplicate): merged `facts/dark-mode.md` into `facts/editor-preferences.md`
- Consolidate(resolve): kept "uses spaces" over "uses tabs" (recency: June vs April)
- Consolidate(derive): synthesized `facts/testing-philosophy.md` from 3 entries
- Consolidate(prune): deleted `facts/old-deploy-process.md` (last written 2026-03-01, superseded by `facts/deploy-process.md`)
```

</details>

<details>
  <summary><b>Appendix E: GitHub Action YAML</b></summary>

```yaml
# .github/workflows/consolidate.yml
name: Memory Consolidation

on:
  schedule:
    - cron: "0 2 * * *" # nightly
  workflow_dispatch: # manual trigger

jobs:
  consolidate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx strands-memory consolidate --path ~/.strands
      - run: |
          git config user.name "strands-consolidation[bot]"
          git config user.email "consolidation@users.noreply.github.com"
      - run: git diff --quiet || (git add . && git commit -m "Consolidate: nightly maintenance" && git push)
```

</details>

<details>
  <summary><b>Appendix F: Benchmarks To Test</b></summary>

### Deep Memory Retrieval (DMR)

Have the agent accumulate knowledge across sessions stored in `FileMemoryStore`, then test whether it can recall facts from session 1 after 10+ sessions have passed. Compare recall accuracy with vs. without consolidation to measure consolidation's impact on long-horizon retrieval quality.

### File-Hierarchy Retrieval vs. Embeddings

Compare progressive disclosure (file tree + agent navigation) against embedding-based retrieval. Letta's research found that their filesystem approach scored 74.0% on the LoCoMo benchmark by storing conversational histories in files — beating specialized memory tool libraries. Evaluate `FileMemoryStore` against the same or similar benchmarks.

### Consolidation Frequency

Measure the relationship between consolidation frequency and token cost vs. retrieval quality. Research suggests diminishing returns — find the optimal cadence that preserves retrieval quality without excessive token usage.

</details>

<details>
  <summary><b>Appendix G: Success Criteria and Stretch Goals</b></summary>

### Required

| Criterion | Measure |
|-----------|---------|
| SDK integration | A working `FileMemoryStore` that plugs into `memoryManager.stores`, with both L1 and L2 sharing a `Storage` instance — passing integration tests with the existing SDK |
| `LocalFileStorage` | A `Storage` implementation backed by the local filesystem. Reads/writes files under a configurable root directory. The default backend for local development and prototyping. |
| `GithubStorage` | A `Storage` implementation backed by GitHub repos (Contents API for read/write/delete, Trees API for list). Enables shared, collaborative agent memory across teams via standard git workflows (PRs for consolidation review, branch protection for `system/`, `.github/workflows/` for scheduled consolidation). |
| Auditable history | `consolidation/changelog.md` tells a coherent story of what the agent learned and when — a developer can trace how memory evolved over time without inspecting individual file diffs |
| Consolidation quality | Benchmark showing how consolidation changes retrieval quality (e.g., DMR recall before/after consolidation runs) |
| Progressive disclosure efficiency | Benchmark measuring how progressive disclosure changes tokens loaded per turn and retrieval accuracy vs. full-context injection |
| Inspectable | A developer can browse the memory directory and diff file changes directly — the file hierarchy is human-readable and diffable |

### Stretch Goals / Nice to Have

| Criterion | Measure |
|-----------|---------|
| Versioning extension | A `VersionedStorage` interface extending `Storage` with `changesSince()` and `rollback()` for precise change tracking and undo support — see [Appendix C](#appendix-c-versioning-and-rollback-nice-to-have) |
| `scope` param | Add a `scope` parameter to `ConsolidateConfig`. `'latest'` processes only files changed since the last consolidation run via `VersionedStorage.changesSince()`. `'all'` processes everything under `knowledge/` (current default behavior). Depends on the versioning extension. |
| Semantic search (local index) | An alternative to progressive disclosure: instead of the agent judging relevance from the file listing, `search()` does true semantic retrieval. An offline index-build step computes an embedding per knowledge file into a local index (e.g. `embeddings.json`); at runtime `search()` embeds the query and does cosine similarity against it — synonyms and paraphrase, no vector service, no runtime model call, scaling to ~1,000 files. Tradeoff: progressive disclosure spends tokens every turn (listing + navigation) but needs no index; a semantic index spends tokens only offline and is free at runtime, letting the store lean on `injection`/`search_memory` rather than agent navigation |
| Comparative benchmarks | Benchmark comparison against managed alternatives (`BedrockKnowledgeBaseStore`) and in-memory baselines showing where a local file store adds value and where it doesn't |
| End-to-end deployed example | A deployed Strands agent (code review, coding assistant, or similar) that uses `FileMemoryStore` for memory accumulation across sessions, with scheduled consolidation via GitHub Actions. Deployed for an internal team use case (e.g., a code review agent that remembers codebase patterns, or an onboarding agent that accumulates project knowledge) AND publishable as a labs/devtools sample demonstrating the full lifecycle: agent learns → memory accumulates → consolidation improves → agent gets better over time |

</details>

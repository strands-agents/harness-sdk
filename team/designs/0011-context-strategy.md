# Design: Context Management Presets

**Status**: Proposed

**Date**: 2026-06-12

**Issue**: [strands-agents/docs#831](https://github.com/strands-agents/docs/pull/831)

**Related**:
- [0003-context-management.md](./0003-context-management.md) — High-level context management strategy
- [0008-proactive-context-compression.md](./0008-proactive-context-compression.md) — Proactive compression
- [0009-context-offloader.md](./0009-context-offloader.md) — Context offloader plugin

**Scope**: Cross-SDK design. v1 implementation merged in [strands-agents/harness-sdk#2643](https://github.com/strands-agents/harness-sdk/pull/2643). v2 proposed.

---

- [1. Problem Statement](#1-problem-statement)
- [2. The Cache Hierarchy](#2-the-cache-hierarchy)
- [3. Presets](#3-presets)
- [4. TypeScript v1](#4-typescript-v1)
- [5. TypeScript v2](#5-typescript-v2)
- [6. Anticipated Questions](#6-anticipated-questions)
- Appendix A: Code Examples
- Appendix B: Alternatives Considered
- Appendix C: Composition Edge Cases
- Appendix D: Plugin & Strategy Details
- Appendix E: L1 Storage Model

---

## 1. Problem Statement

Every non-trivial agent eventually hits context limits. Strands already provides the building blocks to handle this — externalization, compression, conversation managers, hooks — but today these are independent extension points that users must discover, configure, and compose themselves. The SDK covers the 20% case (power users who want full control) but not the 80% case (developers who want context management to just work).

As context management ships more capabilities, this gap widens. Each feature is another plugin or tool to wire up. The Strands [tenets](https://github.com/strands-agents/docs/blob/main/team/TENETS.md) call for **the obvious path to be the happy path** and for **simple things to be simple**. Context management should be a one-liner, not a composition exercise.

This design proposes opinionated defaults via a single `contextManager` parameter on `Agent` — backed by the same extension points that power users already configure manually, but with sensible choices pre-made for everyone else.

---

## 2. The Cache Hierarchy

> **Note:** This doc covers L0 ↔ L1 (within-session context management). L2 and anything memory-related is out of scope — see Thomas's Memory primitive design. References to memory in this doc are included only for background.

Context management maps to a three-tier cache hierarchy. Every operation is movement between tiers.

| Tier | What it is | Access cost | Backed by |
|------|-----------|-------------|-----------|
| **L0 — Context window** | `agent.messages` — what the model sees on every request. May contain summaries where originals were evicted. | Zero (already in context) | In-memory message list |
| **L1 — Session history** | Append-only log of messages. Only written when there's a consumer (agentic mode or `memoryManager`). Messages are batch-written to L1 before each summarization. See Appendix E for storage internals. | Low (retrieval tool call) | `ContextManager` storage (`FileStorage`, `S3Storage`, etc.) |
| **L2 — Long-term memory** | Cross-session knowledge — archival memory, semantic search index, learned facts. Persists beyond the current session. | Higher (query + load from persistent storage) | Memory primitive, vector store, managed memory services |

L2 (long-term memory) is a separate primitive (`memoryManager`) — out of scope for this document. From this doc's perspective, L1 is append-only and immutable for the session lifetime. The tool result cache is separate — short-lived and auto-evicting, not immutable.

See Appendix E for L1 storage internals.

---

## 3. Presets

The `contextManager` parameter accepts a **strategy** that determines who controls L0 — what stays in the context window and when things get compressed to L1.

Both strategies share the same infrastructure. When context pressure builds, L0 is compressed. Oversized tool results are cached separately, and `retrieveToolResult` is always available so the agent can recover truncated outputs without reasoning about context.

The difference: in **auto**, the agent interacts with content. In **agentic**, the agent reasons about its own context.

The logic lives in plugins, not tools. Tools are agent-facing wrappers around plugin methods. In auto mode, the framework calls plugin methods via hooks (e.g., `ContextCompression.compress()` fires on threshold). In agentic mode, the same hooks still fire as a safety net, but tools are also registered so the agent can invoke the same methods proactively. The strategy controls which tools are exposed — not what logic exists.

| | `"auto"` | `"agentic"` |
|--|----------|-------------|
| Framework compresses when threshold hit | Yes | Yes |
| Framework caches oversized tool results | Yes | Yes |
| Agent can recover truncated tool output | Yes (`retrieveToolResult`) | Yes |
| Agent can trigger compression | No | Yes (`compressContext`) |
| Agent can protect messages from eviction | No | Yes (`pinMessage`) |
| Agent can read from L1 | No | Yes (`getHistory`) |
| Agent can search L1 | No | Yes (`searchHistory`) |
| Agent can spawn context-aware children | No | Yes (`delegateWithContext`) |
| Agent can check its context budget | No | Yes (`getContextBudget`) |

Users who don't want presets can build custom context management using the same infrastructure. Token tracking, message metadata, token estimation, and context limit primitives together give users everything they need to write their own `BeforeModelCallEvent` hooks with custom policies. The presets are opinionated compositions of these primitives, not the only way to use them.

### `"auto"` — The framework decides

The framework manages L0 transparently. When context pressure builds, messages are summarized or dropped in L0. No L1 writes happen in auto mode — L1 is only written when there's a consumer (agentic mode or `memoryManager`). The agent doesn't know context management is happening — it just never hits a wall. The only tool exposed is `retrieveToolResult` for recovering truncated tool outputs.

**Use cases:** Beginners who don't want to think about context yet. Production deployments where predictability matters more than autonomy. Cost-sensitive workloads at scale. Multi-agent systems where child agents need lightweight, hands-off management. Anyone who wants it to just not break.

### `"agentic"` — The agent decides

> **Note:** `"agentic"` is experimental. It depends on research into whether models effectively use context management tools. `"auto"` ships first and is the primary focus.

Everything `"auto"` does still happens — the agent *also* gets tools to actively manage its own L0. It can decide when to compress, what to protect from eviction, and browse evicted messages in L1.

**Use cases:** Research agents and coding assistants that benefit from self-awareness about their context state. Long-running autonomous agents. Exploratory development where agent autonomy is the point. Parent agents in multi-agent orchestrations.

### Growth and ownership

More strategies may be added as context management capabilities evolve. Per the [pay-for-play tenet](https://github.com/strands-agents/docs/blob/main/team/TENETS.md), the Strands team owns these presets and reserves the right to make breaking changes to them — what a strategy resolves to underneath (which plugins, which defaults) can change between versions. Users who need stability should configure plugins directly rather than relying on preset internals.

Defaults for all preset configurations (thresholds, strategies, token limits) should be informed by benchmarking before shipping. No default should be set based on intuition alone.

---

## 4. v1 — Shipped

Ships `contextManager: "auto"` / `context_manager="auto"` as an opt-in parameter.

### What ships

```typescript
const agent = new Agent({ contextManager: "auto" });
```

```python
agent = Agent(model=model, context_manager="auto")
```

In v1, `contextManager` accepts a string value only (`"auto"`). The Agent resolves the input directly into plugins and a conversation manager — no intermediate class. The `ContextManager` class (owning token estimation, budget, cursors) is introduced in v2 for power users who need lifecycle hooks or direct storage access.

The default is `undefined` / `None` (no context management). This avoids surprises on upgrade and gives us time to prove the behavior works before making it default.

Under the hood, this wires up:

| Component | What it does | Benchmark-validated defaults |
|-----------|-------------|------------------------------|
| **`ContextOffloader`** | Oversized tool results cached in-memory (short-lived, auto-evicting) via `AfterToolCallEvent` hook. Agent sees a truncated preview. Provides `retrieve_offloaded_content` tool for on-demand access. Renamed to `ToolResultCache` in v2 (config key changes from `contextOffloader` to `toolResultCache`). | `maxResultTokens=1500`, `previewTokens=750` |
| **`SummarizingConversationManager`** | `BeforeModelCallEvent` hook checks L0 token usage against threshold. When exceeded, summarizes older messages in L0. | `summaryRatio=0.3`, `compressionThreshold=0.85` |

### Coexistence with `conversationManager`

In v1, the user's conversation manager is respected. When the user provides their own, it is used instead of the default `SummarizingConversationManager`. The offloader is still added regardless:

```typescript
// Uses default SummarizingConversationManager with proactive compression
const agent = new Agent({ contextManager: "auto" });

// Uses user's conversation manager; offloader still added
const agent = new Agent({
  contextManager: "auto",
  conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
});
```

```python
# Uses default SummarizingConversationManager with proactive compression
agent = Agent(model=model, context_manager="auto")

# Uses user's conversation manager; offloader still added
agent = Agent(model=model, context_manager="auto", conversation_manager=SlidingWindowConversationManager(window_size=20))
```

If the user already has a `ContextOffloader` in their plugins list, it is not overridden.

Stateful models reject both `contextManager` and `conversationManager` — they manage conversation state server-side.

### Storage note

The v1 offloader uses `InMemoryStorage` — content does not persist across process restarts. Agents using `sessionManager` that need durable offloaded content should provide an explicit `ContextOffloader` with persistent storage via the `plugins` parameter.

---

## 5. v2 — Proposed

Three changes:
1. **`"auto"` becomes the default** — every agent gets context management unless opted out
2. **`"agentic"` ships** — agent-in-the-loop context management
3. **`conversationManager` is deprecated** — its compression responsibility moves to `ContextCompression`

### Plugin decomposition

Each plugin has a single cohesive responsibility. `ContextManager` is not a plugin — it's the top-level class that the config resolves to. It owns shared infrastructure (storage, token estimation, budget tracking, cursors) and composes the plugins below. Plugins read from `ContextManager` rather than depending on each other.

| Component | Role | Domain | Tools | Mode |
|-----------|------|--------|-------|------|
| **`ContextManager`** | Config resolver + shared infrastructure | Storage, token estimation, budget, cursors | `getContextBudget` (agentic) | Always |
| **`ToolResultCache`** | Plugin | Cache oversized tool results | `retrieveToolResult` | Both |
| **`ContextCompression`** | Plugin | L0 writes — compression, pinning | `compressContext`, `pinMessage` (agentic) | Both |
| **`ContextNavigation`** | Plugin | Read from L1 (session history) | `getHistory`, `searchHistory` | Agentic only |
| **`ContextDelegation`** | Plugin | Context-aware child spawning | `delegateWithContext` | Agentic only |

v2 introduces `OnContextOverflowEvent` — a new lifecycle event fired on context length errors, replacing the opaque retry logic in conversation managers. The SDK already normalizes these errors across all providers into `ContextWindowOverflowError` — this event just exposes that to plugins.

### `conversationManager` deprecation

In v2, `ContextCompression` takes over compression and L1 writing. Nothing left for `conversationManager`.

**Deprecation path:**
1. **v1 (coexist):** Both live side by side. No conflict.
2. **v2 (deprecate):** Deprecation warning emitted. `contextManager` takes precedence if both are set.
3. **v3 (remove):** `conversationManager` removed from the constructor type.

---

## 6. Anticipated Questions

**Q: Why isn't `"auto"` the default in v1?**

We need to prove the behavior first. v1 is opt-in so we can validate with early adopters. v2 makes it the default once we're confident it works reliably.

**Q: What happens when users upgrade from v1 to v2?**

Two changes: (1) `"auto"` becomes the default — agents that didn't set `contextManager` now get it automatically. Users who don't want this can set `contextManager: false`. (2) Internals upgrade — `ToolResultCache` replaces `ContextOffloader`, `ContextCompression` replaces conversation manager compression — same external behavior.

**Q: What if the user provides their own plugin?**

Deduplication detects by type and skips the preset's version. User's `ToolResultCache`, `ContextCompression`, or `ContextNavigation` (v2) wins.

**Q: Why a config object instead of a class?**

In v1, only string shorthands are accepted — no imports needed, zero ceremony. In v2, config objects and class instances (`ContextManager`) are also accepted for power users who need lifecycle hooks, direct storage access, or testability — matching the `model` pattern. In v1 the Agent resolves config directly into plugins/tools; in v2 it resolves to a `ContextManager` instance that owns token estimation, budget, and cursors.

**Q: What if models don't effectively use context management tools?**

That's why `"agentic"` is experimental. `"auto"` ships first with proven framework-driven behavior.

**Q: Can users stay on `conversationManager` in v2?**

Yes, with a deprecation warning. It still works — `contextManager` takes precedence if both are set. Removal happens in v3.

**Q: How does Memory relate to context management?**

Memory is a separate primitive (`memoryManager` parameter) with its own mode and storage — out of scope for this doc, covered by Thomas's Memory primitive design. `contextManager` owns L0 ↔ L1 (within-session); `memoryManager` owns L1 → L2 (cross-session knowledge extraction). The Agent brokers the connection — `memoryManager` gets read access to `contextManager`'s L1 for extraction. Users configure each independently.

---

<details>
<summary><b>Appendix A: Code Examples</b></summary>

### v1 — Auto, minimal

```typescript
import { Agent } from "@strands-agents/sdk";

const agent = new Agent({
  contextManager: "auto",
  tools: [shell, fileRead],
});
```

```python
from strands import Agent

agent = Agent(model=model, context_manager="auto", tools=[shell, file_read])
```

### v1 — Auto, with user's conversation manager

```typescript
import { Agent } from "@strands-agents/sdk";

const agent = new Agent({
  contextManager: "auto",
  conversationManager: new SummarizingConversationManager(),
  tools: [shell, fileRead],
});
```

```python
from strands import Agent
from strands.agent.conversation_manager import SummarizingConversationManager

agent = Agent(model=model, context_manager="auto", conversation_manager=SummarizingConversationManager(), tools=[shell, file_read])
```

### v2 — Default (no configuration needed)

```typescript
import { Agent } from "@strands-agents/sdk";

const agent = new Agent({
  tools: [shell, fileRead],
});
// Context management on by default. SandboxStorage, auto strategy.
```

### v2 — Custom storage

```typescript
import { Agent } from "@strands-agents/sdk";
import { S3Storage } from "@strands-agents/storage-s3";

const agent = new Agent({
  contextManager: {
    storage: new S3Storage({ bucket: "my-session" }),
    strategy: "auto",
    compression: { threshold: 0.8, protectedMessages: 2 },
  },
  tools: [shell, fileRead],
});
```

### v2 — Agentic

```typescript
import { Agent } from "@strands-agents/sdk";

const agent = new Agent({
  contextManager: "agentic",
  tools: [shell, fileRead],
});
// ContextCompression + ContextNavigation + ContextDelegation active.
// Agent controls its own L0: compress, pin, search L1 history.
```

### v2 — Class instance (power user)

```typescript
import { Agent, ContextManager } from "@strands-agents/sdk";
import { S3Storage } from "@strands-agents/storage-s3";

const cm = new ContextManager({
  storage: new S3Storage({ bucket: "my-session" }),
  strategy: "agentic",
});

const agent = new Agent({
  contextManager: cm,
  tools: [shell, fileRead],
});

// Direct access to storage (e.g., for Memory integration or testing)
cm.storage; // S3Storage instance
await cm.dispose(); // Cleanup when done
```

### v2 — Opt out

```typescript
import { Agent } from "@strands-agents/sdk";

const agent = new Agent({
  contextManager: false,
  tools: [shell, fileRead],
});
```

### v2 — Migration from conversationManager

```typescript
// Before (v1 — still works with deprecation warning in v2)
const agent = new Agent({
  conversationManager: new SummarizingConversationManager(),
});

// After (v2 — migrated)
const agent = new Agent({
  contextManager: { compression: { strategy: "summarize" } },
});
```

</details>

---

<details>
<summary><b>Appendix B: Alternatives Considered</b></summary>

### Class-only primitive (no config object path)

```typescript
new Agent({
  contextManager: new ContextManager({
    storage: new S3Storage(...),
    strategy: "agentic",
  }),
});
```

**Why rejected as the only path:** Forces an import and instantiation even for the common case. String shorthands (`"auto"`) are simpler. However, class instances ARE accepted as a power-user path — the design supports both (see "Config object or class instance" above).

### Presets as separate Plugin classes

```typescript
new Agent({ plugins: [new AutoContextManager()] });
```

**Why rejected:** Lower discoverability. A constructor parameter is easier to find than a plugin import.

### Factory static methods

```typescript
Agent.withAutoContext({ tools: [...] });
```

**Why rejected:** Must expose full constructor parameter set. Suggests "different kind of Agent."

### Single unified plugin

```typescript
new Agent({
  plugins: [new ContextManager({ mode: "agentic", ... })],
});
```

**Why rejected:**
- God object trajectory as capabilities grow
- Can't ship plugins independently
- Preset hides the decomposition anyway

### Single monolithic class (no plugin decomposition)

```typescript
new Agent({
  contextManager: new ContextManager({ strategy: "summarize", ... }),
});
// Where ContextManager owns compression, caching, navigation, delegation — everything in one class
```

**Why rejected:**
- God object — owns everything
- Fights the composable plugin architecture
- Limits future additions

Note: We adopted the `ContextManager` name but with a different architecture — it's a thin config resolver that composes separate plugins, not a monolith.

</details>

---

<details>
<summary><b>Appendix C: Composition Edge Cases</b></summary>

### v1: User provides both preset and conversationManager

```typescript
new Agent({
  contextManager: "auto",
  conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
});
```

**Behavior:** User's conversation manager is used. `ContextOffloader` still handles tool result caching. No conflict.

### v2: User provides both (deprecated)

```typescript
new Agent({
  contextManager: "agentic",
  conversationManager: new SummarizingConversationManager(),
});
```

**Behavior:** `contextManager` takes precedence. Deprecation warning emitted.

### v2: User provides overlapping ContextCompression

```typescript
new Agent({
  contextManager: "agentic",
  plugins: [new ContextCompression({ storage: new S3Storage(...) })],
});
```

**Behavior:** User's `ContextCompression` wins (dedup). Preset's `ContextNavigation` still registers.

</details>

---

<details>
<summary><b>Appendix D: Plugin & Strategy Details</b></summary>

### `ContextManagerConfig`

```typescript
// On AgentConfig (inline union, no separate type alias — matches model pattern)
interface AgentConfig {
  contextManager?: "auto" | "agentic" | ContextManagerConfig | ContextManager | false;
}

interface ContextManagerConfig {
  storage?: Storage;                             // default: SandboxStorage
  strategy?: "auto" | "agentic";                // default: "auto"
  tokenCountingStrategy?: "auto" | "heuristic"; // default: "auto"

  // ToolResultCache plugin config
  toolResultCache?: {
    threshold?: number;                          // token count above which results are cached (TBD)
    maxAge?: number;                             // auto-eviction time in ms (TBD)
  } | false;

  // ContextCompression plugin config
  compression?: {
    threshold?: number;                          // ratio of context window (0–1]; default: 0.7
    strategy?: "truncate" | "summarize" | CompressionFn;  // default: "summarize"
    protectedMessages?: number;                  // default: 1
  } | false;

  // ContextNavigation plugin config (agentic only)
  navigation?: {
    searchStrategy?: "keyword" | "semantic";     // default: TBD
  } | false;

  // ContextDelegation plugin config (agentic only)
  delegation?: {
    maxChildContextRatio?: number;               // ratio of parent context to share (TBD)
  } | false;
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `storage` | `SandboxStorage` | Backs L1. Messages batch-written before each summarization (one file per batch). Shared across plugins. |
| `strategy` | `"auto"` | Who controls L0: framework (`"auto"`) or agent (`"agentic"`) |
| `tokenCountingStrategy` | `"auto"` | Token estimation strategy owned by `ContextManager`. `"auto"` uses native provider API with heuristic fallback; `"heuristic"` always estimates. Plugins read token counts from `ContextManager`. |
| `toolResultCache` | enabled | `ToolResultCache` plugin config. Set to `false` to disable. |
| `toolResultCache.threshold` | TBD | Token count above which tool results are cached |
| `toolResultCache.maxAge` | TBD | Auto-eviction time for cached tool results |
| `compression` | enabled | `ContextCompression` plugin config. Set to `false` to disable. |
| `compression.threshold` | `0.7` | Ratio of context window (0–1] that triggers compression. If L1 has a consumer, messages are batch-written before compression. |
| `compression.strategy` | `"summarize"` | What replaces evicted messages in L0: `"summarize"` (condensed block), `"truncate"` (removed entirely), or a custom `CompressionFn` |
| `compression.protectedMessages` | `1` | Initial messages pinned in L0 (never evicted) |
| `navigation` | enabled (agentic) | `ContextNavigation` plugin config. Set to `false` to disable. Ignored in `"auto"`. |
| `delegation` | enabled (agentic) | `ContextDelegation` plugin config. Set to `false` to disable. Ignored in `"auto"`. |

### What the strategy resolves to

```typescript
// Storage is configured at the ContextManager level and passed to plugins

"auto" → [
  new ToolResultCache({ ... }),
  new ContextCompression({ storage, ... }),
]

"agentic" → [
  new ToolResultCache({ ... }),
  new ContextCompression({ storage, ... }),
  new ContextNavigation({ storage }),
  new ContextDelegation({ storage }),
]
```

### How it grows

```
New L1 capability           → lives in ContextCompression (writes) or ContextNavigation (reads)
New tool result behavior            → lives in ToolResultCache
New compression strategy/heuristic  → lives in ContextCompression
New agentic browsing tool           → lives in ContextNavigation
New delegation capability           → lives in ContextDelegation
New config knob                     → gets a sensible default, preset users never see it
New plugin entirely                 → preset composes it automatically
```

### Compression strategies

| Strategy | What stays in L0 |
|----------|------------------|
| `"truncate"` | Oldest messages dropped (sliding window, skip protected) |
| `"summarize"` | Summary replaces evicted messages |

### conversationManager migration

| `conversationManager` (today) | `contextManager` equivalent |
|-------------------------------|-------------------------------|
| `new SlidingWindowConversationManager()` | `{ compression: { strategy: "truncate" } }` |
| `new SummarizingConversationManager()` | `{ compression: { strategy: "summarize" } }` |
| `NullConversationManager` | `false` |
| Custom subclass | `{ compression: { strategy: customFn } }` |

### Type resolution (in Agent constructor)

```typescript
if (typeof contextManager === "string")              → new ContextManager({ strategy: contextManager })
if (contextManager instanceof ContextManager)        → use directly
if (typeof contextManager === "object")              → new ContextManager(contextManager)
if (contextManager === false)                        → null (disabled)
```

</details>

---

<details>
<summary><b>Appendix E: L1 Storage Model</b></summary>

> **Note:** This is an implementation detail and subject to change. The external behavior (append-only L1, cursor-scoped reads) is stable; the physical storage layout is not.

### Physical storage

When L1 has a consumer (agentic mode or `memoryManager`), messages are batch-written to L1 before each summarization. Each batch is a single file containing the full `messages` array at that point. Each message carries a **turn ID** in metadata — a monotonically increasing identifier assigned per agent turn. In auto mode without `memoryManager`, no L1 writes occur.

```
storage/
  batch-001.json   # messages from turns 1–25 (written before first summarization)
  batch-002.json   # messages from turns 26–50 (written before second summarization)
  ...
```

Messages are written once. Each batch contains only new messages since the previous batch.

### Cursors

A **cursor** is a start pointer into the flat log — a turn ID. Everything from that turn forward is the agent's visible L1.

Cursors are stored in:
- **Agent state** (in-memory) — fast access during the session
- **Session metadata** (persisted) — survives crashes and session resumption

### Relationship to snapshots

Snapshots already exist in the SDK (`SessionManager`) and continue to work as-is — full copies of the messages array at a point in time. In addition to snapshots, the cursor is stored alongside as session metadata. Snapshots handle session persistence/resumption; cursors handle the L1 visibility window. They coexist independently.

### Archival

For long-running agents, the start cursor can be moved forward. Messages before the cursor are **archived** — still physically present in L1, but invisible to `searchHistory` and `getHistory`. Memory can still read the full log (ignores cursors).

This provides a "sliding window" over L1 without deleting anything:

```
[archived | ← start cursor → | visible to agent ]
[turn 1–50 |                  | turn 51–200      ]
```

### Read behavior

- **`getHistory`** — returns messages from the start cursor forward. Supports pagination.
- **`searchHistory`** — keyword search from the start cursor forward. Archived messages are not searched.
- **`memoryManager`** — reads the full log (ignores cursors) for L1 → L2 extraction.

### Deletion (escape hatch)

`ContextManager` exposes a `deleteMessages(turnIds)` method that physically removes specific messages from L1 by turn ID. Only archived messages (behind the start cursor) can be deleted — visible messages cannot. Use cases: privacy/compliance (user requests data deletion), storage reclamation for long-running agents after memory has extracted what it needs.

```typescript
await agent.contextManager.deleteMessages(["turn_12", "turn_13", "turn_14"]);
```

</details>

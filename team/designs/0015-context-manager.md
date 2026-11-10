# Design: ContextManager Class

**Status**: Proposed  
**Date**: 2026-06-09 (updated 2026-07-01)  
**Scope**: TypeScript + Python SDK  
**Related**: [Context Strategy Design (v1 facade)](https://github.com/strands-agents/docs/pull/831), [MemoryManager Design](https://github.com/strands-agents/docs/pull/844)

> **Note**: API shapes in this document are drafted for illustration purposes and are likely to change through bar raising and review.

---

## 1. Problem

### What customers hit

**"My coding agent forgets what it just read."** A coding agent reads 5 files, makes edits, then needs to reference the first file again. But it was summarized away 3 tool calls ago: the original content is gone. The agent has to re-read the file, burning a tool call and tokens. This happens every few turns in long sessions.

**"I can't tell why my agent stalled for 10 seconds."** In production, context compression fires silently. The stream goes quiet. No event, no log, no metric. Users file bugs thinking the model hung. Oncall can't distinguish "compressing" from "stuck." ([#1511](https://github.com/strands-agents/harness-sdk/issues/1511), [#2804](https://github.com/strands-agents/harness-sdk/issues/2804), [#617](https://github.com/strands-agents/harness-sdk/issues/617))

**"I just want to change one number."** A user wants `previewTokens: 500` instead of `750`. To get there, they must abandon `"auto"` and manually reconstruct both `SummarizingConversationManager` and `ContextOffloader` with all their defaults restated. One knob: 15 lines of boilerplate.

**"My long-running agent doesn't know what's important."** A research agent accumulates 200K tokens over 50 tool calls. Static rules compress oldest-first. But the agent *knows* which results matter: it just can't say so. It watches relevant context get evicted while stale error messages stick around.

**"Offloading helps exploration but hurts focused tasks."** ContextBench shows offloading gives 4-6x improvement on exploration-heavy tasks (85 cycles, many files) but *regresses* to 0.4-0.85x on focused tasks (single-file answer). The offloader can't distinguish "source code the agent is actively reasoning about" from "directory listing noise." There's no way to say "offload command output but leave file reads alone." ([#556](https://github.com/strands-agents/harness-sdk/issues/556))

**"I need to offload specific tool results, not all of them."** A team building a multi-tool agent needs to aggressively truncate `bash` and `list_files` results (high-volume noise) while preserving `read_file` results intact (source code the agent is actively editing). The SDK offers no per-tool targeting, so they built a custom `SelectiveContextOffloader` wrapper that inspects tool names and applies different compression per tool. This should be a one-liner, not a custom class. ([#3267](https://github.com/strands-agents/harness-sdk/pull/3267), [internal ref 1])

**"Retrieving offloaded content re-creates the overflow."** The same team disabled their retrieval tool entirely because it "returns the whole stored block at once, re-creating the overflow loop for a >window-sized result." The offloader saves context, but the tool to get it back blows context right back up, defeating the purpose for the large payloads that most need offloading. They fell back to bounded shell commands (`cat`/`grep`/`sed`/`tail`). Retrieval must be paginated. ([internal ref 2])

**"I want to use Headroom but I can't plug it in."** A team evaluates a third-party context compressor that produces better summaries than the built-in one. There's no way to swap just the compression method: `"auto"` is a sealed box. They'd have to fork the SDK internals or abandon managed context entirely and build their own orchestration around the 3P API.

**"After session restore, my offloaded content is gone."** A user resumes a session. The agent's stash (offloaded tool results) wasn't persisted with the session. The agent has preview stubs pointing to content that no longer exists. It hallucinates answers instead of admitting it can't retrieve the original. 
### Why now

Every story above is hitting customers *today*: in issues, in community reports, in benchmark regressions. Internal teams are building custom wrappers to work around limitations that should be solved at the SDK level.

The switch exists (`contextManager: "auto"`), but the experience behind it isn't good enough. Users hit the stories above and the only escape hatch is to drop down into three disconnected components (`SummarizingConversationManager`, `ContextOffloader`, `ContextInjector`) that were designed independently, don't share state, and don't compose. We should be able to make `"auto"` genuinely great: truncation, summarization, stash, retrieval, all tuned and composable. One line that keeps getting better. And when users do need to customize, one axis at a time without restating everything else.

Context strategies will change as the field changes. New models ship with different window sizes, caching behaviors, and pricing structures. New compression techniques emerge (semantic pruning, learned summarization, hybrid approaches). A framework that hardcodes its strategy into three tangled components can't keep up. A composable strategy interface means we ship new strategies, our defaults get better, and every user benefits without changing a line. The community contributes strategies too: Headroom, LLMLingua, domain-specific compressors slot in as packages, not forks. The architecture becomes a surface for the ecosystem to build on, not just for us to maintain. A strategy is just "what to compress, how, and when." Anything that answers those three questions slots in. We don't have to anticipate every future technique or how the ecosystem will change.

This layout also unblocks rapid experimentation on context strategies, which is a potential differentiator for the SDK. Context management is the single highest-leverage factor in long-running agent quality: the difference between 74% and 89% task coverage isn't incremental, it's the difference between an agent that forgets what it's doing and one that doesn't. [ContextBench results](https://github.com/lizradway/notebook/blob/main/sessions/2026-07-15/head-tail-vs-pc085/ONE-PAGER.md) already show head-tail truncation with `skip_recent=5` achieving that 89% at 15-30% lower token cost. Today, each experiment like this requires a full rearchitecture of the compression path. With a composable strategy interface, testing a new approach is a config change, not a rewrite. The faster we can iterate on strategies, the faster we pull ahead of frameworks that treat context as a fixed-size sliding window.

### Success Criteria

1. **One-liner preserved**: `contextManager: "auto"` still works, same defaults. 80% of users never see the class.
2. **No cliff**: override one axis (threshold, method, storage, content-type rules) without restating everything else.
3. **Pluggable**: 3P compressors (Headroom, enterprise) slot in with ~15 lines. No adapter layer.
4. **One mental model**: compression, injection, and protection are one system with declarative strategies evaluated before each model call.
5. **Recoverable**: L1 stores every message on arrival. Offload compresses L0 but never destroys originals. The agent retrieves on demand.
6. **Agent autonomy**: the agent pins, offloads, and searches its own context. Static rules are a safety net, not the only path.
7. **Observable**: stream events, OTEL spans, lifecycle hooks. Operators know when compression fires and what it freed.
8. **Session-durable**: stash content persists with the session and survives restore.

---

## 2. Core Model

The ContextManager operates across two layers: **L0** (the context window — `agent.messages`) and **L1** (the stash — a durable message store). Every message is written to L1 immediately on arrival. L1 is the source of truth; L0 is a compressed working set derived from it.

The ContextManager does two things:

1. **Offload**: compress content in L0 (the original always remains in L1)
2. **Inject**: put content IN to what the model sees (→ L0)

Both follow the same mental model: **choose a representation for content in the context window**. Offload replaces expensive representations with cheaper ones (the original is never lost — it's in L1). Inject adds cheaper representations of external content. The API shape is unified:

```
{Direction}.{representation}({target/source}, {options?})
```

### 2.1 Strategy API

Strategies declare **what** to transform and **under what conditions** — never *when*. The engine evaluates all strategies once before each model call.

```typescript
import { ContextManager, Offload, Inject } from '@strands-agents/sdk'

new ContextManager({
  strategies: [
    // Offload: compress L0 representations (originals always in L1)
    Offload.truncate("toolResults", { previewTokens: 750 })
      .when({ threshold: 1500, skipRecent: 3 }),
    Offload.truncate(["bash", "list_files"], { previewTokens: 200 })
      .when({ threshold: 500 }),
    Offload.summarize({ ratio: 0.3 })
      .when({ utilization: 0.85 }),
    Offload("toolResultErrors"),                    // drop from L0 entirely (still in L1)

    // Inject: fires before each model call
    Inject.skeleton("stash"),                       // stash manifest as refs/metadata
    Inject("clock"),                                // bare call = inject as-is (no transformation)
    Inject("budget"),
  ],
})
```

### 2.2 Representations

A representation is how content is mutated to appear in the context window. Representations work in both directions:

| Representation | What it produces | Offload use | Inject use |
|----------------|-----------------|-------------|------------|
| `truncate` | Partial content (head/tail/head-tail) | Keep a preview, stash the full thing | Inject a truncated view of external content |
| `summarize` | LLM-generated summary | Condense old conversation | Inject a summary of external content |
| `skeleton` | Structural outline (signatures, refs) | Code: just signatures | Stash: just refs + metadata |

Truncation modes:
- `"head"`: keep the first N tokens
- `"tail"`: keep the last N tokens
- `"head-tail"` (default): keep both ends, drop the middle

Summarization modes:
- `"cache-aligned"` (default): reuses the warm prompt cache rather than re-ingesting at full uncached cost
- `"coding"`: vended prompt that preserves file paths, function signatures, error messages, decisions
- `"research"`: vended prompt that preserves sources, claims, evidence, contradictions
- custom string: pass a full prompt for domain-specific summarization; see **Appendix D**

Skeleton modes (P2):
- `"signatures"` (default): keeps function signatures, class names, imports
- `"outline"`: keeps structural hierarchy (headings, keys, top-level declarations)

See **Appendix D** for additional representations for the future.

### 2.3 Offload Targets (content types)

The target (first arg to `Offload.*`) is `string | string[]` and describes **what** to offload:

| Target | Matches |
|--------|---------|
| `"toolResults"` | All successful tool result messages |
| `"toolResultErrors"` | All failed tool result messages |
| `"assistantMessages"` | Assistant messages (text responses) |
| `"userMessages"` | User messages (no tool result) |
| `"images"` | Messages containing image blocks |
| `"documents"` | Messages containing document blocks |
| `"code"` | Messages heuristically detected as code |
| `["bash", "list_files"]` | Tool results from these specific tools only |
| `["!read_file"]` | Tool results from all tools *except* `read_file` |
| _(omitted)_ | Everything not matched by a more specific strategy |

Passing an array of tool names implicitly scopes to tool results from those tools. Prefix a name with `!` to exclude: `["!read_file", "!write_file"]` means "all tool results except these." Don't mix includes and excludes in the same array.

```typescript
// Aggressive truncation on noisy tools
Offload.truncate(["bash", "list_files"], { previewTokens: 200 })
  .when({ threshold: 500 })

// Offload everything except the tools the agent is actively using
Offload.truncate(["!read_file", "!write_file"], { previewTokens: 750 })
  .when({ threshold: 1500 })
```

Omit the target to create a catch-all fallback. Multiple strategies can match the same message: they compose, not compete.

### 2.4 Inject Sources

What sources `Inject` can pull from, limited to what the ContextManager **owns**:

| Source | What it provides | Typical representation |
|--------|-----------------|----------------------|
| `"stash"` | Offloaded content manifest (see §3) | `skeleton`: refs + metadata |
| `"budget"` | Token utilization stats | bare: as-is |
| `"clock"` | Current datetime | bare: as-is |
| custom | User-defined render function | any |

**What about memory, RAG, state?** Those are injected by their own subsystems (MemoryManager, retriever plugins, etc.), not by the ContextManager. Each subsystem owns its own injection lifecycle.

See **Appendix D** for future condition fields and events that may extend inject sources.

### 2.5 Triggers (`.when()`)

**Offload** strategies use `.when(conditions?)` to declare *under what conditions* they fire. The engine evaluates all strategies once before each model call — there is no event param. The model is the only consumer of L0, so that's the only decision point that matters.

```typescript
// Only fire when a tool result exceeds 1500 tokens (skip 3 most recent)
Offload.truncate("toolResults", { previewTokens: 750 })
  .when({ threshold: 1500, skipRecent: 3 })

Offload("toolResultErrors")  // no .when() needed: always drop errors from L0

// Only fire when context utilization exceeds 85%
Offload.summarize({ ratio: 0.3 })
  .when({ utilization: 0.85 })
```

**Inject** strategies also fire before each model call: no `.when()` needed. They are ephemeral (stripped and re-injected fresh each time).

**Overflow handling**: if a model call returns `ContextWindowOverflowError`, the engine re-runs all offload strategies with conditions relaxed (ignoring `utilization` and `skipRecent` thresholds) to free enough space, then retries.

**Condition fields** (arg to `.when()`, optional):

| Condition | Type | Meaning |
|-----------|------|---------|
| `threshold` | `number` (absolute tokens) | Only fire if the target message exceeds this size |
| `utilization` | `number` (0-1 ratio) | Only fire if global context utilization exceeds this. Use `1.0` to mean "only on overflow" (reactive-only: strategy is skipped during proactive passes but fires when `ContextWindowOverflowError` triggers emergency compression). |
| `skipRecent` | `number` | Skip the N most recent messages of this type |

Omitting conditions means the strategy fires every time the event occurs for a matching target.

Messages with `metadata.custom.pinned = true` (from PR #2644) are never candidates for offload regardless of which strategy fires. The system prompt is always implicitly pinned.

All of these extension points (lifecycle events, strategies, representations, conditions) are open: 3P packages and users can register custom instances of each. The built-in set is a starting point, not a ceiling.

### 2.6 Bare calls

When `Offload` or `Inject` is called without a representation method:

- **`Offload("toolResults")`**: drop from L0 entirely. Nothing remains in the context window. (The original is always in L1.)
- **`Inject("clock")`**: inject the source as-is with no transformation.

The full offload spectrum:

| Call | L0 result | L1 |
|------|-----------|-----------|
| `Offload.truncate(target)` | Preview (head/tail) | Full original (always) |
| `Offload.summarize(target)` | LLM summary | Full original (always) |
| `Offload(target)` | Nothing | Full original (always) |

Since L1 writes happen on message arrival (not on offload), the original is always recoverable via the stash manifest and `get_context` (which returns bounded pages, not the full block; see §3 and §5.3).

---

## 3. The Stash (L1)

The stash is a durable message store that the ContextManager owns. **Every message is written to L1 immediately on arrival** — not on offload. L1 is the source of truth for the full, unmodified conversation. L0 (`agent.messages`) is a compressed working set derived from it.

```
message arrives: write to L1 immediately
before model call: engine evaluates strategies, compresses L0, injects context
```

The stash manifest (injected via `Inject.skeleton("stash")`) tells the agent what content exists beyond what's in L0:

```xml
<stash count="3" budget="82%">
  <entry ref="msg-a1b2c3d4" type="tool_result" tool="read_file" tokens="2400" age="4 turns" />
  <entry ref="msg-e5f6g7h8" type="tool_result" tool="fetch" tokens="1800" age="7 turns" />
  <entry ref="msg-i9j0k1l2" type="tool_result" tool="bash" tokens="900" age="12 turns" />
</stash>
```

The agent sees what's available and can retrieve full content on demand via `get_context` / `search_context` tools. This two-step pattern avoids speculative tool calls.

**Key paths** (mirrors the session snapshot layout for lifecycle cleanup, per-agent isolation, and cross-agent discoverability):

| Key pattern | Contents |
|-------------|----------|
| `context/<sessionId>/scopes/<scope>/<scopeId>/<tracking_id>` | Full original message content |
| `context/<sessionId>/scopes/<scope>/<scopeId>/_manifest` | Stash index (entry metadata, token counts, ages) |

Where `<scope>` is `agent` or `multiAgent` and `<scopeId>` is the agent's ID. This gives us:
- **Lifecycle cleanup**: deleting a session cleans up all associated L1 content
- **Per-agent isolation**: two agents sharing storage + session don't pollute each other
- **Cross-agent discoverability**: an orchestrator can `list("context/<sessionId>/scopes/agent/<peerId>/")` to browse a peer agent's stored content

**Message refs** use the durable `tracking_id` UUID on each Message ([PR #2836](https://github.com/strands-agents/harness-sdk/pull/2836)). This ID survives snapshot/restore and never shifts when messages are compressed in L0.

### 3.1 Enabling/disabling

- **Default**: enabled when any offload strategy is configured.
- **`stash: false`**: disable (messages are not written to L1; offload strategies fire destructively, same as today's behavior). Only valid for ephemeral sessions.
- **`stash: { maxEntries: 50 }`**: enable with a cap on manifest entries

When `stash: false` is set and a session manager is configured, emit a warning: session restore will have no backing content for compressed previews.

### 3.2 Eviction (P2)

The stash is not an audit log: it's mutable. Once content is removed from L1, it's gone unless something else recorded it first (e.g., an OpenContext adapter emitting Snapshots).

For v1, L1 grows until the session ends or storage is cleaned up externally. Eviction policies are a follow-up once we have data on real-world stash sizes. See §7 (Future Work).

### 3.3 Relationship to MemoryManager

ContextManager owns L0 (context window) and L1 (stash). MemoryManager owns L2 (cross-session knowledge) and can read from L1 for memory extraction. They share the token budget but don't reference each other.

---

## 4. Developer Experience

### 4.1 Equivalent of today's SummarizingConversationManager

What users do today:
```python
agent = Agent(
    conversation_manager=SummarizingConversationManager(
        summary_ratio=0.3,
        preserve_recent_messages=10,
        proactive_compression={"compression_threshold": 0.7},
    )
)
```

Same behavior on ContextManager:
```python
agent = Agent(
    context_manager=ContextManager(
        strategies=[
            Offload.summarize(ratio=0.3, preserve_recent=10)
                .when(utilization=0.7),
        ],
        stash=False,  # no stash: destructive, same as today (no storage needed)
    )
)
```

Setting `stash=False` makes offloading destructive (originals lost after summarization), matching today's behavior. No `storage` param is needed since there's nothing to persist.

### 4.2 Recreating "auto"

```python
agent = Agent(context_manager="auto")
```

Resolves to:
```python
ContextManager(
    strategies=[
        Offload.truncate("toolResults", preview_tokens=750)
            .when(threshold=1500, skip_recent=3),
        Offload.summarize(ratio=0.3)
            .when(utilization=0.85),
        Inject.skeleton("stash"),
    ],
)
# + read-only tools: get_context, search_context
```

Key differences from today's `SummarizingConversationManager`:
- Tool results are truncated individually (not summarized as a block)
- Originals are stashed and retrievable via `get_context`
- The agent sees a stash manifest so it knows what's available
- Content-type aware: tool results vs. conversation get different treatment

### 4.3 Custom: optimal for a coding agent (hypothesized)

> **Note**: [ContextBench results](https://github.com/lizradway/notebook/blob/main/sessions/2026-07-15/head-tail-vs-pc085/ONE-PAGER.md) show head-tail truncation with `skip_recent=5` achieving 89% mean coverage vs 74% for the current `"auto"` baseline, at 15-30% lower token cost (Opus 4.6, hard suite, n=1 per task). This config builds on that foundation with additional strategies.

```python
agent = Agent(
    context_manager=ContextManager(
        storage=storage,
        strategies=[
            # Aggressively truncate noisy tools: just keep first/last lines
            Offload.truncate(["bash", "list_files", "grep"], preview_tokens=200)
                .when(threshold=500),

            # Keep read_file results longer, truncate only when large
            Offload.truncate(["!bash", "!list_files", "!grep"], preview_tokens=750)
                .when(threshold=2000, skip_recent=5),

            # Evict error results entirely (stash them but no L0 presence)
            Offload("toolResultErrors"),

            # Summarize conversation when utilization gets high
            Offload.summarize(ratio=0.3)
                .when(utilization=0.8),

            # Inject stash manifest + budget so agent can self-manage
            Inject.skeleton("stash"),
            Inject("budget"),
        ],
    )
)
```

This gives a coding agent:
- Bounded noise from shell commands (200 token preview)
- Longer retention of source code it's actively reading (5 most recent kept intact)
- Error results cleaned up immediately (but recoverable from stash)
- Proactive summarization of older conversation at 80% utilization
- Awareness of its own context budget and what's in the stash

See **Appendix A** for full examples including 3P strategies, custom strategies, and TypeScript equivalents.

---

## 5. ContextManager Class

### 5.1 Constructor

```typescript
export class ContextManager implements Plugin {
  readonly name = 'strands:context-manager'

  constructor(config: {
    storage?: Storage                 // falls back to Agent's storage, then in-memory
    strategies?: Strategy[]           // offload + inject strategies
    stash?: false | {                 // false = disable stash (destructive offload, no storage needed)
      maxEntries?: number
    }
  })
}
```

### 5.2 Modes

The `contextManager` parameter accepts a string preset or a `ContextManager` instance:

```typescript
const agent = new Agent({ contextManager: "auto" })
const agent = new Agent({ contextManager: "minimal" })
const agent = new Agent({ contextManager: new ContextManager({ ... }) })
```

| Mode | Strategy behavior | Best for |
|------|-------------------|----------|
| `"auto"` | Balanced: truncate tool results, summarize at 85% utilization | Most use cases: chat, Q&A, single-tool agents |
| `"minimal"` | Reactive only: compress on overflow | Short tasks, small context |

Future mode presets are planned for P2 (see §7.2).


See §4.2 for what `"auto"` resolves to. See §4.3 for a full custom example.

### 5.3 Agent Tools (via `.as_tool()`)

Whether the agent gets context management tools is orthogonal to the mode: it's determined by `tools=[]`, not by the ContextManager config. This follows the [`.as_tool()` design](https://gist.github.com/lizradway/82dea3e7832c2d336595d77a8f9e42f1): plugins own lifecycle, tools are always explicit.

```python
# Rules only: no agent tools (most users)
agent = Agent(context_manager=ContextManager("auto"))

# Agent manages its own context: explicit opt-in
cm = ContextManager("auto")
agent = Agent(context_manager=cm, tools=[cm.as_tool()])
```

**What `.as_tool()` exposes:**
- **`offload_context`**: compress content (truncate, summarize, skeleton). Stashes original.
- **`get_context`**: retrieve full content of a stashed entry (bounded, paginated).
- **`search_context`**: search across the context window and stash.
- **`pin_context`**: mark as never-compress.
- **`unpin_context`**: remove pin, allow normal rules to apply.
- **`context_status`**: returns budget, message inventory, stash overview.

See **Appendix H** for full tool schemas and parameters.

### 5.4 Public API on the instance

```typescript
class ContextManager {
  get budget(): TokenBudget

  // offload
  offload(refs: string[], method?: string, options?: object): Promise<void>
  pin(ref: string): void
  unpin(ref: string): void

  // stash
  get(ref: string, options?: { offset?: number, limit?: number, grep?: string }): Promise<string>
  search(options?: { query?: string, tool?: string, type?: string, scope?: string, limit?: number }): Promise<StashEntry[]>

  // inject
  inject(source: string, content: string): void
}
```

### 5.5 Token Budget

The `TokenBudget` is a read-only view the ContextManager exposes for "how full is the context window":

```typescript
type TokenBudget = {
  limit: number       // model's context window size
  used: number        // current token usage
  remaining: number   // limit - used
  ratio: number       // used / limit (0-1)
}
```

**Where the data comes from**: `limit` reads from `agent.model.context_window_limit` (already exists on the model config). `used` reads from `BeforeModelCallEvent.projected_input_tokens` (already computed by the existing proactive compression hook). The ContextManager wraps the existing infrastructure into a typed object that strategies, tools, and 3P code can consume uniformly.


---

## 6. Telemetry & Observability

Context management today is silent: compression fires, the stream goes quiet, and callers have no signal that anything happened (#1511, #2804). The ContextManager makes operations observable through two channels:

### 6.1 Stream Events

When any strategy fires, the ContextManager yields a stream event so streaming consumers get real-time feedback:

```typescript
type ContextManagementStreamEvent = {
  contextManagement: {
    phase: "started" | "completed"
    reason: "proactive" | "overflow" | "agent-requested"
    strategies: string[]           // which strategies fired (e.g., ["truncate", "summarize"])
    tokensBefore?: number
    tokensAfter?: number           // only on "completed"
    tokensFreed?: number           // only on "completed"
  }
}
```

Usage for streaming consumers:
```typescript
for await (const event of agent.stream("...")) {
  if ("contextManagement" in event) {
    if (event.contextManagement.phase === "started") {
      showSpinner("Compressing context...")
    } else {
      hideSpinner()
      log(`Freed ${event.contextManagement.tokensFreed} tokens`)
    }
  }
}
```

### 6.2 Lifecycle Events

The ContextManager fires SDK lifecycle events that other plugins can listen to:

```typescript
ContextOffloadEvent {
  reason: "proactive" | "overflow" | "agent-requested"
  strategies: Strategy[]
  tokensBefore: number
  tokensAfter: number
}

ContextInjectEvent {
  sources: string[]               // which inject sources fired (e.g., ["stash", "budget"])
  tokensInjected: number
}
```

This allows external plugins (logging, analytics, custom UX) to react to context management operations without polling.

---

## 7. Future Work

### 7.1 Roadmap (P0/P1: required for v1 ship)

**Priority definitions:**
- **P0**: Replicate existing behavior (`ContextOffloader` + `ConversationManager`) in the new class structure. Ship-blocking.
- **P1**: New capabilities that complete the ContextManager vision (stash, inject, `.as_tool()`, modes). Required for v1 but not for the initial working prototype.
- **P2**: Planned enhancements, not required for v1 ship. Built after real-world usage data.
- **P3**: Future exploration, no concrete timeline. Research territory.


| Item | Priority | Estimate | Depends on | Description |
|------|----------|----------|-----------|-------------|
| Constructor & plugin lifecycle | **P0** | 3 days | (none) | Config parsing, validation, hook registration, `InitializedEvent` wiring, `storage` resolution, `NullConversationManager` swap when `contextManager` is set, deprecation warnings for `conversationManager`/`ContextOffloader` co-use |
| Strategy execution engine | **P0** | 1.5 weeks | Constructor | BeforeModelCall evaluation pass, target matching (content types + tool name arrays + `!` exclusions), condition evaluation, multi-strategy composition on same message, idempotency, overflow retry with relaxed conditions |
| `Offload.truncate` | **P0** | 3 days | Strategy engine | All three modes (`"head"`, `"tail"`, `"head-tail"`), per-tool targeting, preview token slicing |
| `Offload.summarize` | **P0** | 4 days | Strategy engine | `"cache-aligned"` mode (default), custom prompt string support, wrap existing `ConversationManager` summarization in the strategy interface, expose `ratio`/`preserve_recent` params |
| Inject system | **P1** | 4 days | Strategy engine | Middleware that strips + re-injects before each model call. Built-in sources: `Inject.skeleton("stash")`, `Inject("budget")`, `Inject("clock")`. Custom `render` function support. |
| TokenBudget | **P1** | 2 days | Constructor | Read `model.context_window_limit` + `projected_input_tokens`, expose as typed `TokenBudget` object, wire to condition evaluation and inject render context |
| Stash (L1) | **P1** | 1.5 weeks | Strategy engine, Inject | Write-on-arrival (every message → L1 immediately), manifest generation, `get_context` tool (bounded retrieval with offset/limit/grep), `search_context` tool (unified L0+L1 search with query/tool/type/scope filters), in-memory fallback when no storage configured |
| Agentic mode (`.as_tool()`) | **P1** | 3 days | Stash, `.as_tool()` primitive | `offload_context`, `pin_context`, `unpin_context`, `context_status` per [`.as_tool()` design](https://gist.github.com/lizradway/82dea3e7832c2d336595d77a8f9e42f1). Depends on `.as_tool()` being implemented on the Plugin interface. |
| Mode presets | **P1** | 2 days | All above | `"auto"`, `"minimal"` resolution, storage passthrough from Agent config |
| Telemetry & stream events | **P1** | 1 week | Strategy engine | `contextManagement` stream event (started/completed), OTEL spans per strategy execution, `ContextOffloadEvent` and `ContextInjectEvent` lifecycle events |
| Benchmarking & threshold tuning | **P1** | 1-2 weeks | Mode presets | Run ContextBench with different configs, validate §4.3 hypotheses, tune default thresholds for `"auto"` |

**P0 estimate**: approximately 3 weeks

**Total P0/P1 estimate**: approximately 10-11 weeks

### 7.2 Future Work (P2/P3)

<details>
<summary>P2: planned but not required for v1 ship</summary>

| Item | Estimate | Depends on | Description |
|------|----------|-----------|-------------|
| Stash eviction policies | 1 week | Real-world stash size data | `"oldest-first"`, `"after-extraction"` (MemoryManager extracted to L2), `"ttl"` (N turns). Need usage data before committing to a default. |
| Inject conditions (`.when()` for inject) | 3 days | Use cases for conditional injection | Only inject budget when `utilization > 0.7`, inject stash manifest every N turns, skip when stash is empty. |
| Impact-ranked eviction | 1 week | Multiple candidates competing | Score candidates by `tokens × (1/priority)` instead of simple age. Priority from role, recency, pinning. |
| `context_status` recommendations | 3 days | Impact scoring | Pre-computed "what I would do" array ranked by tokens freed. Agent sees suggestions without mutating. |
| Summarization presets | 3 days | `Offload.summarize` | Vended `"coding"` and `"research"` prompts, `prompt_suffix` extensibility |
| `Offload.skeleton` | 2 weeks | Tree-sitter / parsing infra | Two modes: `"signatures"` (default, function signatures + class names + imports) and `"outline"` (structural hierarchy). Requires language-aware parsing. |
| Additional truncation modes | 1.5 weeks | `Offload.truncate` | `"middle"` (keep center), `"regex"` (lines matching a pattern), `"semantic"` (LLM picks relevant lines) |
| Additional conditions | 1.5 weeks | Strategy engine | `count` (max N messages of type), `cumulativeTokens` (category budget), `stale` (unreferenced for N turns), `never` (only on overflow) |
| Additional evaluation points | 3 days | Strategy engine | Post-turn evaluation (end of turn cleanup), on-eviction evaluation (when L0 eviction fires) |
| Additional offload methods | 2 weeks | Strategy engine | `"schema-only"` (keep JSON structure, drop values), `"collapse-pairs"` (tool_use + result to one line), `"deduplicate"` (merge near-duplicates) |
| Additional mode presets | 1 week | Strategy engine, benchmarking | `"accuracy"` (aggressive retention, high skip_recent, late summarization, stash + retrieval tools), `"cost"` (aggressive offloading, low thresholds, early summarization, no stash), `"long-running"` (tiered decay: recent intact, older summarized, oldest skeletonized), `"coding"` (head-tail truncation on tool results, preserve recent reads, evict errors; validated by ContextBench) |

</details>

<details>
<summary>P3: future exploration, no concrete timeline</summary>

| Item | Depends on | Description |
|------|-----------|-------------|
| Middleware projection | V1 strategy engine, InvokeModelStage middleware | Instead of modifying `agent.messages` directly, strategies produce an ephemeral projected view at BeforeModelCall via middleware. `agent.messages` becomes a bounded "warm cache" that eviction keeps small, and the middleware projects what the model sees from it. Same user-facing strategy API, different execution model under the hood. |
| L0 eviction | Middleware projection | Drop permanently irrelevant content from `agent.messages` (RAM management). Since L1 has everything, this is lossless. Runs at turn boundaries or on a memory threshold. Separate concern from per-call projection. |
| Adaptive compression | Feedback signal infrastructure | Observe agent behavior (frequent stash retrievals = too aggressive, re-asked questions = summaries too lossy) and adjust thresholds dynamically. Research territory. |
| Multi-agent context sharing | Multi-agent primitives | Child agent sees parent's stash but has its own L0. Prevents re-exploration in delegation patterns. |
| Context strategy routing | ModelRouter ([#3217](https://github.com/strands-agents/harness-sdk/pull/3217)), `.as_tool()` | Route to different context strategies based on **model** or **task**. Model-based: when routed to Haiku (small window), use aggressive truncation; when on Opus (large window), keep more context intact. Task-based: a coding task uses per-tool targeting (truncate bash, preserve read_file); a research task summarizes conversation but keeps all tool results. Same mechanism: a signal (current model, task label) selects which strategy set is active. Could be a `ContextRouter` or a strategy-level condition. |

</details>

### 7.3 Deprecation & Release Plan

1. **v1 (this design)**: `contextManager` accepts a `ContextManager` instance or mode string. When set, `ConversationManager` is disabled (`NullConversationManager`). If `conversationManager` or `ContextOffloader` are also set, emit a deprecation warning. Both paths work, no breakage. `ContextInjector` remains a separate plugin.
2. **v2**: `conversationManager` param removed. `ContextOffloader` plugin removed. `contextManager` is the only path for context offloading/compression. `ContextInjector` continues to work independently.

---

<details>
<summary><b>Appendix A: Full Developer Experience Examples</b></summary>

### Level 1: One-liner

```typescript
const agent = new Agent({ contextManager: "auto" })
```

### Level 2: Custom strategies

```typescript
import { ContextManager, Offload, Inject } from '@strands-agents/sdk'

const agent = new Agent({
  contextManager: new ContextManager({
    strategies: [
      Offload.truncate("toolResults", { previewTokens: 750 }),
      Offload.summarize({ ratio: 0.3 })
        .when({ utilization: 0.85 }),
      Inject.skeleton("stash"),
    ],
  })
})
```

### Level 3: Full control with conditions

```typescript
import { ContextManager, Offload, Inject } from '@strands-agents/sdk'

const agent = new Agent({
  contextManager: new ContextManager({
    strategies: [
      Offload.truncate("toolResults", { previewTokens: 750 })
        .when({ threshold: 1500, skipRecent: 3 }),
      Offload("toolResultErrors"),
      Offload.summarize({ ratio: 0.3 })
        .when({ utilization: 0.85 }),
      Inject.skeleton("stash"),
      Inject("clock"),
    ],
  })
})
```

### Level 4: Third-party

```typescript
import { HeadroomStrategy } from '@strands-agents/context-headroom'

const agent = new Agent({
  contextManager: new ContextManager({
    strategies: [
      Offload.truncate("toolResults", { previewTokens: 750 })
        .when({ threshold: 1500 }),
      HeadroomStrategy("assistantMessages", { apiKey: "..." })
        .when({ utilization: 0.8 }),
      Inject.skeleton("stash"),
    ],
  })
})
```

### Level 5: Custom strategy

```typescript
import { createOffloadStrategy } from '@strands-agents/sdk'

function MyCompression(target: ContentType, config: { myParam: number }): OffloadStrategy {
  return createOffloadStrategy({
    representation: "my-compression",
    target,
    compress: (messages, budget) => myCustomLogic(messages, budget, config),
  })
}

const agent = new Agent({
  contextManager: new ContextManager({
    strategies: [
      Offload.truncate("toolResults", { previewTokens: 750 }),
      MyCompression("assistantMessages", { myParam: 42 })
        .when({ utilization: 0.9 }),
      Inject.skeleton("stash"),
    ],
  })
})
```

### Level 6: Full config

```typescript
const agent = new Agent({
  contextManager: new ContextManager({
    strategies: [
      Offload.truncate("toolResults", { previewTokens: 750 })
        .when({ threshold: 1500, skipRecent: 3 }),
      Offload("toolResultErrors"),
      Offload.summarize({ ratio: 0.3 })
        .when({ utilization: 0.85 }),
      Inject.skeleton("stash"),
      Inject("clock"),
      Inject("budget"),
    ],
    stash: { maxEntries: 50 },
  })
})
```

### Python equivalents

```python
from strands import Agent, ContextManager, Offload, Inject

# Level 1
agent = Agent(context_manager="auto")

# Level 2: Custom strategies
agent = Agent(context_manager=ContextManager(
    strategies=[
        Offload.truncate("toolResults", preview_tokens=750),
        Offload.summarize(ratio=0.3)
            .when(utilization=0.85),
        Inject.skeleton("stash"),
    ],
))

# Level 3: Full control with conditions
agent = Agent(context_manager=ContextManager(
    strategies=[
        Offload.truncate("toolResults", preview_tokens=750)
            .when(threshold=1500, skip_recent=3),
        Offload("toolResultErrors"),
        Offload.summarize(ratio=0.3)
            .when(utilization=0.85),
        Inject.skeleton("stash"),
        Inject("clock"),
    ],
))

# Level 4: 3P
from strands_context_headroom import HeadroomStrategy

agent = Agent(context_manager=ContextManager(
    strategies=[
        Offload.truncate("toolResults", preview_tokens=750)
            .when(threshold=1500),
        HeadroomStrategy("assistantMessages", api_key="...")
            .when(utilization=0.8),
        Inject.skeleton("stash"),
    ],
))

# Level 5: Custom
from strands.context import create_offload_strategy

def my_compression(target, **config):
    def compress(messages, budget):
        return my_custom_logic(messages, budget, config)
    return create_offload_strategy(
        target=target, representation="my-compression",
        compress=compress,
    )

agent = Agent(context_manager=ContextManager(
    strategies=[
        Offload.truncate("toolResults", preview_tokens=750),
        my_compression("assistantMessages", my_param=42)
            .when(utilization=0.9),
        Inject.skeleton("stash"),
    ],
))
```

</details>

---

<details>
<summary><b>Appendix B: Telemetry (OTEL)</b></summary>

The ContextManager participates in the SDK's existing OTEL instrumentation (no per-component flag needed). Spans and metrics are emitted when the SDK's observability is enabled.

### Spans

```
strands.context_manager
├── strands.context.offload
│   ├── attribute: tokens_before
│   ├── attribute: tokens_after
│   ├── attribute: method_used
│   ├── attribute: trigger_type
│   └── attribute: messages_affected
├── strands.context.stash_write
│   ├── attribute: message_count
│   └── attribute: total_tokens
└── strands.context.stash_retrieval
    ├── attribute: query
    └── attribute: results_count
```

### Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `strands.context.offload_count` | Counter | Times offload strategies fired |
| `strands.context.tokens_saved` | Histogram | Tokens freed per offload |
| `strands.context.utilization` | Gauge | Current context window ratio (0-1) |
| `strands.context.stash_write_count` | Counter | Messages written to stash |
| `strands.context.stash_retrieval_count` | Counter | Times agent retrieved from stash |

</details>

---

<details>
<summary><b>Appendix C: Migration Path</b></summary>

### From v1 facade (`contextManager: "auto"`)

No breaking change. `"auto"` continues to work and resolves to the ContextManager class internally:

```typescript
// v1 (current)
new Agent({ contextManager: "auto" })

// v2 (this design): same behavior, class instance under the hood
new Agent({ contextManager: "auto" })
// Resolves internally to the ContextManager instance shown in §4.2
```

### From ConversationManager

```typescript
// Before
new Agent({ conversationManager: new SummarizingConversationManager({ summaryRatio: 0.3 }) })

// After
new Agent({
  contextManager: new ContextManager({
    strategies: [
      Offload.summarize({ ratio: 0.3 }).when({ utilization: 0.85 }),
    ],
  })
})
```

### From message pinning (PR #2644)

Pin utilities (`pinMessage`, `unpinMessage`, `isPinned`) continue to work. The ContextManager reads `metadata.custom.pinned` and treats those messages as `priority: Infinity`.

`pinFirst: N` on conversation managers: use `metadata.custom.pinned = true` on messages or agent pinning tools.

### From offloader `Storage`

The existing context-offloader uses its own `Storage` interface (`store`/`retrieve`). In the new design, `Storage` is a required constructor param on `ContextManager` ([PR #3099](https://github.com/strands-agents/harness-sdk/pull/3099)). Users who configured custom offloader storage should pass their `Storage` instance to the ContextManager constructor directly.

### From ContextOffloader plugin

```typescript
// Before
new Agent({ plugins: [new ContextOffloader({ maxResultTokens: 1500, previewTokens: 750 })] })

// After
new Agent({
  contextManager: new ContextManager({
    strategies: [
      Offload.truncate("toolResults", { previewTokens: 750 })
        .when({ threshold: 1500 }),
    ],
  })
})
```

### From ContextInjector plugin

```typescript
// Before
new Agent({ plugins: [new ContextInjector({ trigger: 'everyTurn', renderContent: () => myText() })] })

// After: custom inject strategy
new Agent({
  contextManager: new ContextManager({
    strategies: [
      Inject("custom", { render: () => myText() }),
    ],
  })
})
```

### Deprecation path

See §7.3 for the v1→v2 deprecation plan.

</details>

---

<details>
<summary><b>Appendix D: Future Conditions, Events & Methods</b></summary>

### Future condition fields for `.when()`

| Condition | Type | Meaning | Complexity | Notes |
|-----------|------|---------|------------|-------|
| `count` | `number` | Fire when more than N messages of this type exist in L0 | Low | "Keep at most 5 tool results, compress the rest." Essentially `skipRecent` reframed as a positive condition. |
| `cumulativeTokens` | `number` | Fire when total tokens for this content type exceed N | Medium | Category budget: "all tool results shouldn't exceed 20K tokens." Overlaps with `utilization` but scoped to one content type. |
| `stale` | `number` (turns) | Fire when message hasn't been referenced by the model in N turns | High | Requires tracking which messages the model actually referenced. |
| `never` | `boolean` | Only fire on reactive overflow (ContextWindowOverflowException) | Low | Last-resort: leave content alone unless we literally can't fit. |

### Future evaluation points

The v1 engine evaluates all strategies once at BeforeModelCall. Future versions may add additional evaluation points:

| Evaluation point | When | Use case |
|-------|------|----------|
| Post-turn | End of `agent.invoke()` | Cleanup: summarize content that accumulated during a multi-tool loop, before the next user message |
| On-eviction | When L0 eviction fires (P3 middleware) | Compress on eviction from the working set rather than on every model call |

### Future truncation modes

| Mode | What it keeps | Use case |
|------|--------------|----------|
| `"middle"` | Drop head and tail, keep center | Grep results where relevant lines are in the middle |
| `"regex"` | Only lines matching a pattern | Extract error lines, imports, or specific markers from large output |
| `"semantic"` | LLM picks which lines are relevant | When no positional heuristic works (mixed-relevance output) |

### Future summarization options

| Option | What it does | Use case |
|--------|-------------|----------|
| Custom `prompt` | User passes their own summarization prompt | Domain-specific summarization (e.g., "preserve all file paths and function names") |
| `"coding"` preset | Vended prompt optimized for coding contexts: preserves file paths, function signatures, error messages, decisions made | Coding agents |
| `"research"` preset | Vended prompt optimized for research: preserves sources, claims, evidence, contradictions | Research/analysis agents |

Presets are keyword-selectable via `Offload.summarize(prompt="coding")` or customizable by passing a full prompt string. Users can also extend presets: `Offload.summarize(prompt="coding", prompt_suffix="Also preserve all SQL queries.")`.

### Future offload methods

| Method | L0 result | Use case |
|--------|-----------|----------|
| `"schema-only"` | JSON: keep keys/structure, drop values | Large JSON tool results where shape matters but data doesn't |
| `"collapse-pairs"` | tool_use + tool_result: one-line summary | Verbose tool loops where the action matters but details don't |
| `"deduplicate"` | Merge near-duplicate messages into one | Retry loops that produce similar results repeatedly |

</details>

---

<details>
<summary><b>Appendix E: Alternative API Shapes Considered</b></summary>

### 1. Flat rule objects (first iteration)

```typescript
new ContextManager({
  offload: [
    { content: "toolResults", trigger: { type: "immediate", threshold: 1500 }, method: "truncate" },
    { content: "assistantMessages", trigger: { type: "budget" }, method: "summarize" },
    { content: "images", trigger: { type: "age", turns: 5 }, method: "truncate" },
  ],
  inject: [
    { trigger: "everyTurn", render: () => stashManifest() },
  ],
})
```

**Rejected because**: verbose, lots of nested objects, trigger type feels like boilerplate, offload/inject are separate arrays but are conceptually both "strategies."

### 2. Content-keyed object (ContentRouter style)

```typescript
new ContextManager({
  offload: {
    toolResults: { threshold: 1500, method: "truncate", previewTokens: 750 },
    assistantMessages: { method: "summarize", ratio: 0.3 },
    images: { turns: 5, method: "truncate" },
  },
})
```

**Pros**: No repetition per content type, trigger type inferrable from fields.
**Rejected because**: Can't have two strategies for the same content type. Injection doesn't fit the shape. Hard to share a strategy across multiple content types without repeating.

### 3. Named strategy classes (`OffloadStrategy.truncate`)

```typescript
new ContextManager({
  strategies: [
    OffloadStrategy.truncate("toolResults", { threshold: 1500, previewTokens: 750 }),
    OffloadStrategy.summarize("*", { ratio: 0.3 }),
    InjectStrategy.stash({ method: "skeleton" }),
    InjectStrategy.memory({ from: memoryManager, method: "summarize" }),
    InjectStrategy.clock(),
  ],
})
```

**Pros**: Very explicit, great autocomplete.
**Rejected because**: `OffloadStrategy` is verbose on every line. Inject strategies named by source (`.stash()`, `.clock()`) while offload named by method (`.truncate()`, `.summarize()`), creating asymmetry.

### 4. Strategy carries its own content targets (variadic args)

```typescript
OffloadStrategy.truncate("toolResults", "images", "documents", { threshold: 1500, previewTokens: 750 })
OffloadStrategy.summarize("*", { ratio: 0.3 })
```

**Pros**: One strategy, many targets.
**Rejected because**: Variadic args are confusing (which strings are targets vs. config?). Doesn't solve inject asymmetry.

### 5. `.for()` builder chain

```typescript
OffloadStrategy.truncate({ threshold: 1500, previewTokens: 750 }).for("toolResults", "images")
OffloadStrategy.summarize({ ratio: 0.3 }).for("*")
```

**Pros**: Clear separation of config from target.
**Rejected because**: Builder pattern is imperative, less serializable, more verbose than the final design.

### 6. Chosen: `Offload.{representation}` / `Inject.{representation}` + `.when(conditions)`

```typescript
import { ContextManager, Offload, Inject } from '@strands-agents/sdk'

new ContextManager({
  strategies: [
    Offload.truncate("toolResults", { previewTokens: 750 })
      .when({ threshold: 1500, skipRecent: 3 }),
    Offload.summarize({ ratio: 0.3 })
      .when({ utilization: 0.85 }),
    Offload("toolResultErrors"),
    Inject.skeleton("stash"),
    Inject("clock"),
    Inject("budget"),
  ],
})
```

**Why this won**:
- Unified mental model: `{Direction}.{representation}({target/source}, {options?})`, offload adds `.when({conditions?})` for conditional firing
- Clean separation: method config (HOW to transform) vs conditions (UNDER WHAT CONDITIONS to fire). No timing decision — engine always evaluates at BeforeModelCall.
- `.when()` is optional: omit it and the strategy fires unconditionally on matching targets
- Bare calls handle trivial cases without forcing a meaningless method name
- Short (`Offload`/`Inject` not `OffloadStrategy`/`InjectStrategy`)
- Representation is the verb: same vocabulary in both directions (truncate, summarize, skeleton)
- One `strategies` array: all context management in one place
- Reads like English: "Offload, truncate toolResults, when threshold exceeded"

</details>

---

<details>
<summary><b>Appendix F: Full Interface Definitions</b></summary>

### Strategy (base)

```typescript
type Strategy = OffloadStrategy | InjectStrategy

interface OffloadStrategy {
  direction: "offload"
  representation: string                  // built-in: "truncate", "summarize", "skeleton", "full"; 3P adds their own (e.g., "headroom")
  target?: OffloadTarget                  // omit = fallback for all remaining
  options: OffloadMethodOptions
  conditions?: OffloadConditions
  when(conditions?: OffloadConditions): OffloadStrategy
}

interface InjectStrategy {
  direction: "inject"
  representation: "skeleton" | "raw"
  source: InjectSource
  options: InjectMethodOptions
  // Always fires before each model call: no .when() needed
}
```

### Offload factory

```typescript
// Target is optional: omit for fallback that applies to all remaining content
Offload.truncate(target?: OffloadTarget, options?: OffloadTruncateOptions): OffloadStrategy
Offload.summarize(target?: OffloadTarget, options?: OffloadSummarizeOptions): OffloadStrategy
Offload.skeleton(target?: OffloadTarget, options?: OffloadSkeletonOptions): OffloadStrategy

// Bare call: drop from L0 entirely (original always in L1)
Offload(target?: OffloadTarget): OffloadStrategy
```

### Inject factory

```typescript
// With representation method
Inject.skeleton(source: InjectSource, options?: InjectSkeletonOptions): InjectStrategy

// Bare call: inject as-is (no transformation)
Inject(source: InjectSource, options?: InjectMethodOptions): InjectStrategy
```

### Types

```typescript
type ContentType = "toolResults" | "toolResultErrors" | "assistantMessages"
                 | "userMessages" | "images" | "documents" | "code"

// Target can be a content type string OR an array of tool names (implicitly scopes to tool results)
// Prefix with "!" to exclude: ["!read_file"] = all tool results except read_file
type OffloadTarget = ContentType | string[]

type InjectSource = "stash" | "clock" | "budget" | string

// --- Method options (HOW to transform) ---

type OffloadTruncateOptions = {
  previewTokens?: number      // tokens to keep in preview (default 750)
  preview?: "head" | "tail" | "head-tail"   // how to slice (default "head-tail")
}

type OffloadSummarizeOptions = {
  ratio?: number              // fraction of messages to summarize (default 0.3)
  model?: Model               // model for summarization (default: agent's model)
  prompt?: string             // custom summarization prompt
  fallback?: "truncate" | "skip"  // on LLM failure: truncate the content, or skip (default "truncate")
}

type OffloadSkeletonOptions = {
  languages?: string[]        // languages for skeleton extraction
}

type InjectMethodOptions = {
  maxTokens?: number          // budget cap for this injection
  render?: (ctx: InjectionContext) => string | null  // custom render (for custom sources)
}

type InjectSkeletonOptions = InjectMethodOptions & {
  maxEntries?: number         // limit entries shown in stash manifest
}

// --- Trigger conditions (WHEN to fire, offload only) ---

type OffloadConditions = {
  threshold?: number          // absolute tokens: only fire if message exceeds this
  utilization?: number        // ratio (0-1): only fire if global context utilization exceeds this
  skipRecent?: number         // skip the N most recent messages of this type
}
```

### TokenBudget

```typescript
type TokenBudget = {
  limit: number       // model's context window
  used: number        // current token usage
  remaining: number   // limit - used
  ratio: number       // used / limit (0-1)
}
```

### OffloadMethod (what 3P implements)

Third-party strategies implement this interface and wrap it in a factory that returns a chainable `OffloadStrategy`:

```typescript
interface OffloadMethod {
  name: string
  compress(messages: Message[], budget: TokenBudget): Promise<Message[]>
}

// 3P example (~15 lines)
export function HeadroomStrategy(
  target: ContentType | ContentType[],
  config: { apiKey: string }
): OffloadStrategy {
  const client = new HeadroomClient(config)
  return createOffloadStrategy({
    representation: "headroom",
    target,
    compress: (messages, budget) => client.compress(messages, { targetTokens: budget.remaining }),
  })
}

// Usage: .when() still works on 3P strategies
HeadroomStrategy("assistantMessages", { apiKey: "..." })
  .when({ utilization: 0.8 })

HeadroomStrategy(["assistantMessages", "toolResults"], { apiKey: "..." })
```

### Custom Inject Sources (what 3P implements)

Third-party inject strategies provide content to inject into context. They use the custom source pattern with a `render` function:

```typescript
// 3P example: ponytail (coding style instructions)
import { getPonytailInstructions } from 'ponytail'

Inject("ponytail", {
  render: (ctx) => getPonytailInstructions(ctx.budget.ratio > 0.9 ? "lite" : "full"),
  maxTokens: 2000,
})
```

For a reusable package, wrap it in a factory:

```typescript
// @strands-agents/context-ponytail
import { getPonytailInstructions } from 'ponytail'

export function PonytailStrategy(config?: {
  mode?: "lite" | "full" | "ultra",
  adaptToPressure?: boolean,    // downgrade mode when context is tight
  maxTokens?: number,
}): InjectStrategy {
  const { mode = "full", adaptToPressure = true, maxTokens = 2000 } = config ?? {}
  return Inject("ponytail", {
    maxTokens,
    render: (ctx) => {
      const effectiveMode = adaptToPressure && ctx.budget.ratio > 0.9 ? "lite" : mode
      return getPonytailInstructions(effectiveMode)
    },
  })
}

// Usage
new ContextManager({
  strategies: [
    Offload.truncate("toolResults", { previewTokens: 750 }),
    Offload.summarize({ ratio: 0.3 }),
    PonytailStrategy({ mode: "full", adaptToPressure: true }),
    Inject.skeleton("stash"),
  ],
})
```

The two 3P interfaces:
- **`OffloadMethod`**: for services that compress messages out of context (Headroom, custom summarizers)
- **Custom `Inject` source**: for services that add content into context (ponytail, live data feeds, RAG providers that don't use MemoryManager)

</details>

---

<details>
<summary><b>Appendix G: context_status Response Example</b></summary>

```json
{
  "budget": { "limit": 200000, "used": 156000, "remaining": 44000, "ratio": 0.78 },
  "messages": [
    { "ref": "msg-a3f8b2c1", "role": "system", "tokens": 1200, "pinned": true },
    { "ref": "msg-b7c1d4e2", "role": "user", "tokens": 350, "age": "12 turns" },
    { "ref": "msg-e2a9f0g3", "role": "tool_result", "tool": "read_file", "tokens": 8400, "age": "8 turns" },
    { "ref": "msg-f4d3c1h4", "role": "tool_result", "tool": "bash", "tokens": 12000, "age": "2 turns" },
    { "ref": "msg-g8b2e5i5", "role": "assistant", "tokens": 900, "age": "1 turn" }
  ],
  "stash": {
    "count": 7,
    "totalTokens": 34200,
    "recent": [
      { "ref": "msg-a1b2c3d4", "type": "tool_result", "tool": "read_file", "tokens": 2400, "age": "2 turns" },
      { "ref": "msg-e5f6g7h8", "type": "tool_result", "tool": "bash", "tokens": 5100, "age": "4 turns" }
    ]
  }
}
```

The `messages` array shows all L0 messages with their refs, token counts, and ages: this is how the agent discovers what to pin or offload. The stash manifest (injected via `Inject.skeleton("stash")`) shows stashed refs for retrieval.

</details>

---

<details>
<summary><b>Appendix H: Tool Schemas</b></summary>

#### `get_context`

```typescript
get_context({
  ref: string,
  offset?: number,    // line offset (default: 0)
  limit?: number,     // max lines to return (default 200, null = full content)
  grep?: string,      // return only lines matching this pattern
})
```

Retrieval is **bounded by default** (200 lines) to prevent re-inflation. The agent can page through (`offset`), search within (`grep`), or request full content (`limit: null`) when it knows the entry is small.

#### `search_context`

```typescript
search_context({
  query?: string,       // keyword search over content
  tool?: string,        // filter by source tool name (e.g., "read_file", "bash")
  type?: string,        // filter by content type: "tool_result", "tool_result_error", "summary", "assistant", "user"
  scope?: "all" | "window" | "offloaded",  // where to search (default: "all")
  limit?: number,       // max entries to return (default 10)
})
```

Filters compose (AND): `{ tool: "bash", query: "error" }` returns only bash results containing "error." Call with no args to list recent entries across both layers.

#### `offload_context`

```typescript
offload_context({
  refs: string[],       // message refs to compress
  method?: string,      // "truncate" | "summarize" | "skeleton" (default: "truncate")
  options?: object,     // method-specific options (e.g., { previewTokens: 200 })
})
```

#### `pin_context` / `unpin_context`

```typescript
pin_context({ refs: string[] })
unpin_context({ refs: string[] })
```

#### `context_status`

No parameters. Returns budget, L0 message inventory (with refs), and stash overview. See **Appendix G** for a full response example.

</details>

---

<details>
<summary><b>Appendix I: Third-Party Integration Examples</b></summary>

The ContextManager is designed so third parties can plug in at two points: **offload methods** (compress content out of context) and **inject sources** (add content into context). Each requires ~15 lines to implement.

### Offload integrations

| Integration | What it does | Interface |
|-------------|-------------|-----------|
| **[Headroom](https://headroom.ai)** | ML-powered context compression: better summaries than naive LLM summarization, optimized for agent workloads | `OffloadMethod` |
| **[LLMLingua / LongLLMLingua](https://github.com/microsoft/LLMLingua)** | Token-level prompt compression using perplexity-based pruning (Microsoft Research) | `OffloadMethod` |

```typescript
// Headroom example (~15 lines)
import { createOffloadStrategy } from '@strands-agents/sdk'

export function HeadroomStrategy(target, config) {
  const client = new HeadroomClient(config)
  return createOffloadStrategy({
    representation: "headroom",
    target,
    compress: (messages, budget) => client.compress(messages, { targetTokens: budget.remaining }),
  })
}

// Usage
HeadroomStrategy("assistantMessages", { apiKey: "..." })
  .when({ utilization: 0.8 })
```

### Inject integrations

| Integration | What it does | Interface |
|-------------|-------------|-----------|
| **[Ponytail](https://ponytail.dev)** | Coding style instructions: adapts detail level based on context pressure | Custom `Inject` source |

```typescript
// Ponytail example
import { getPonytailInstructions } from 'ponytail'

export function PonytailStrategy(config) {
  const { mode = "full", adaptToPressure = true, maxTokens = 2000 } = config ?? {}
  return Inject("ponytail", {
    maxTokens,
    render: (ctx) => {
      const effectiveMode = adaptToPressure && ctx.budget.ratio > 0.9 ? "lite" : mode
      return getPonytailInstructions(effectiveMode)
    },
  })
}

// Usage
new ContextManager({
  strategies: [
    Offload.truncate("toolResults", { previewTokens: 750 }),
    Offload.summarize({ ratio: 0.3 }),
    PonytailStrategy({ mode: "full", adaptToPressure: true }),
    Inject.skeleton("stash"),
  ],
})
```

### Why this matters

The current SDK has no extension point for context compression or injection. Users who want Headroom, ponytail, or a custom compressor must either:
1. Fork the SDK internals
2. Abandon managed context and build their own orchestration
3. Use hooks to intercept messages pre/post model call (fragile, no composition)

With ContextManager, a 3P package exports a single function that returns a `Strategy`: it slots into the `strategies` array alongside built-in methods with full `.when()` support, token budget access, and stash integration.

</details>

---



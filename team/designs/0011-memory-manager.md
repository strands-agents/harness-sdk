# Long-Term Memory

**Status**: Proposed

**Date**: 2026-05-14

**Issue**: TBD

**Scope**: TypeScript SDK

## Context

Strands agents today are stateless across sessions. Every conversation starts from zero: the agent can't recall user preferences, past decisions, or accumulated knowledge. When information leaves the context window, it's gone unless the developer builds custom persistence. The SDK provides session management (persisting conversation state) and context management (handling context window size within a session), but neither addresses cross-session knowledge. An agent that assists a user daily should be able to remember what it learned yesterday without replaying the full history. Prototyping a memory-enabled agent today requires wiring up a vector store, writing extraction logic, managing tool registration, and handling multi-tenancy. This should be supported natively.

This design proposes a `MemoryManager` primitive that owns long-term knowledge: persisting facts to configurable backends, recalling them via tools or context injection, and optionally extracting them from conversations. The primitive solves three distinct problems:

1. **Knowledge Retrieval**: how the agent searches and surfaces stored knowledge at the right time
2. **Knowledge Extraction**: how conversation messages become structured knowledge entries and are written to stores
3. **Context Injection**: how stored knowledge is passively surfaced without agent intervention

## Decision

### Architecture

`MemoryManager` is the component that gives agents persistent knowledge across sessions. It handles storing facts, recalling them when relevant, and optionally extracting them from conversations.

It is exposed as a top-level `memoryManager` parameter on `AgentConfig`, following the pattern of `contextManager` and `sessionManager`. It accepts either a `MemoryManager` instance or a plain `MemoryManagerConfig` object (auto-wrapped):

```typescript
interface AgentConfig {
  memoryManager?: MemoryManager | MemoryManagerConfig
}
```

Under the hood, MemoryManager integrates with the agent lifecycle via hooks: registering tools at initialization, injecting knowledge before model calls, and extracting new facts after each turn.

**Stores.** A `MemoryStore` is a backend that holds and retrieves knowledge (a vector database, a managed service like Amazon Bedrock Knowledge Bases, or any implementation of the store interface). MemoryManager orchestrates one or more stores:

```typescript
const agent = new Agent({
  model,
  memoryManager: new MemoryManager({
    stores: [userStore, teamStore, orgStore],
  }),
})
```

Multi-store support avoids pushing multi-tenancy complexity onto the developer. A single agent can query personal, team, and organization knowledge simultaneously. Scoping (namespace, tenant isolation) is handled by each store's own constructor config.

One `MemoryStore` interface with `search()` required and `add()` optional. Stores carry their own configuration as instance properties (name, description, limit, extraction config). This follows the SDK pattern where instances in arrays are self-contained — no wrapper config objects.

```typescript
interface MemoryStore {
  readonly name: string
  readonly description?: string
  readonly limit?: number
  readonly extraction?: ExtractionConfig

  search(query: string, options?: SearchOptions): Promise<MemoryEntry[]>
  add?(content: string, metadata?: Record<string, JSONValue>): Promise<void>
}
```

**Shipped backends.**

| Backend | Package | Use case |
|---------|---------|----------|
| `BedrockKnowledgeBaseStore` | `@strands-agents/sdk` | Production (managed, zero-infra) |

---

### Knowledge Retrieval

The agent needs stored knowledge at the right moment, but retrieving it has a cost (latency, tokens, relevance noise). MemoryManager provides two retrieval mechanisms that offer different trade-offs between precision and reliability. Both can be used together.

#### Active Recall

Active recall lets the agent decide when memory is relevant. Instead of retrieving knowledge every turn, the agent searches on demand, only when it judges that stored knowledge would help.

This works by registering a `search_memory` tool that the agent can call like any other tool. The trade-off: active recall depends on the model recognizing when to search. If the model doesn't think to look, relevant memories stay hidden.

```typescript
const agent = new Agent({
  model,
  memoryManager: new MemoryManager({
    stores: [myStore],
    searchToolConfig: true,
  }),
})
```

When multiple stores are configured, results are concatenated in store config order. Scores are not compared across stores because different backends produce incomparable scales. If a store fails, partial results from other stores are still returned. Store names and descriptions are included in the tool description so the model can target specific stores by name when it knows which domain is relevant.

#### Context Injection

Context injection guarantees that relevant knowledge is always present, at the cost of paying for retrieval every turn. This is useful when baseline context is more important than token efficiency, or when the model can't reliably judge when to search.

Enabled via `injection: true`. Each turn, MemoryManager searches stores using the last substantive user message as the query, formats results, and injects them as a message immediately before the user's last turn. The injection target is configurable: `'message'` (default, keeps system prompt clean and prompt caching enabled) or `'systemPrompt'` (for behavioral instructions).

```typescript
const agent = new Agent({
  model,
  memoryManager: new MemoryManager({
    stores: [myStore],
    injection: true,
  }),
})
```

---

### Knowledge Extraction

Knowledge can enter the system in two ways: the agent explicitly writes it (via a `store_memory` tool), or MemoryManager automatically extracts it from conversation messages using an extractor.

#### Tool-driven writes

The `store_memory` tool is controlled by `storeToolConfig` on MemoryManagerConfig. It defaults to `false` (not registered). When enabled:

- With a single writable store: `storeToolConfig: true` auto-targets that store
- With multiple writable stores: must explicitly specify `storeToolConfig: { stores: ['personal'] }`
- Throws at construction if multiple writable stores exist without explicit targeting

#### Automatic extraction

MemoryManager uses triggers to control when automatic extraction happens. A trigger is a class instance that causes MemoryManager to process recent messages and write to the store. Three built-in triggers:

| Trigger | When | Cost |
|---------|---------------|---------------|
| `InvocationTrigger` | After every agent invocation | High (model call per turn if an extractor is configured) |
| `EvictionTrigger` | Messages are evicted from the context window | Medium (only fires on eviction events) |
| `IntervalTrigger({ turns: N })` | Every N turns | Controllable |

Triggers are configured per-store via `extraction` on the `MemoryStore` interface:

```typescript
const userStore = new BedrockKnowledgeBaseStore({
  name: 'personal',
  extraction: {
    triggers: [new InvocationTrigger()],
    extractor: new ModelExtractor({ systemPrompt: 'Extract user preferences as discrete facts.' }),
  },
})
```

All writes are async and non-blocking. This means a fact stored in one turn may not be searchable immediately in the next (eventual consistency).

**Deduplication.** MemoryManager tracks a per-store high-water mark: a pointer to the last message that was already processed. Each trigger only processes messages beyond that mark, preventing duplicate writes.

**Custom triggers.** `ExtractionTrigger` is an abstract base class — extend it for custom trigger logic.

**Corrections.** Corrections are handled by storing updated facts. Newer entries take precedence via recency weighting in search results.

#### Extractors

When messages are extracted, they need to become searchable entries. Some managed backends handle this transformation server-side. For self-managed backends, MemoryManager can extract discrete facts via an `Extractor`.

`ModelExtractor` is the built-in implementation: it calls a language model with a configurable system prompt to extract facts, defaulting to the agent's own model but configurable with an explicit cheaper model to reduce cost.

When no extractor is configured, messages are serialized as plain text and passed directly to the store's `add()` method.

---

## Developer Experience

### Minimal: prototyping

```typescript
import { Agent, MemoryManager, InMemoryMemoryStore } from '@strands-agents/sdk'

const agent = new Agent({
  model,
  memoryManager: new MemoryManager({
    stores: [new InMemoryMemoryStore({ name: 'notes' })],
    storeToolConfig: true,
  }),
})
// Agent now has search_memory and store_memory tools. Zero infrastructure.
```

### Production: Bedrock Knowledge Bases

```typescript
import { Agent, MemoryManager, BedrockKnowledgeBaseStore, ModelExtractor, InvocationTrigger } from '@strands-agents/sdk'

const userKB = new BedrockKnowledgeBaseStore({
  name: 'personal',
  knowledgeBaseId: 'KB123',
  dataSourceId: 'DS456',
  extraction: {
    triggers: [new InvocationTrigger()],
    extractor: new ModelExtractor({ model, systemPrompt: 'Extract user preferences and decisions as discrete facts.' }),
  },
})

const agent = new Agent({
  model,
  memoryManager: new MemoryManager({
    stores: [userKB],
    storeToolConfig: true,
  }),
})
```

### Multi-tenant: personal + team + org

```typescript
const userKB = new BedrockKnowledgeBaseStore({
  name: 'personal',
  description: 'User preferences and facts',
  knowledgeBaseId: 'KB-USER',
  dataSourceId: 'DS-USER',
  extraction: { triggers: [new InvocationTrigger()], extractor },
})

const teamKB = new BedrockKnowledgeBaseStore({
  name: 'team',
  description: 'Team decisions and processes',
  knowledgeBaseId: 'KB-TEAM',
  dataSourceId: 'DS-TEAM',
})

const orgKB = new BedrockKnowledgeBaseStore({
  name: 'org',
  description: 'Organization policies',
  knowledgeBaseId: 'KB-ORG',
  dataSourceId: 'DS-ORG',
})

const agent = new Agent({
  model,
  memoryManager: new MemoryManager({
    stores: [userKB, teamKB, orgKB],
    storeToolConfig: { stores: ['personal'] },
  }),
})
// search_memory queries all three, merges by rank position
// store_memory writes only to personal (explicitly scoped)
```

### With context injection

```typescript
const agent = new Agent({
  model,
  memoryManager: new MemoryManager({
    stores: [myStore],
    injection: true,  // default: message target, XML format, 2000 token budget
  }),
})
```

## Alternatives Considered

### 1. Memory as a top-level Agent parameter (no MemoryManager class)

```typescript
new Agent({ memory: { stores: [...], injection: {...} } })
```

**Why rejected:** A config object doesn't provide methods (`search`, `store`) that power users need for programmatic access. The class also owns the extraction queue lifecycle.

### 2. Single store (no multi-store orchestration)

**Why rejected:** Forces multi-tenant patterns onto the developer. Multi-store is a customer ask for production agents.

### 3. Two-interface split (`MemoryStore` + `MutableMemoryStore`)

The split provides compile-time guarantees that are leaky in practice for custom extensions. Some backends don't support writes at all, but would be forced to implement `add()` that throws. The two-interface approach creates false confidence while real integrations still hit runtime failures. A single interface with optional methods is simpler and more honest.

### 4. Wrapper config objects for stores (`StoreConfig`)

An earlier design used `stores: [{ store, name, limit, ingestion }]`. This was replaced by putting config directly on the store instance, matching the SDK pattern where instances in arrays are self-contained (like plugins, tools, MCP clients). Simpler DX: `stores: [userKB, teamKB, orgKB]`.

### 5. `includeTools` boolean for tool registration

An earlier design used `includeTools?: boolean | ToolsConfig` to control tool registration. This conflated tool registration with write targeting. Replaced by explicit `searchToolConfig` / `storeToolConfig` which cleanly separate tool configuration and provide fail-fast validation.


## Consequences

### What Becomes Easier

- Cross-session knowledge becomes a single parameter. No custom persistence, no manual tool registration, no vector store wiring.
- Multi-tenancy is built in via multi-store (scoping handled per-store).
- Progressive complexity: prototyping with `InMemoryMemoryStore` to production with `BedrockKnowledgeBaseStore` is changing one import.

### What Becomes Harder or Requires Attention

- **Eventual consistency**: writes are async; a fact may not be searchable in the next turn.
- **Extraction cost**: `InvocationTrigger` fires a model call every turn. We need sensible defaults and good documentation for users to navigate this.
- **Active recall depends on model judgment**: the model must know when to search. Context injection guarantees baseline context at the cost of always paying for retrieval. We need to evaluate and baseline tool descriptions.

### Migration

No breaking changes. `memoryManager` is a new optional parameter on `AgentConfig`.

## Willingness to Implement

Yes.

---

<details>
<summary><b>Appendix A: Core Interfaces</b></summary>

### MemoryEntry

```typescript
interface MemoryEntry {
  id?: string
  content: string
  metadata?: Record<string, JSONValue>
}
```

### MemoryStore

```typescript
interface SearchOptions {
  limit?: number
}

interface MemoryStore {
  readonly name: string
  readonly description?: string
  readonly limit?: number
  readonly extraction?: ExtractionConfig

  search(query: string, options?: SearchOptions): Promise<MemoryEntry[]>
  add?(content: string, metadata?: Record<string, JSONValue>): Promise<void>
}
```

### ExtractionConfig

```typescript
interface ExtractionConfig {
  triggers: ExtractionTrigger[]
  extractor?: Extractor
  filter?: MessageFilter      // default: { exclude: ['toolUse', 'toolResult'] }
}

abstract class ExtractionTrigger {
  abstract readonly name: string
}

class InvocationTrigger extends ExtractionTrigger {
  readonly name = 'invocation'
}

class EvictionTrigger extends ExtractionTrigger {
  readonly name = 'eviction'
}

class IntervalTrigger extends ExtractionTrigger {
  readonly name = 'interval'
  constructor(options: { turns: number })
}

interface Extractor {
  extract(messages: MessageData[]): Promise<{ content: string; metadata?: Record<string, JSONValue> }[]>
}

class ModelExtractor implements Extractor {
  constructor(options: {
    model?: Model
    systemPrompt?: string
  })
}
```

### MemoryManagerConfig

```typescript
interface MemoryManagerConfig {
  stores: MemoryStore[]
  searchToolConfig?: MemoryToolConfig | boolean  // default: true
  storeToolConfig?: MemoryToolConfig | boolean   // default: false
  injection?: boolean | InjectionConfig          // default: false
}

interface MemoryToolConfig {
  name?: string
  description?: string
  stores?: (string | MemoryStore)[]
}

interface InjectionConfig {
  target?: 'message' | 'systemPrompt'
  format?: (entries: MemoryEntry[]) => string
  maxTokens?: number
  query?: (messages: MessageData[]) => string
}

interface MemorySearchOptions {
  limit?: number
  stores?: string[]
}

interface MemoryStoreOptions {
  metadata?: Record<string, JSONValue>
  stores?: string[]
}
```

### MemoryManager

```typescript
class MemoryManager implements Plugin {
  search(query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]>
  store(content: string, options?: MemoryStoreOptions): Promise<void>
}
```

</details>

---

<details>
<summary><b>Appendix B: Implementation Details</b></summary>

### Context injection lifecycle

When injection is enabled, MemoryManager hooks into `BeforeInvocationEvent` (once per turn). The lifecycle:

1. **Strip**: Remove previous injection from messages
2. **Retrieve**: Use last substantive user message (>10 chars) as search query
3. **Format**: Render results, respecting `maxTokens` budget
4. **Inject**: Insert as message before user's last turn (default) or append to system prompt

If no substantive message exists or retrieval returns zero results, injection is skipped for that turn.

### `search_memory` tool behavior

Accepts `{ query: string, limit?: number, stores?: string[] }`. When `stores` is provided, only those named stores are queried; otherwise all stores are searched. Results are concatenated in store config order. Stores that fail are logged and skipped — partial results from other stores are still returned.

### `store_memory` tool behavior

Accepts `{ entries: string[], stores?: string[] }` (batch). Writes fan out to targeted stores. Returns `{ stored: number, failed: number }`.

### Message filter details

`filter: { exclude: ContentBlockType[] }` strips content block types before they reach the extractor or serializer. Messages that become empty after filtering are dropped entirely. Default: `exclude: ['toolUse', 'toolResult']`.

Extractors receive only unprocessed messages (tracked via per-store high-water mark).

### Custom triggers

```typescript
const myStore = new BedrockKnowledgeBaseStore({ ... })

agent.addHook(AfterToolCallEvent, async (event) => {
  if (event.tool.name === 'important_api') {
    await myStore.add(`API result: ${summarize(event.result)}`)
  }
})
```

</details>

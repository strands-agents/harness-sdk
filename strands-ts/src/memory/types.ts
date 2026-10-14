import type { JSONValue } from '../types/json.js'
import type { MessageData } from '../types/messages.js'
import type { Tool } from '../tools/tool.js'
import type { ExtractionConfig } from './extraction/types.js'
import type { InjectionConfig } from '../injection/index.js'

/**
 * A single memory entry retrieved from or stored to a memory store.
 */
export interface MemoryEntry {
  /** The textual content of this memory entry. */
  content: string
  /**
   * Name of the store this entry came from. Populated by {@link MemoryManager.search} so callers
   * (and the model, via `search_memory`) can tell which store produced each result and refine
   * targeting. Stores need not set this themselves.
   */
  storeName?: string
  /** Optional metadata (e.g., score, source, id, timestamp). */
  metadata?: Record<string, JSONValue>
}

/**
 * Options passed to {@link MemoryStore.search}.
 *
 * Store implementations may extend this with backend-specific fields (e.g. a metadata filter or
 * search-type override) in their own `search` signature. Note that {@link MemoryManager.search}
 * only forwards the base fields here across its (potentially heterogeneous) stores — to use a
 * store's extended options, call that store's `search` directly, or set them as per-instance
 * defaults on the store.
 */
export interface SearchOptions {
  /** Maximum number of results to return from this store. */
  maxSearchResults?: number
}

/**
 * Context the {@link MemoryManager} supplies to {@link MemoryStore.addMessages} alongside a batch.
 *
 * An extension point: fields are added here without changing the {@link MemoryStore.addMessages}
 * signature.
 */
export interface AddMessagesContext {
  /**
   * Per-message identities aligned one-to-one with `messages` (`sequenceNumbers[i]` identifies
   * `messages[i]`). A retried batch reuses the same numbers, so a store can build an idempotency key
   * that survives retries - unlike a content hash, which collides when two messages share text (e.g.
   * "ok"). Numbers increase with order but may have gaps, and reset to 0 each agent run, so a durable
   * dedup token must combine one with a run-unique id.
   */
  readonly sequenceNumbers?: readonly number[]
}

/**
 * Declarative properties shared by every memory store and its config.
 *
 * This is the single source of truth for a store's identity and behavior knobs. Both the runtime
 * {@link MemoryStore} interface and concrete store configs extend it, so these fields are declared
 * once. Concrete stores add their own backend-specific config fields on top.
 */
export interface MemoryStoreConfig {
  /** Identifier for this store, used to target specific stores in search/add tools. Must be unique. */
  readonly name: string
  /** Human-readable description of what this store contains. Included in tool descriptions. */
  readonly description?: string
  /**
   * Default maximum number of results this store returns per search, used when a caller does not
   * pass a per-call `maxSearchResults`.
   */
  readonly maxSearchResults?: number
  /**
   * Whether this store accepts writes. Optional at config time (caller intent, defaults to `false`);
   * concrete stores resolve it to a definite boolean on the {@link MemoryStore} interface.
   *
   * @defaultValue false
   */
  readonly writable?: boolean
  /**
   * Automatic-extraction config for this writable store, as a `boolean | config` shorthand. `true`
   * enables it with defaults; an {@link ExtractionConfig} defaults any unset field; `false`/omitted is off.
   *
   * The defaults run every 5 turns, and the extraction method depends on the store's write methods. A
   * store implementing `addMessages` uses server-side extraction: the manager hands it the raw messages
   * and the backend extracts them, with no model call. A store implementing only `add` uses a
   * {@link ModelExtractor} for client-side extraction: it calls `agent.auxModel` to distill facts and
   * stores each one via `add`.
   *
   * @defaultValue false
   */
  readonly extraction?: boolean | ExtractionConfig
}

/**
 * Interface for a memory store backend.
 *
 * Extends {@link MemoryStoreConfig} with the runtime methods a store provides. Every store is
 * searchable; the resolved `writable` flag declares whether it also accepts writes, which is how
 * the {@link MemoryManager} decides where to route them. `search_memory` can query all stores, while
 * `add_memory` can only write to `writable` stores.
 */
export interface MemoryStore extends MemoryStoreConfig {
  /**
   * Whether this store accepts writes.
   * - `false`: searchable only; never written to.
   * - `true`: searchable and writable. Requires at least one write sink — `add`, `addMessages`,
   *   or both — to be implemented.
   */
  readonly writable: boolean
  /** Search the store for entries matching the query, ordered by relevance. */
  search(query: string, options?: SearchOptions): Promise<MemoryEntry[]>
  /**
   * Add a single piece of content to the store. Used by the `add_memory` tool, the programmatic
   * {@link MemoryManager.add}, and by extraction when an {@link ExtractionConfig.extractor} produces
   * discrete entries (an extraction config with an extractor requires this method).
   *
   * A store satisfies `writable: true` with `add`, {@link addMessages}, or both. A store may also
   * implement `add` while declaring `writable: false`, in which case it is never invoked.
   *
   * Extraction writes are at-least-once: if one entry in a batch fails, the whole batch is retried, so
   * `add` may be called again with content it already stored. Implementations used with extraction
   * should tolerate duplicate writes (e.g. dedupe, or accept that retries may re-store an entry).
   *
   * The resolved value is store-specific (e.g. a created record id or a write receipt) — each backend
   * may return whatever shape fits it. The {@link MemoryManager} does not consume this value (it only
   * awaits completion); callers using a store directly can read it.
   */
  add?(content: string, metadata?: Record<string, JSONValue>): Promise<unknown>
  /**
   * Ingest a batch of conversation messages, preserving their role structure. This is the sink for
   * automatic extraction that does not distill facts client-side: the manager hands the filtered
   * {@link MessageData} batch straight here in one call — no serialization, no model call. Backends
   * that turn raw turns into memory themselves (e.g. role-aware conversational APIs that summarize
   * server-side) implement this so the user/assistant structure survives. A store using extraction
   * implements this method, unless it configures an {@link ExtractionConfig.extractor} (which produces
   * discrete entries written via {@link add} instead).
   *
   * Satisfies `writable: true` the same way {@link add} does. The resolved value is store-specific
   * and not consumed by the manager.
   *
   * A store scopes its writes (e.g. by tenant or namespace) through its own configuration. The
   * {@link AddMessagesContext} parameter lets the manager pass additional per-batch context to the
   * store.
   *
   * @param messages - The filtered messages to ingest, in order
   * @param context - Manager-supplied per-batch context (see {@link AddMessagesContext})
   */
  addMessages?(messages: MessageData[], context?: AddMessagesContext): Promise<unknown>
  /**
   * Perform async setup that must succeed before the agent runs.
   *
   * Called by the {@link MemoryManager} during `initAgent`. Stores that require remote resources
   * (e.g. resolving a knowledge base type) implement this; the default is a no-op.
   */
  initialize?(): Promise<void>
  /**
   * Returns store-specific tools to register with the agent, through a {@link MemoryManager}. Registers
   * tools alongside `search_memory` / `add_memory` tools if enabled on the {@link MemoryManager}.
   * Implement to expose backend-specific capabilities (e.g. a store-native query tool).
   *  Optional, mirrors {@link Plugin.getTools}.
   *
   * @returns Array of tools provided by this store
   */
  getTools?(): Tool[]
}

/**
 * Options for {@link MemoryManager.search}.
 *
 * Extends the store primitive {@link SearchOptions} with manager-level store routing.
 */
export interface MemorySearchOptions extends SearchOptions {
  /** Filter to specific stores by name. Omit to search all. */
  stores?: string[]
}

/**
 * Options for {@link MemoryManager.add}.
 */
export interface MemoryAddOptions {
  /** Metadata to associate with the added entry. */
  metadata?: Record<string, JSONValue>
  /** Filter to specific writable stores by name. Omit to write to all writable stores. */
  stores?: string[]
}

/**
 * Configuration for customizing a memory tool's name or description.
 */
export interface MemoryToolConfig {
  /** Custom tool name. */
  name?: string
  /** Custom tool description. */
  description?: string
}

/**
 * Configuration for the `add_memory` tool. Extends {@link MemoryToolConfig} with an explicit
 * allowlist of stores the tool may write to.
 */
export interface MemoryAddToolConfig extends MemoryToolConfig {
  /**
   * The writable stores the `add_memory` tool may write to, given as store names or the
   * {@link MemoryStore} instances themselves. Each must be a configured, `writable` store.
   *  Omit (or set `addToolConfig: true`) to allow all writable stores.
   */
  stores?: (string | MemoryStore)[]
  /**
   * Whether the tool waits for store writes before returning to the model. Defaults to `true`.
   * - `true` (default): waits for writes — the tool returns `{ stored }` on success, or surfaces a
   *   failure to the model if any store write fails.
   * - `false`: fire-and-forget — the tool returns `{ accepted }` once writes are dispatched (so a
   *   slow backend never blocks the agent loop); per-store failures are logged.
   */
  waitForWrites?: boolean
}

/**
 * Configuration for memory context injection.
 *
 * When enabled on a {@link MemoryManager}, the manager searches memory before a model call and makes
 * the top results available to the model for that call, so relevant knowledge is present without the
 * model choosing to search. The injected text is ephemeral: it augments the model input for that call
 * only and never persists into the durable conversation or session.
 *
 * Extends the generic {@link InjectionConfig} (which carries `trigger`) with the memory-owned knobs:
 * how many entries to retrieve, how to derive the query, and how to render the results.
 */
export interface MemoryInjectionConfig extends InjectionConfig {
  /**
   * Maximum number of entries to retrieve and inject per model call.
   *
   * A store ranks by semantic similarity, which is not the same as contextual usefulness, so the
   * default injects a small candidate set rather than betting on the top hit. Raising this improves
   * recall at the cost of a larger prepend (context bloat); lower it for a tighter injection.
   *
   * With multiple stores, results are concatenated in store-registration order with no cross-store
   * ranking, so this cap can favor entries from earlier-registered stores.
   *
   * @defaultValue 5
   */
  maxEntries?: number
  /**
   * Derives the search query from the current conversation. Return `undefined` or an empty string to
   * skip injection for this call. A callback that throws fails open (injection is skipped).
   *
   * Defaults to an adaptive query: the latest user message's text on a user turn, otherwise the most
   * recent assistant message's text (the previous step on an autonomous turn).
   */
  query?: (context: { messages: MessageData[] }) => string | undefined
  /**
   * Renders retrieved entries into the injected text. A callback that throws fails open (injection is
   * skipped).
   *
   * Defaults to a `<memory>` XML block with one `<entry>` per result, carrying a `source` attribute
   * naming the originating store (when known) so the model can attribute and weigh each memory. The
   * default escapes entry content and source, so a custom `format` that emits markup is responsible
   * for its own escaping.
   */
  format?: (context: { entries: MemoryEntry[] }) => string
}

/**
 * Configuration for the {@link MemoryManager}.
 */
export interface MemoryManagerConfig {
  /** One or more memory stores to manage. */
  stores: MemoryStore[]
  /** Search tool configuration. Defaults to `true`. */
  searchToolConfig?: MemoryToolConfig | boolean
  /**
   * Add tool configuration. Defaults to `false` (opt-in). `true` lets the tool write to all
   * writable stores; pass a {@link MemoryAddToolConfig} with `stores` to restrict it to specific ones.
   */
  addToolConfig?: MemoryAddToolConfig | boolean
  /**
   * Memory context injection. Defaults to `true`. `true` uses the default injection settings;
   * pass a {@link MemoryInjectionConfig} to customize retrieval, timing, and formatting; `false`
   * disables it.
   *
   * `true` is equivalent to:
   * ```ts
   * {
   *   trigger: 'userTurn',          // inject only on a fresh user ask
   *   maxEntries: 5,                // retrieve and inject up to 5 entries
   *   // query:  the latest user text on a user turn, else the most recent assistant text
   *   // format: a <memory> block with one <entry source="STORE_NAME"> per result (content escaped)
   * }
   * ```
   */
  injection?: boolean | MemoryInjectionConfig
}

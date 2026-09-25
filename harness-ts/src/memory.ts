/**
 * File-based memory resolution: build a `MemoryManager` over a local `FileMemoryStore`.
 *
 * Memory is on by default. Facts the agent learns are distilled every few turns into markdown
 * files under `memory.dir` (default `./.agent/memory`), searched and injected before each turn
 * so a returning agent recalls them without re-asking. Persistence is plain files, independent of
 * any session: memory survives across sessions and works with sessions off.
 *
 * Extraction is background and turn-triggered, so a short run can end with the latest turns unsaved.
 * Binding the agent with `await using` runs its shutdown on scope exit, or the owner of the agent's
 * lifecycle calls `await agent.shutdown()` at shutdown, to persist what's pending; the harness's CLI
 * flushes at that boundary for you, and a library consumer should do one of these.
 *
 * A consumer can swap the backend by passing their own `stores`; the harness still owns the manager, so
 * its injection/tool policy (injection on, `search_memory` on, `add_memory` off) applies either way.
 */

import { MemoryManager, ModelExtractor, type MemoryStore, type Model, type ModelRouter } from '@strands-agents/sdk'
import { LocalFileStorage } from '@strands-agents/sdk/storage'
import { FileMemoryStore } from '@strands-agents/sdk/vended-memory-stores/file-memory-store'

import { DEFAULT_MEMORY_DIR } from './defaults.js'
import { resolveWebFetchModel } from './models.js'
import type { WebFetchConfig } from './types/agent.js'

/** Store name, surfaced as the `source` attribute on each injected `<memory>` entry. */
const MEMORY_STORE_NAME = 'memory'

/** Options for {@link resolveMemory}. */
export interface ResolveMemoryOptions {
  /**
   * Consumer-supplied store(s) to manage instead of the default file store. When omitted or an empty
   * array, the harness builds a `FileMemoryStore` under `dir`. `model`/`dir`/`webFetch` are used only to
   * build that default store and are ignored when `stores` is non-empty.
   */
  stores?: MemoryStore | MemoryStore[] | undefined
  /** The agent's `model` argument, used to derive the small extraction model for the default store. */
  model?: Model | ModelRouter | string | undefined
  /** Directory the default store's memory files live in (`memory.dir`). */
  dir?: string | undefined
  /** The agent's `builtinTools.web_fetch` config; its `model` overrides the extraction model. */
  webFetch?: WebFetchConfig | undefined
  /**
   * Whether the manager may write to its stores. `true` (default) builds a writable default store
   * and passes consumer stores through as-is. `false` builds a recall-only manager: the default
   * store is created read-only and consumer stores are wrapped in a read-only view, so the manager
   * still searches and injects them but never extracts or writes. That is the shape for a subagent
   * delegate, which reads the shared memory without promoting its throwaway subtask into the store.
   */
  writable?: boolean | undefined
}

/**
 * Build the memory manager: a `MemoryManager` wrapping either the consumer's `stores` or a default
 * `FileMemoryStore` writing to `dir`, with the SDK's tool defaults (`search_memory` on, no
 * `add_memory` write tool) and injection on every turn.
 *
 * The default store's keys are pre-namespaced to `dir` itself, so files land at
 * `dir/<slug>.md` without the store's own `memory/<name>/` scoping doubling the path.
 * Extraction runs on the same small, credential-aligned model `web_fetch` summarizes with (the
 * agent's `web_fetch.model` override, or the small model for its provider) rather than the main
 * model, so distilling facts every few turns stays cheap.
 *
 * @returns A configured `MemoryManager` to pass as `Agent({ memoryManager })`.
 */
export async function resolveMemory(options: ResolveMemoryOptions = {}): Promise<MemoryManager> {
  const { stores, model, dir = DEFAULT_MEMORY_DIR, webFetch, writable = true } = options
  const supplied = stores === undefined ? [] : Array.isArray(stores) ? stores : [stores]
  const list =
    supplied.length > 0
      ? supplied.map((store) => (writable ? store : toReadOnly(store)))
      : [await buildDefaultStore(model, dir, webFetch?.model, writable)]
  // Inject on every model call, not only on a fresh user ask: the harness runs multi-step tool loops, so an
  // autonomous step (or a delegate) consults memory at each turn rather than only when the user speaks.
  return new MemoryManager({ stores: list, injection: { trigger: 'everyTurn' } })
}

/** The default file-backed store, writing markdown directly under `dir`. */
async function buildDefaultStore(
  model: Model | ModelRouter | string | undefined,
  dir: string,
  webFetchModel: Model | ModelRouter | string | undefined,
  writable: boolean
): Promise<FileMemoryStore> {
  const storage = new LocalFileStorage(dir).namespace('')
  return new FileMemoryStore({
    name: MEMORY_STORE_NAME,
    storage,
    writable,
    ...(writable && {
      extraction: { extractor: new ModelExtractor({ model: await resolveWebFetchModel(model, webFetchModel) }) },
    }),
  })
}

/**
 * A recall-only view of a store: the same backend, still searchable, but with every write path
 * (`add`/`addMessages`) and its extraction config dropped so the delegate's manager can neither
 * extract nor write. `getTools` is omitted too, since a store-native tool is an unbounded surface
 * we can't guarantee is read-only; the delegate still recalls through `search_memory` and injection.
 */
function toReadOnly(store: MemoryStore): MemoryStore {
  return {
    name: store.name,
    writable: false,
    ...(store.description !== undefined && { description: store.description }),
    ...(store.maxSearchResults !== undefined && { maxSearchResults: store.maxSearchResults }),
    search: store.search.bind(store),
    ...(store.initialize && { initialize: store.initialize.bind(store) }),
  }
}

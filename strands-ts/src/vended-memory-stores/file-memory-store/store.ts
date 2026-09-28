/**
 * File-based memory store implementing the {@link MemoryStore} interface.
 *
 * Stores knowledge as markdown files under a `memory/` storage namespace. Provides keyword-based
 * search via `search_memory` (registered by {@link MemoryManager}).
 */

import type { MemoryEntry, MemoryStore, MemoryStoreConfig, SearchOptions } from '../../memory/types.js'
import type { ExtractionConfig, ExtractionResult, Extractor, ExtractorContext } from '../../memory/extraction/types.js'
import type { JSONValue } from '../../types/json.js'
import type { MessageData } from '../../types/messages.js'
import type { Storage } from '../../storage/storage.js'
import type { Model } from '../../models/model.js'
import type { SearchStrategy } from '../../storage/search/types.js'

/**
 * Configuration for {@link FileMemoryStore}.
 */
export interface FileMemoryStoreConfig extends MemoryStoreConfig {
  /**
   * The unified Storage backend for file operations. Defaults to LocalFileStorage at `./.strands/`.
   * Keys are auto-scoped under `memory/<name>/` unless the provided storage is already namespaced, so
   * stores with distinct names safely share one backend. Two stores with the same name on the same
   * backend share storage — give them different names (or separate storage) to isolate them.
   */
  storage?: Storage
  /**
   * Automatic-extraction config. Accepts the shared {@link ExtractionConfig} (trigger/extractor/filter)
   * plus `model` and `systemPrompt` knobs for the built-in key-aware extractor — see
   * {@link FileMemoryExtractionConfig}.
   */
  extraction?: boolean | FileMemoryExtractionConfig
  /**
   * Override the search strategy used by this memory store. When set, `search()` delegates to
   * this strategy instead of the default keyword token-overlap scan. The underlying storage
   * backend is unaffected — only this store's search behavior changes.
   */
  search?: SearchStrategy
}

/**
 * Extraction config for {@link FileMemoryStore}: the shared {@link ExtractionConfig} plus knobs for the
 * store's built-in key-aware extractor. `model` and `systemPrompt` are ignored when an `extractor` is
 * supplied — a custom extractor brings its own model and prompt.
 */
export interface FileMemoryExtractionConfig extends ExtractionConfig {
  /** Model the built-in extractor uses to distill facts. Defaults to the agent's own model; set a cheaper one to cut cost. */
  model?: Model
  /**
   * Framing that steers what counts as a durable fact, replacing the default guidance. The store always
   * appends its own output contract (JSON array shape and heading-first layout) after it, so extraction
   * stays parseable and append-on-topic keeps grouping — you retune what is extracted, not its structure.
   */
  systemPrompt?: string
}
import { LocalFileStorage } from '../../storage/local-file-storage.js'
import { ModelExtractor } from '../../memory/extraction/model-extractor.js'
import { normalizeKey, resolveNamespace } from '../../storage/storage.js'
import { tokenize, tokenOverlapScore } from '../../storage/search/keyword.js'
import { logger } from '../../logging/logger.js'

/** Overridable framing (via {@link FileMemoryExtractionConfig.systemPrompt}) for what to extract. */
const DEFAULT_EXTRACTION_GUIDANCE = `You extract durable facts worth remembering across future conversations from a transcript.`

/**
 * Output contract the store owns and always appends after the (possibly overridden) guidance: the JSON
 * array shape {@link ModelExtractor} parses and the heading-first layout {@link FileMemoryStore.add}
 * slugifies to group facts. Appending it lets an overridden prompt retune guidance without breaking
 * parsing or append-on-topic.
 */
const EXTRACTION_CONTRACT = `Return ONLY a JSON array of objects: {"content": string}.

Group related facts into a single entry. The first line is a markdown heading (e.g. "# User preferences", "# Project setup", "# Team conventions"). Put each fact on its own line below the heading.

If there is nothing worth remembering, return [].`

const DEFAULT_MAX_SEARCH_RESULTS = 10
const STORAGE_NAMESPACE = 'memory'
/** Cap concurrent reads to avoid throttling on remote storage backends (e.g. S3). */
const BATCH_SIZE = 8
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Extract the filename stem (without `.md` extension) from a storage key. */
function basename(key: string): string {
  const filename = key.split('/').pop() ?? key
  return filename.replace(/\.md$/, '')
}

/** Convert text to a URL-safe kebab-case slug, truncated to 50 characters. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 50)
    .replace(/-+$/, '')
}

/**
 * Creates an {@link Extractor} that injects the store's existing topic headings into the extraction
 * prompt so the model reuses them, keeping related facts in one entry instead of fragmenting.
 *
 * Headings are read via `storage.list`, so this must be the store's own namespaced storage.
 *
 * @param storage - Storage the entries live under, listed to derive existing headings
 * @param model - Model used to extract facts. Defaults to the agent's own model; set a cheaper one to cut cost.
 * @param systemPrompt - Framing for what to extract, replacing {@link DEFAULT_EXTRACTION_GUIDANCE}. The
 *   {@link EXTRACTION_CONTRACT} is always appended after it.
 * @returns An extractor that reuses existing topic headings.
 */
function createKeyAwareExtractor(storage: Storage, model?: Model, systemPrompt?: string): Extractor {
  return {
    async extract(messages: MessageData[], context?: ExtractorContext): Promise<ExtractionResult[]> {
      const existingKeys = await storage.list('')
      const headings = existingKeys.map((key) => basename(key).replace(/-/g, ' '))

      const framing = systemPrompt ?? DEFAULT_EXTRACTION_GUIDANCE
      let composedPrompt = `${framing}\n\n${EXTRACTION_CONTRACT}`
      if (headings.length > 0) {
        composedPrompt += `\n\nExisting topics: ${headings.join(', ')}. Reuse an existing topic heading when new facts belong to it.`
      }

      return new ModelExtractor({ systemPrompt: composedPrompt, ...(model !== undefined && { model }) }).extract(
        messages,
        context
      )
    },
  }
}

/**
 * A file-based memory store backed by the unified {@link Storage} interface.
 *
 * Implements {@link MemoryStore} for use with {@link MemoryManager}. Knowledge is stored as plain
 * markdown files under a `memory/` storage namespace. Retrieval uses keyword-based token-overlap
 * scoring against filename and body content.
 *
 * The storage backend defaults to {@link LocalFileStorage}. Keys are auto-scoped under
 * `memory/<name>/` (so a store named `agent-memory` with the default backend writes to
 * `./.strands/memory/agent-memory/`).
 *
 * @example
 * ```typescript
 * import { Agent, MemoryManager } from '@strands-agents/sdk'
 * import { FileMemoryStore } from '@strands-agents/sdk/vended-memory-stores/file-memory-store'
 *
 * const memoryStore = new FileMemoryStore({ name: 'agent-memory' })
 *
 * const agent = new Agent({
 *   model,
 *   memoryManager: new MemoryManager({ stores: [memoryStore], injection: false }),
 * })
 * ```
 */
export class FileMemoryStore implements MemoryStore {
  readonly name: string
  readonly writable: boolean
  readonly description?: string
  readonly maxSearchResults?: number
  readonly extraction?: boolean | ExtractionConfig

  private readonly _storage: Storage
  private readonly _searchStrategy: SearchStrategy | undefined
  private readonly _writeLocks = new Map<string, Promise<string>>()

  constructor(config: FileMemoryStoreConfig) {
    this.name = config.name
    this.writable = config.writable ?? true
    if (config.description !== undefined) this.description = config.description
    if (config.maxSearchResults !== undefined) this.maxSearchResults = config.maxSearchResults
    this._storage = this._resolveStorage(config.storage ?? new LocalFileStorage())
    this._searchStrategy = config.search
    const extraction = this._resolveExtraction(config)
    if (extraction !== undefined) this.extraction = extraction
  }

  private _resolveExtraction(config: FileMemoryStoreConfig): boolean | ExtractionConfig | undefined {
    if (!config.extraction) return config.extraction
    if (config.extraction === true) {
      return { extractor: createKeyAwareExtractor(this._storage) }
    }
    const { model, systemPrompt, ...rest } = config.extraction
    if (rest.extractor) return rest
    return { ...rest, extractor: createKeyAwareExtractor(this._storage, model, systemPrompt) }
  }

  private _resolveStorage(storage: Storage): Storage {
    return resolveNamespace(storage, `${STORAGE_NAMESPACE}/${this.name}`)
  }

  /**
   * Search knowledge files by delegating to the storage backend's `search()` when available,
   * or falling back to a local keyword token-overlap scan.
   *
   * @param query - Natural-language search query
   * @param options - Optional search configuration (e.g. maxSearchResults)
   * @returns Top matches ranked by relevance.
   */
  async search(query: string, options?: SearchOptions): Promise<MemoryEntry[]> {
    const maxResults = options?.maxSearchResults ?? this.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS

    if (this._searchStrategy) {
      const results = await this._searchStrategy.search(this._storage, query)
      return this._hydrateResults(results.slice(0, maxResults))
    }

    return this._keywordSearch(query, maxResults)
  }

  private async _hydrateResults(results: Array<{ key: string; score: number }>): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = []
    for (const result of results) {
      const bytes = await this._storage.read(result.key)
      if (bytes) {
        entries.push({
          content: decoder.decode(bytes).trim(),
          metadata: { path: result.key, score: result.score },
        } as MemoryEntry)
      }
    }
    return entries
  }

  private async _keywordSearch(query: string, maxResults: number): Promise<MemoryEntry[]> {
    const queryTokens = tokenize(query)
    if (queryTokens.size === 0) return []

    const allKeys = await this._storage.list('')

    const scored: Array<{ entry: MemoryEntry; relevanceScore: number }> = []
    for (let offset = 0; offset < allKeys.length; offset += BATCH_SIZE) {
      const batch = await Promise.all(
        allKeys.slice(offset, offset + BATCH_SIZE).map(async (key) => {
          try {
            const bytes = await this._storage.read(key)
            if (!bytes) return null

            const body = decoder.decode(bytes)
            const searchable = `${basename(key)} ${body}`

            const relevanceScore = tokenOverlapScore(queryTokens, searchable)
            if (relevanceScore === 0) return null
            return {
              entry: { content: body.trim(), metadata: { path: key, score: relevanceScore } } as MemoryEntry,
              relevanceScore,
            }
          } catch (error) {
            logger.debug(`key=<${key}> | skipped unreadable memory entry: ${error}`)
            return null
          }
        })
      )
      for (const result of batch) {
        if (result) scored.push(result)
      }
    }

    scored.sort((a, b) => b.relevanceScore - a.relevanceScore)
    return scored.slice(0, maxResults).map((s) => s.entry)
  }

  /**
   * Add a knowledge entry to the store.
   *
   * The filename is derived from the first line of content (slugified, truncated to 50 chars).
   * If a file with the same slug already exists, new facts (lines after the heading) are appended
   * to it rather than overwriting. This keeps extraction token-cheap (only headings are injected
   * into the prompt) while avoiding data loss on repeated topics.
   *
   * @param content - The knowledge content to store
   * @param _metadata - Unused; accepted for interface compatibility with the ExtractionCoordinator
   * @returns The canonical storage key the entry was written under
   */
  async add(content: string, _metadata?: Record<string, JSONValue>): Promise<string> {
    const lines = content.split(/\n/)
    const firstLine = lines[0]!.replace(/^#+\s*/, '')
    const key = `${slugify(firstLine) || `entry-${Date.now()}`}.md`
    const canonicalKey = normalizeKey(key).toLowerCase()

    // Serialize writes per key to prevent lost-update from concurrent read-modify-write
    const prev = this._writeLocks.get(canonicalKey) ?? Promise.resolve('')
    const current = prev
      .catch(() => {})
      .then(async () => {
        const existing = await this._storage.read(canonicalKey)
        let merged: string
        if (existing) {
          const existingContent = decoder.decode(existing)
          const newFacts = lines.slice(1).join('\n').trim()
          merged = newFacts ? `${existingContent.trimEnd()}\n${newFacts}` : existingContent
        } else {
          merged = content
        }
        await this._storage.write(canonicalKey, encoder.encode(merged))
        return canonicalKey
      })
    this._writeLocks.set(canonicalKey, current)
    try {
      return await current
    } finally {
      if (this._writeLocks.get(canonicalKey) === current) {
        this._writeLocks.delete(canonicalKey)
      }
    }
  }
}

/**
 * L1 stash: durable storage for offloaded context content.
 *
 * When the ContextManager offloads content from the context window, the
 * original is persisted here so the agent can retrieve it on demand via the
 * retrieval tool.
 *
 * @internal
 */

import { NAMESPACED, namespace as namespaceStorage, type Storage } from '../storage/storage.js'
import { Message, ToolResultBlock } from '../types/messages.js'
import type { ContentBlock } from '../types/messages.js'
import type { JSONValue } from '../types/json.js'
import { logger } from '../logging/logger.js'
import { isProtocolBlock } from './strategies/offload/target.js'
import { isOffloaded } from './placeholder.js'

/** @internal */
export const STASH_PREFIX = 'context'

/**
 * Suffix on the storage key of an entry holding a block's text.
 *
 * `JSON.stringify` escapes every newline, so a JSON entry is one long line and anything reading the
 * stored bytes — a search strategy scoring lines, a section slice — sees one line however many the
 * text had. Text is stored as its own bytes instead. The key carries that fact rather than a header
 * in the payload, because the payload is what an external index reads: `QmdSearchStrategy` points
 * SQLite FTS5 at these files directly, and a header would be indexed as content.
 *
 * Only text entries take the suffix. Every other block stays JSON under the bare key, which is also
 * what every entry written before this looks like, so there is nothing to migrate.
 */
const TEXT_SUFFIX = '.txt'

/** How a value is stored: text as its own bytes under a suffixed key, or JSON under the bare key. */
function frame(value: unknown): { suffix: string; data: Uint8Array } {
  const text = flatText(value)
  if (text === null) return { suffix: '', data: new TextEncoder().encode(JSON.stringify(value)) }
  return { suffix: TEXT_SUFFIX, data: new TextEncoder().encode(text) }
}

function decode(key: string, bytes: Uint8Array): unknown {
  const content = new TextDecoder().decode(bytes)
  return key.endsWith(TEXT_SUFFIX) ? { text: content } : JSON.parse(content)
}

/**
 * The text of a value serialized as `{ text }` and nothing else, or `null` when it carries more than
 * text and so has to stay JSON.
 */
function flatText(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== 'text') return null
  const { text } = value as { text: unknown }
  return typeof text === 'string' ? text : null
}

/**
 * A stash key, `<id>_<index>`. The id is a tool result's `toolUseId`, a message's `trackingId`,
 * or `removed-<trackingId>` for messages removed together.
 *
 * @internal
 */
export interface StashKey {
  /** Owner of the entry. */
  id: string
  /** Position of the entry among the owner's items. */
  index: number
}

/** @internal */
export function formatStashKey(key: StashKey): string {
  return `${key.id}_${key.index}`
}

/**
 * Parses a stash key. The id may itself contain `_`, so the index is whatever follows the last one.
 *
 * @returns The key, or `null` when the text after the last `_` is not an index
 * @internal
 */
export function parseStashKey(key: string): StashKey | null {
  const separator = key.lastIndexOf('_')
  if (separator <= 0) return null
  const index = key.slice(separator + 1)
  if (!/^\d+$/.test(index)) return null
  return { id: key.slice(0, separator), index: Number(index) }
}

/**
 * Use a caller-scoped view as the exact stash root when allowed; otherwise namespace per session and agent.
 *
 * Only views from the built-in `namespace()` carry {@link NAMESPACED}, so a custom backend's own
 * `namespace()` view gets the per-agent prefix. Mirrors `strands-py`, where `_NamespacedStorage` is private.
 */
function resolveStashNamespace(
  storage: Storage,
  sessionId: string,
  agentId: string,
  customStashNamespace: boolean
): Storage {
  if (customStashNamespace && NAMESPACED in storage) return storage
  return namespaceStorage(storage, `${STASH_PREFIX}/${sessionId}/scopes/agent/${agentId}`)
}

/**
 * Wraps a Storage backend with key management and content framing for the
 * ContextManager's L1 stash.
 *
 * @internal
 */
export class Stash {
  private readonly _storage: Storage
  private readonly _baseStorage: Storage
  private readonly _sessionId: string

  /** Name of the base storage constructor, for diagnostic logging. */
  readonly storageTypeName: string

  constructor(storage: Storage, sessionId: string, agentId: string, options?: { customStashNamespace?: boolean }) {
    this._baseStorage = storage
    this._sessionId = sessionId
    this._storage = resolveStashNamespace(storage, sessionId, agentId, options?.customStashNamespace ?? false)
    this.storageTypeName = storage.constructor.name || 'unknown'
  }

  /**
   * Store a serialized block and return a deterministic reference key.
   *
   * Keys are deterministic (`<id>_<blockIndex>`) so they can be recomputed
   * from a block's position after a process restart or snapshot restore.
   *
   * @param id - Identifier component for the key (e.g. toolUseId)
   * @param blockIndex - Index of the block within the tool result
   * @param data - Serialized bytes to persist
   * @returns Reference key for retrieval
   */
  async store(id: string, blockIndex: number, data: Uint8Array): Promise<string> {
    const key = formatStashKey({ id, index: blockIndex })
    await this._storage.write(key, data)
    return key
  }

  /**
   * Write a block's serialized form under `key`, framed by what it holds.
   *
   * A reference never carries {@link TEXT_SUFFIX}: the suffix is how the bytes are stored, not part
   * of the key a placeholder quotes, so callers resolve the same `<id>_<index>` either way.
   */
  private async _writeValue(key: string, value: unknown): Promise<void> {
    const { suffix, data } = frame(value)
    await this._storage.write(`${key}${suffix}`, data)
  }

  /**
   * The reference an offload placeholder carries for the block it replaces, with the block stored
   * under that reference if it is not already.
   *
   * A {@link ToolResultBlock} is referenced by its `toolUseId`; the retrieval tool resolves it to
   * every stored item (`<toolUseId>_<i>`). Any other block is referenced by its position
   * (`<trackingId>_<blockIndex>`). History edits move blocks between messages and positions, so the
   * key a block was stored under on arrival can differ from its key now; storing here keeps every
   * emitted reference resolvable.
   *
   * @param block - The block about to be replaced
   * @param message - The message containing the block
   * @param blockIndex - Index of the block within the message
   * @returns The reference
   */
  async ensureStashed(block: ContentBlock, message: Message, blockIndex: number): Promise<string> {
    if (block instanceof ToolResultBlock) {
      // A result that already holds a placeholder is not the original; its items were stored before it was offloaded.
      if (block.content.some(isOffloaded)) return block.toolUseId
      if ((await this.keysOf(block.toolUseId)).length < block.content.length) await this._storeToolResult(block)
      return block.toolUseId
    }
    const key = formatStashKey({ id: message.trackingId, index: blockIndex })
    if (!(await this.list(key)).includes(key)) {
      await this._writeValue(key, block.toJSON())
    }
    return key
  }

  /**
   * Store messages removed from the context window as one entry.
   *
   * @param removed - The removed messages, in conversation order
   * @returns The reference the placeholder left in their place carries
   */
  async storeRemoved(removed: Message[]): Promise<string> {
    const id = `removed-${removed[0]!.trackingId}`
    await this._writeValue(
      formatStashKey({ id, index: 0 }),
      removed.map((message) => message.toJSON())
    )
    return id
  }

  /**
   * Eagerly stash all content from a message on arrival.
   * Called via MessageAddedEvent so content is persisted before any strategy runs.
   * Offload placeholders are never stored: their keys belong to the originals they replaced.
   *
   * @param message - The message whose content should be persisted
   * @param skipToolUseIds - Tool results to leave out, such as the retrieval tool's own
   * @param storedKeys - Keys already in the stash; a block stored under one keeps its entry, since a
   *   restored history can hold a placeholder where the stored original was
   */
  async storeMessage(
    message: Message,
    skipToolUseIds?: ReadonlySet<string>,
    storedKeys?: ReadonlySet<string>
  ): Promise<void> {
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
      const block = message.content[blockIndex]!
      if (this._isSkipped(block, message, blockIndex, skipToolUseIds, storedKeys)) continue
      if (block instanceof ToolResultBlock) {
        await this._storeToolResult(block)
        continue
      }
      try {
        await this._writeValue(formatStashKey({ id: message.trackingId, index: blockIndex }), block.toJSON())
      } catch (error) {
        logger.warn(`trackingId=<${message.trackingId}>, error=<${error}> | failed to stash block`)
      }
    }
  }

  private _isSkipped(
    block: ContentBlock,
    message: Message,
    blockIndex: number,
    skipToolUseIds?: ReadonlySet<string>,
    storedKeys?: ReadonlySet<string>
  ): boolean {
    if (isProtocolBlock(block)) return true
    if (block instanceof ToolResultBlock) {
      if (skipToolUseIds?.has(block.toolUseId) || block.content.some(isOffloaded)) return true
      return storedKeys !== undefined && [...storedKeys].some((key) => parseStashKey(key)?.id === block.toolUseId)
    }
    if (isOffloaded(block)) return true
    return storedKeys?.has(formatStashKey({ id: message.trackingId, index: blockIndex })) ?? false
  }

  /**
   * Retrieve previously stashed content as its serialized JSON form.
   *
   * @param reference - Key returned by a previous store call
   * @returns The deserialized block data (from `toJSON()`), or null if not found
   */
  async retrieve(reference: string): Promise<{ data: unknown } | null> {
    // Text is the common case, so it is read first; a bare key holds JSON.
    for (const key of [`${reference}${TEXT_SUFFIX}`, reference]) {
      const bytes = await this._storage.read(key)
      if (bytes !== null) return { data: decode(key, bytes) }
    }
    return null
  }

  /**
   * List stashed references, optionally only those starting with `prefix`.
   *
   * {@link TEXT_SUFFIX} is stripped, so a reference is the same `<id>_<index>` whichever framing its
   * entry was stored under. Every caller that parses or resolves a reference depends on that.
   */
  async list(prefix = ''): Promise<string[]> {
    const keys = await this._storage.list(prefix)
    return [...new Set(keys.map((key) => (key.endsWith(TEXT_SUFFIX) ? key.slice(0, -TEXT_SUFFIX.length) : key)))]
  }

  /**
   * The keys stored under `id`, in index order. A prefix list alone also returns ids that extend this one.
   */
  async keysOf(id: string): Promise<string[]> {
    return (await this.list(`${id}_`))
      .map((key) => ({ key, parsed: parseStashKey(key) }))
      .filter(({ parsed }) => parsed?.id === id)
      .sort((left, right) => left.parsed!.index - right.parsed!.index)
      .map(({ key }) => key)
  }

  /**
   * Delete a stashed entry, under either framing.
   */
  async delete(reference: string): Promise<void> {
    await Promise.all([this._storage.delete(`${reference}${TEXT_SUFFIX}`), this._storage.delete(reference)])
    logger.debug(`reference=<${reference}> | stash entry deleted`)
  }

  /**
   * Delete all entries in this stash instance.
   *
   * On a caller-scoped stash this deletes the whole view, including other agents' entries.
   * Not called during session deletion; kept for parity with `strands-py`.
   */
  async clear(): Promise<void> {
    const keys = await this.list()
    await Promise.all(keys.map((key) => this.delete(key)))
  }

  /**
   * Delete all stash data for this session across all agents.
   *
   * Scans `context/<sessionId>/` on the base storage to catch data from every
   * agent that wrote to the session. This covers every key {@link clear}
   * would delete for the default per-agent root. A stash rooted at a
   * caller-scoped view may be shared beyond this session, so its data is left
   * to the caller, including keys written under the pre-sharing
   * `context/...` layout.
   */
  async clearSession(): Promise<void> {
    // resolveStashNamespace returns the view itself only when it is the caller-scoped root.
    // Same identity check as `strands-py` (`self._storage is self._base_storage`).
    if (this._storage === this._baseStorage) {
      logger.debug(`session_id=<${this._sessionId}> | skipping stash deletion, stash is caller-scoped`)
      return
    }
    const prefix = `${STASH_PREFIX}/${this._sessionId}/`
    const keys = await this._baseStorage.list(prefix)
    await Promise.all(keys.map((key) => this._baseStorage.delete(key)))
  }

  /**
   * Serialize all stash entries into a plain object for snapshot persistence.
   *
   * On a caller-scoped stash this captures every entry in the shared view, not only this
   * agent's, and {@link loadSnapshot} writes them all back. Same as `strands-py`.
   *
   * @returns Map of reference keys to their stored JSON values
   */
  async takeSnapshot(): Promise<Record<string, JSONValue>> {
    const keys = await this.list()
    const results = await Promise.all(keys.map((key) => this.retrieve(key).then((result) => [key, result] as const)))
    const entries: Record<string, JSONValue> = {}
    for (const [key, result] of results) {
      if (result) {
        entries[key] = result.data as JSONValue
      }
    }
    return entries
  }

  /**
   * Restore stash entries from a previously captured snapshot.
   *
   * @param entries - Map of reference keys to their JSON values (from {@link takeSnapshot})
   */
  async loadSnapshot(entries: Record<string, JSONValue>): Promise<void> {
    await Promise.all(Object.entries(entries).map(([key, data]) => this._writeValue(key, data)))
  }

  private async _storeToolResult(block: ToolResultBlock): Promise<void> {
    for (let blockIndex = 0; blockIndex < block.content.length; blockIndex++) {
      const item = block.content[blockIndex]!
      try {
        await this._writeValue(formatStashKey({ id: block.toolUseId, index: blockIndex }), item.toJSON())
      } catch (error) {
        logger.warn(
          `toolUseId=<${block.toolUseId}>, blockIndex=<${blockIndex}>, error=<${error}> | failed to stash sub-block`
        )
      }
    }
  }
}

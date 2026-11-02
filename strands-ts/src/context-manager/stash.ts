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
import { isOffloaded, Message, ToolResultBlock } from '../types/messages.js'
import type { ContentBlock } from '../types/messages.js'
import type { JSONValue } from '../types/json.js'
import { logger } from '../logging/logger.js'
import { isProtocolBlock } from './strategies/offload/target.js'

/** @internal */
export const STASH_PREFIX = 'context'

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function decode(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes))
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
      await this.store(message.trackingId, blockIndex, encode(block.toJSON()))
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
    await this.store(id, 0, encode(removed.map((message) => message.toJSON())))
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
        await this.store(message.trackingId, blockIndex, encode(block.toJSON()))
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
    const bytes = await this._storage.read(reference)
    if (bytes === null) return null
    return { data: decode(bytes) }
  }

  /**
   * List stashed references, optionally only those starting with `prefix`.
   */
  async list(prefix = ''): Promise<string[]> {
    return this._storage.list(prefix)
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
   * Delete a stashed entry.
   */
  async delete(reference: string): Promise<void> {
    await this._storage.delete(reference)
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
    await Promise.all(Object.entries(entries).map(([key, data]) => this._storage.write(key, encode(data))))
  }

  private async _storeToolResult(block: ToolResultBlock): Promise<void> {
    for (let blockIndex = 0; blockIndex < block.content.length; blockIndex++) {
      const item = block.content[blockIndex]!
      try {
        await this.store(block.toolUseId, blockIndex, encode(item.toJSON()))
      } catch (error) {
        logger.warn(
          `toolUseId=<${block.toolUseId}>, blockIndex=<${blockIndex}>, error=<${error}> | failed to stash sub-block`
        )
      }
    }
  }
}

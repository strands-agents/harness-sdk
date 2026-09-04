import type { Plugin } from '../../plugins/plugin.js'
import type { Tool, ToolContext } from '../../tools/tool.js'
import type { LocalAgent } from '../../types/agent.js'
import type { Sandbox } from '../../sandbox/base.js'
import { AfterToolCallEvent, BeforeModelCallEvent } from '../../hooks/events.js'
import { TextBlock, JsonBlock, ToolResultBlock, Message } from '../../types/messages.js'
import type { ToolResultContent } from '../../types/messages.js'
import { ImageBlock, VideoBlock, DocumentBlock } from '../../types/media.js'
import type { ImageFormat, VideoFormat, DocumentFormat } from '../../types/media.js'
import { tool } from '../../tools/tool-factory.js'
import { z } from 'zod'
import { logger } from '../../logging/logger.js'
import type { JSONValue } from '../../types/json.js'
import { FileStorage, InMemoryStorage as LegacyInMemoryStorage, type Storage as OffloaderStorage } from './storage.js'
import { resolveNamespace, type Storage } from '../../storage/storage.js'
import { InMemoryStorage } from '../../storage/in-memory-storage.js'
import { isSearchableContent, searchContent } from './search.js'
import { AgentAsTool } from '../../agent/agent-as-tool.js'

function isOffloaderStorage(storage: Storage | OffloaderStorage): storage is OffloaderStorage {
  return 'store' in storage && 'retrieve' in storage
}

// Framed format for unified Storage: [2-byte contentType length BE][contentType UTF-8][content bytes]
// This keeps one storage key per offloaded block so content-type metadata doesn't consume maxEntries.
function frameContent(content: Uint8Array, contentType: string): Uint8Array {
  const ctBytes = new TextEncoder().encode(contentType)
  const frame = new Uint8Array(2 + ctBytes.length + content.length)
  frame[0] = (ctBytes.length >> 8) & 0xff
  frame[1] = ctBytes.length & 0xff
  frame.set(ctBytes, 2)
  frame.set(content, 2 + ctBytes.length)
  return frame
}

function unframeContent(frame: Uint8Array): { content: Uint8Array; contentType: string } {
  const ctLen = (frame[0]! << 8) | frame[1]!
  const contentType = new TextDecoder().decode(frame.subarray(2, 2 + ctLen))
  const content = frame.subarray(2 + ctLen)
  return { content, contentType }
}

async function storeContent(
  storage: Storage | OffloaderStorage,
  key: string,
  content: Uint8Array,
  contentType?: string
): Promise<string> {
  if (isOffloaderStorage(storage)) return storage.store(key, content, contentType)
  const ct = contentType ?? 'application/octet-stream'
  await storage.write(key, frameContent(content, ct))
  return key
}

async function retrieveContent(
  storage: Storage | OffloaderStorage,
  reference: string
): Promise<{ content: Uint8Array; contentType: string }> {
  if (isOffloaderStorage(storage)) return storage.retrieve(reference)
  const data = await storage.read(reference)
  if (data === null) throw new Error(`Reference not found: ${reference}`)
  return unframeContent(data)
}

const CHARS_PER_TOKEN = 4
const DEFAULT_MAX_RESULT_TOKENS = 2_500
const DEFAULT_PREVIEW_TOKENS = 1_000
const RETRIEVAL_TOOL_NAME = 'retrieve_offloaded_content'

const retrievalInputSchema = z.object({
  reference: z.string().describe('The reference string from the offload placeholder (e.g. "mem_1_tool-123_0").'),
  pattern: z
    .string()
    .optional()
    .describe('Regex or keyword to grep for. Returns only matching lines with context — not the full content.'),
  line_range: z
    .object({
      start: z.number().int().min(1).describe('First line to return (1-indexed).'),
      end: z.number().int().min(1).describe('Last line to return (1-indexed).'),
    })
    .optional()
    .describe('Return only this span of lines. Combine with pattern to search within the range.'),
  context_lines: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Lines before AND after each match (like grep -C). Default: 5. Without pattern/line_range, returns first N lines.'
    ),
})

function slicePreview(text: string, previewTokens: number): string {
  const maxChars = previewTokens * CHARS_PER_TOKEN
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars)
}

function getBytes(block: ToolResultContent): Uint8Array | undefined {
  if (block instanceof ImageBlock && block.source.type === 'imageSourceBytes') {
    return block.source.bytes
  }
  if (block instanceof VideoBlock && block.source.type === 'videoSourceBytes') {
    return block.source.bytes
  }
  if (block instanceof DocumentBlock) {
    if (block.source.type === 'documentSourceBytes') return block.source.bytes
    if (block.source.type === 'documentSourceText') return new TextEncoder().encode(block.source.text)
  }
  return undefined
}

function decodeStoredContent(content: Uint8Array, contentType: string, reference: string): JSONValue {
  if (contentType.startsWith('text/')) {
    return new TextDecoder().decode(content)
  }
  if (contentType === 'application/json') {
    const text = new TextDecoder().decode(content)
    try {
      return JSON.parse(text) as JSONValue
    } catch {
      return text
    }
  }
  // Return native content blocks for binary types so the agent sees the actual content.
  // FunctionTool._wrapInToolResult passes ImageBlock/VideoBlock/DocumentBlock through as-is
  // at runtime, even though the callback type signature only accepts JSONValue.
  if (contentType.startsWith('image/')) {
    const format = contentType.split('/').pop()!
    return new ImageBlock({
      format: format as ImageFormat,
      source: { bytes: content },
    }) as unknown as JSONValue
  }
  if (contentType.startsWith('video/')) {
    const format = contentType.split('/').pop()!
    return new VideoBlock({
      format: format as VideoFormat,
      source: { bytes: content },
    }) as unknown as JSONValue
  }
  if (contentType.startsWith('application/')) {
    const format = contentType.split('/').pop()!
    return new DocumentBlock({
      format: format as DocumentFormat,
      name: reference,
      source: { bytes: content },
    }) as unknown as JSONValue
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(content)
}

/** Configuration for the {@link ContextOffloader} plugin. */
export interface ContextOffloaderConfig {
  /**
   * Storage backend for persisting offloaded content.
   *
   * Accepts either:
   * - A unified `Storage` (from `@strands-agents/sdk/storage`) — each offloaded content block
   *   occupies exactly one key (content-type is framed into the stored bytes).
   * - A legacy offloader `Storage` (deprecated, from this module).
   *
   * When a unified `Storage` is provided, the plugin auto-scopes keys under `offloader/`
   * unless the storage is already namespaced. If the resolved storage exposes a
   * `forSandbox(sandbox)` method (as `LocalFileStorage` and its namespace views do),
   * the plugin auto-routes I/O through the agent's sandbox.
   *
   * When omitted, resolves from the agent-level `storage` during initialization.
   * If no agent-level storage is available either, falls back to in-memory storage.
   */
  storage?: Storage | OffloaderStorage
  /** Token threshold above which tool results are offloaded. Defaults to 2,500. */
  maxResultTokens?: number
  /** Number of tokens to keep as an inline preview. Defaults to 1,000. */
  previewTokens?: number
  /** Whether to register the `retrieve_offloaded_content` tool. Defaults to true. */
  includeRetrievalTool?: boolean
  /**
   * Number of agent loop cycles before an offloaded entry is evicted.
   * Entries stored more than this many cycles ago are deleted.
   * Defaults to 20. Set to `null` to disable eviction.
   */
  evictAfterCycles?: number | null
}

/**
 * Plugin that offloads oversized tool results to reduce context consumption.
 *
 * When a tool result exceeds the configured token threshold, this plugin stores
 * each content block to a storage backend and replaces the in-context result with
 * a truncated text preview plus per-block storage references.
 *
 * ## Eviction behavior
 *
 * Offloaded entries are evicted after `evictAfterCycles` agent loop cycles (default 20).
 * This applies to both unified `Storage` backends and legacy offloader storage.
 *
 * @deprecated Use {@link ContextManager} with {@link Offload} strategies instead. ContextManager will become the default in v2; ContextOffloader will be removed.
 *
 * @example
 * ```typescript
 * import { ContextOffloader } from '@strands-agents/sdk/vended-plugins/context-offloader'
 * import { InMemoryStorage } from '@strands-agents/sdk/storage'
 *
 * const agent = new Agent({
 *   model,
 *   plugins: [new ContextOffloader({
 *     storage: new InMemoryStorage(),
 *   })],
 * })
 * ```
 */
export class ContextOffloader implements Plugin {
  readonly name = 'strands:context-offloader'

  private static readonly _DEFAULT_EVICT_AFTER_CYCLES = 20

  private _sandboxableStorage: { forSandbox(sandbox: Sandbox): Storage } | undefined
  private _storage!: Storage | OffloaderStorage
  private readonly _maxResultTokens: number
  private readonly _previewTokens: number
  private readonly _includeRetrievalTool: boolean
  private readonly _evictAfterCycles: number | null
  private readonly _storageByAgent = new WeakMap<LocalAgent, Storage | OffloaderStorage>()
  private readonly _keyStoredAt = new Map<string, number>()
  private _retrievalTool: Tool | undefined

  constructor(config: ContextOffloaderConfig) {
    const maxResultTokens = config.maxResultTokens ?? DEFAULT_MAX_RESULT_TOKENS
    const previewTokens = config.previewTokens ?? DEFAULT_PREVIEW_TOKENS

    if (maxResultTokens <= 0) throw new Error('maxResultTokens must be positive')
    if (previewTokens < 0) throw new Error('previewTokens must be non-negative')
    if (previewTokens >= maxResultTokens) throw new Error('previewTokens must be less than maxResultTokens')

    const evictAfterCycles =
      config.evictAfterCycles === undefined ? ContextOffloader._DEFAULT_EVICT_AFTER_CYCLES : config.evictAfterCycles
    if (evictAfterCycles !== null && (!Number.isInteger(evictAfterCycles) || evictAfterCycles < 1)) {
      throw new Error('evictAfterCycles must be a positive integer')
    }

    if (config.storage) {
      this._resolveAndSetStorage(config.storage)
    }
    this._maxResultTokens = maxResultTokens
    this._previewTokens = previewTokens
    this._includeRetrievalTool = config.includeRetrievalTool ?? true
    this._evictAfterCycles = evictAfterCycles
  }

  private _resolveAndSetStorage(storage: Storage | OffloaderStorage): void {
    if (isOffloaderStorage(storage)) {
      this._storage = storage
    } else {
      this._storage = resolveNamespace(storage, 'offloader')
    }
    this._sandboxableStorage =
      !isOffloaderStorage(this._storage) && 'forSandbox' in this._storage
        ? (this._storage as { forSandbox(sandbox: Sandbox): Storage })
        : undefined
  }

  initAgent(agent: LocalAgent): void {
    if (!this._storage) {
      this._resolveAndSetStorage(agent.storage ?? new InMemoryStorage())
    }
    if (this._storage instanceof LegacyInMemoryStorage) {
      this._storage._bind(agent, this._evictAfterCycles)
    }
    this._storageForAgent(agent)
    agent.addHook(AfterToolCallEvent, (event) => this._handleToolResult(event))

    agent.addHook(BeforeModelCallEvent, () => {
      const cycleCount = agent.metrics.cycleCount
      if (this._storage instanceof LegacyInMemoryStorage) {
        this._storage._evict(cycleCount)
      } else if (this._evictAfterCycles !== null) {
        this._evict(cycleCount, agent)
      }
    })
  }

  private _evict(currentCycle: number, agent: LocalAgent): void {
    const threshold = currentCycle - this._evictAfterCycles!
    const toEvict: string[] = []
    for (const [key, storedCycle] of this._keyStoredAt) {
      if (storedCycle < threshold) {
        toEvict.push(key)
      }
    }
    if (toEvict.length === 0) return
    const storage = this._storageForAgent(agent) as Storage
    for (const key of toEvict) {
      this._keyStoredAt.delete(key)
      storage.delete(key).catch(() => {})
    }
    logger.debug(`evicted=<${toEvict.length}>, threshold=<${threshold}> | evicted stale offloaded entries`)
  }

  getTools(): Tool[] {
    if (!this._includeRetrievalTool) return []
    if (!this._retrievalTool) this._retrievalTool = this._createRetrievalTool()
    return [this._retrievalTool]
  }

  private _storageForAgent(agent: LocalAgent): Storage | OffloaderStorage {
    if (!this._sandboxableStorage && !(this._storage instanceof FileStorage)) return this._storage

    let storage = this._storageByAgent.get(agent)
    if (!storage) {
      if (this._sandboxableStorage) {
        storage = this._sandboxableStorage.forSandbox(agent.sandbox)
      } else {
        storage = (this._storage as FileStorage).forSandbox(agent.sandbox)
      }
      this._storageByAgent.set(agent, storage)
    }
    return storage
  }

  private _storageForToolContext(context?: ToolContext): Storage | OffloaderStorage {
    if (!this._sandboxableStorage && !(this._storage instanceof FileStorage)) return this._storage
    if (!context) {
      throw new Error('File-based storage retrieval requires a tool execution context.')
    }
    return this._storageForAgent(context.agent)
  }

  private _createRetrievalTool(): Tool {
    const maxChars = this._maxResultTokens * CHARS_PER_TOKEN

    return tool({
      name: RETRIEVAL_TOOL_NAME,
      description:
        'When a tool result was too large to keep in context, it was stored externally and replaced with a preview and a reference. ' +
        'Use this tool with that reference to access the stored content.\n\n' +
        'Returns:\n' +
        '  - With pattern: matching lines with line numbers and surrounding context\n' +
        '  - With line_range: the specified span of lines with line numbers\n' +
        '  - Without pattern/line_range: the full original content (use sparingly — re-injects all tokens)\n\n' +
        'Constraints:\n' +
        '  - pattern/line_range/context_lines only work on text content. For binary content, omit them.\n' +
        '  - Line numbers in results are 1-indexed and can be used in follow-up line_range calls.\n\n' +
        'Examples:\n' +
        '  { reference: "ref_1", pattern: "error" } → lines containing "error" with 5 lines context\n' +
        '  { reference: "ref_1", pattern: "error|warning", context_lines: 3 } → regex, 3 lines context\n' +
        '  { reference: "ref_1", line_range: { start: 10, end: 25 } } → lines 10-25\n' +
        '  { reference: "ref_1", pattern: "TODO", line_range: { start: 1, end: 50 } } → search within range',
      inputSchema: retrievalInputSchema,
      callback: async (input, context) => {
        try {
          const storage = this._storageForToolContext(context)
          const result = await retrieveContent(storage, input.reference)

          if (!input.pattern && !input.line_range && input.context_lines === undefined) {
            return decodeStoredContent(result.content, result.contentType, input.reference)
          }

          if (!isSearchableContent(result.contentType)) {
            return `Error: cannot search binary content (${result.contentType}). Omit pattern/line_range/context_lines to retrieve the full content.`
          }

          const text = new TextDecoder().decode(result.content)
          const contextLines = input.context_lines ?? 5
          const lineRange =
            input.line_range ?? (!input.pattern ? { start: 1, end: Math.max(1, contextLines) } : undefined)

          return searchContent(
            text,
            { pattern: input.pattern, line_range: lineRange, context_lines: contextLines },
            maxChars
          )
        } catch {
          return `Error: reference not found: ${input.reference}`
        }
      },
    })
  }

  private async _storeBlock(
    storage: Storage | OffloaderStorage,
    block: ToolResultContent,
    key: string
  ): Promise<{ ref: string; contentType: string; description: string }> {
    if (block instanceof TextBlock && block.text) {
      const ref = await storeContent(storage, key, new TextEncoder().encode(block.text), 'text/plain')
      return { ref, contentType: 'text/plain', description: `text, ${block.text.length.toLocaleString()} chars` }
    }
    if (block instanceof JsonBlock) {
      const jsonStr = JSON.stringify(block.json, null, 2)
      const jsonBytes = new TextEncoder().encode(jsonStr)
      const ref = await storeContent(storage, key, jsonBytes, 'application/json')
      return { ref, contentType: 'application/json', description: `json, ${jsonBytes.length.toLocaleString()} bytes` }
    }
    if (block instanceof ImageBlock || block instanceof VideoBlock || block instanceof DocumentBlock) {
      const bytes = getBytes(block)
      const contentType =
        block instanceof ImageBlock
          ? `image/${block.format}`
          : block instanceof VideoBlock
            ? `video/${block.format}`
            : `application/${block.format}`
      const label = block instanceof DocumentBlock ? block.name : contentType
      if (bytes) {
        const ref = await storeContent(storage, key, bytes, contentType)
        return { ref, contentType, description: `${label}, ${bytes.length.toLocaleString()} bytes` }
      }
      return { ref: '', contentType, description: `${label}, 0 bytes` }
    }
    logger.warn('unsupported content block type encountered during offloading, skipping')
    return { ref: '', contentType: 'unknown', description: 'unknown block type' }
  }

  private _buildPreviewText(
    content: ToolResultContent[],
    references: Array<{ ref: string; description: string }>,
    tokenCount: number,
    fullText: string
  ): string {
    const preview = fullText ? slicePreview(fullText, this._previewTokens) : ''
    const refLines = references
      .filter((r) => r.ref)
      .map((r) => `  ${r.ref} (${r.description})`)
      .join('\n')

    let guidance =
      'Tool result was offloaded to external storage due to size.\n' +
      'Use the preview below if it answers your question.\n'
    if (this._includeRetrievalTool) {
      guidance +=
        'If you need more detail, use retrieve_offloaded_content with a reference and:\n' +
        '  - pattern: regex or keyword to find matching lines with context\n' +
        '  - line_range: { start, end } to read a specific span of lines\n' +
        'Retrieve full content (omit pattern/line_range) as a last resort.'
    } else {
      guidance += 'If you need more detail, use your available tools to access specific data.'
    }

    return (
      `[Offloaded: ${content.length} blocks, ~${tokenCount.toLocaleString()} tokens]\n` +
      `${guidance}\n\n` +
      `${preview}\n\n` +
      `[Stored references:]\n${refLines}`
    )
  }

  private async _handleToolResult(event: AfterToolCallEvent): Promise<void> {
    if (event.result.status === 'error') return

    // Skip delegation tool results — their content is the final delegated answer
    // and must not be truncated/offloaded. The delegation plugin transforms this
    // result into the AgentResult.lastMessage, so offloading would replace the
    // final answer with an unrecoverable placeholder.
    if (event.tool instanceof AgentAsTool && event.tool.delegate) return

    // Skip results from the retrieval tool to prevent circular offloading
    if (this._includeRetrievalTool && event.toolUse.name === RETRIEVAL_TOOL_NAME) return

    const content = event.result.content
    const toolUseId = event.result.toolUseId

    const tokenCount = await event.agent.model.countTokens([new Message({ role: 'user', content: [event.result] })])

    if (tokenCount <= this._maxResultTokens) return

    // Extract text preview from text/JSON blocks
    const textParts: string[] = []
    for (const block of content) {
      if (block instanceof TextBlock && block.text) textParts.push(block.text)
      else if (block instanceof JsonBlock) textParts.push(JSON.stringify(block.json, null, 2))
    }
    const fullText = textParts.join('\n')

    // Store each content block to the storage backend
    let references: Array<{ ref: string; contentType: string; description: string }>
    try {
      const storage = this._storageForAgent(event.agent)
      references = await Promise.all(content.map((block, i) => this._storeBlock(storage, block, `${toolUseId}_${i}`)))
      if (!isOffloaderStorage(storage)) {
        const storedAt = event.agent.metrics.cycleCount
        for (const entry of references) {
          if (entry.ref) this._keyStoredAt.set(entry.ref, storedAt)
        }
      }
    } catch (err) {
      logger.warn(`tool_use_id=<${toolUseId}> | failed to offload tool result, keeping original`, err)
      return
    }
    logger.debug(
      `tool_use_id=<${toolUseId}>, blocks=<${references.length}>, tokens=<${tokenCount}> | tool result offloaded`
    )

    // Build replacement content: preview text + media placeholders
    const newContent: ToolResultContent[] = [
      new TextBlock(this._buildPreviewText(content, references, tokenCount, fullText)),
    ]
    for (let i = 0; i < content.length; i++) {
      const block = content[i]!
      const ref = references[i]?.ref ?? ''
      if (block instanceof TextBlock || block instanceof JsonBlock) continue

      const bytes = getBytes(block)
      const size = bytes ? bytes.length : 0
      let label: string | undefined
      if (block instanceof ImageBlock) label = `image: ${block.format}`
      else if (block instanceof VideoBlock) label = `video: ${block.format}`
      else if (block instanceof DocumentBlock) label = `document: ${block.format}, ${block.name}`
      if (label) {
        newContent.push(new TextBlock(`[${label}, ${size} bytes${ref ? ` | ref: ${ref}` : ''}]`))
      }
    }

    event.result = new ToolResultBlock({
      toolUseId: event.result.toolUseId,
      status: event.result.status,
      content: newContent,
    })
  }
}

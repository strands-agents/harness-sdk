/**
 * Offload targets: which blocks and messages a strategy acts on.
 */

import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import type { ContentBlock } from '../../../types/messages.js'
import type { AudioBlock, DocumentBlock, ImageBlock, VideoBlock } from '../../../types/media.js'

/**
 * Target for offload operations. This union is intentionally extensible — new
 * string-literal members can be added freely as new content categories emerge.
 *
 * - `"toolResults"` — all successful tool result blocks
 * - `"toolResultErrors"` — all failed tool result blocks
 * - `"assistantText"` — text blocks in assistant messages
 * - `"userText"` — text blocks in user messages (excluding tool results)
 * - `"media"` — image, document, video, and audio blocks outside tool results
 * - `string[]` — tool results from tools to include (e.g. `['bash']` or `['tool::bash']`) and, prefixed with `!`, tools
 *   to exclude. A list of only exclusions acts on every other tool.
 * - `"*"` — whole messages
 *
 * @experimental
 */
export type OffloadTarget = '*' | 'toolResults' | 'toolResultErrors' | 'assistantText' | 'userText' | 'media' | string[]

type MediaBlock = ImageBlock | DocumentBlock | VideoBlock | AudioBlock

const MEDIA_KINDS: Partial<Record<ContentBlock['type'], string>> = {
  imageBlock: 'image',
  documentBlock: 'document',
  videoBlock: 'video',
  audioBlock: 'audio',
}

const TOOL_PREFIX = 'tool::'

/**
 * Whether a block is an image, document, video, or audio block.
 *
 * @internal
 */
export function isMediaBlock(block: ContentBlock): block is MediaBlock {
  return mediaKind(block) !== undefined
}

/**
 * The media kind of a block, such as `'image'`, for markers, or undefined when it is not media.
 *
 * @internal
 */
export function mediaKind(block: ContentBlock): string | undefined {
  return MEDIA_KINDS[block.type]
}

/**
 * Builds a toolUseId → toolName map from all assistant messages in the conversation.
 * Called once per apply() to avoid O(messages × toolResults) scanning.
 *
 * @internal
 */
export function buildToolNameMap(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block instanceof ToolUseBlock) {
        map.set(block.toolUseId, block.name)
      }
    }
  }
  return map
}

/**
 * Matches blocks and messages against an {@link OffloadTarget}. A `string[]` target's tool names
 * are parsed once, here.
 *
 * @internal
 */
export class OffloadTargetMatcher {
  /** The target as the strategy was built with it. */
  readonly target: OffloadTarget | undefined

  private readonly _include: Set<string> | undefined
  private readonly _exclude: Set<string> | undefined

  /**
   * @param target - The offload target
   * @throws Error when the target is an empty array or excludes every tool it includes
   */
  constructor(target: OffloadTarget | undefined) {
    if (Array.isArray(target) && target.length === 0) {
      throw new Error('Empty array target matches nothing — provide at least one target')
    }
    const filter = resolveToolFilter(target)
    if (filter.include?.size === 0) {
      throw new Error(`Tool target ${JSON.stringify(target)} excludes every tool it includes, so it matches nothing`)
    }
    this.target = target
    this._include = filter.include
    this._exclude = filter.exclude
  }

  /** Whether every kind of block is in scope: `'*'`, or no target. */
  get matchesAll(): boolean {
    return this.target === undefined || this.target === '*'
  }

  /** Whether a block in `message` is one this target covers. */
  matchesBlock(block: ContentBlock, message: Message, toolNameMap: Map<string, string>): boolean {
    if (block instanceof TextBlock) return this._matchesText(message)
    if (block instanceof ToolResultBlock) return this._matchesToolResult(block, toolNameMap)
    return this.matchesAll || (this.target === 'media' && isMediaBlock(block))
  }

  /** Whether a message holds anything this target covers. */
  matchesMessage(message: Message, toolNameMap: Map<string, string>): boolean {
    return this.matchesAll || message.content.some((block) => this.matchesBlock(block, message, toolNameMap))
  }

  private _matchesText(message: Message): boolean {
    if (this.matchesAll) return true
    if (this.target === 'assistantText') return message.role === 'assistant'
    if (this.target === 'userText') return message.role === 'user'
    return false
  }

  private _matchesToolResult(block: ToolResultBlock, toolNameMap: Map<string, string>): boolean {
    if (this.matchesAll) return true
    if (this.target === 'toolResults') return block.status === 'success'
    if (this.target === 'toolResultErrors') return block.status === 'error'

    const toolName = toolNameMap.get(block.toolUseId)
    if (!toolName) return false
    if (this._include) return this._include.has(toolName)
    if (this._exclude) return !this._exclude.has(toolName)
    return false
  }
}

/**
 * Parses a `string[]` target into include/exclude tool-name sets. Entries may be prefixed with `tool::`
 * (e.g. `'tool::bash'`); an additional `!` prefix excludes (e.g. `'!tool::bash'`). A list with includes keeps the
 * includes minus the excludes.
 */
function resolveToolFilter(target: OffloadTarget | undefined): { include?: Set<string>; exclude?: Set<string> } {
  if (!Array.isArray(target)) return {}

  const includes: string[] = []
  const excludes = new Set<string>()
  for (const entry of target) {
    const excluded = entry.startsWith('!')
    const name = excluded ? entry.slice(1) : entry
    const toolName = name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name
    if (excluded) excludes.add(toolName)
    else includes.push(toolName)
  }

  if (includes.length > 0) return { include: new Set(includes.filter((name) => !excludes.has(name))) }
  if (excludes.size > 0) return { exclude: excludes }
  return {}
}

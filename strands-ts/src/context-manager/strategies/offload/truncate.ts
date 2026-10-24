/**
 * Truncate strategy — replaces oversized content with a preview.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { Message, TextBlock, ToolResultBlock } from '../../../types/messages.js'
import type { ContentBlock } from '../../../types/messages.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { InvocationContext } from '../../../agent/invocation-context.js'
import type { ContextStrategy } from '../../types.js'
import {
  isTruncatedText,
  truncateToolResultBlock,
  truncateTextBlock,
  type TruncateConfig,
} from '../../methods/truncate.js'
import { formatStashRefs } from '../../stash.js'
import { BaseOffloadStrategy, type OffloadConditions, type OffloadTarget } from './base.js'

export class TruncateStrategy extends BaseOffloadStrategy {
  readonly name = 'offload:truncate'

  private readonly _truncateConfig: TruncateConfig

  constructor(target?: OffloadTarget, config?: TruncateConfig, conditions?: OffloadConditions) {
    super(target, conditions)
    this._truncateConfig = config ?? {}
    const agenticLimit = this._truncateConfig.agenticLimit
    if (agenticLimit !== undefined) {
      if (!(Number.isFinite(agenticLimit) && agenticLimit > 0)) {
        throw new Error(`agenticLimit must be a positive number, got ${agenticLimit}`)
      }
      this._modelLimits = { max: agenticLimit }
    }

    const previewTokens =
      typeof this._truncateConfig.previewTokens === 'number' && Number.isFinite(this._truncateConfig.previewTokens)
        ? this._truncateConfig.previewTokens
        : 1000
    if (
      conditions?.threshold !== undefined &&
      Number.isFinite(conditions.threshold) &&
      conditions.threshold <= previewTokens
    ) {
      throw new Error(
        `threshold (${conditions.threshold}) must be greater than previewTokens (${previewTokens}) to ensure truncation converges`
      )
    }
  }

  when(conditions: OffloadConditions): ContextStrategy {
    return new TruncateStrategy(this._target, this._truncateConfig, conditions)
  }

  /** The cap on model-selected result limits, or undefined when the model may not pick one. */
  get agenticLimit(): number | undefined {
    return this._modelLimits?.max
  }

  /** Whether results of the named tool fall under this strategy's target. */
  targetsTool(toolName: string): boolean {
    if (this._target === 'assistantText' || this._target === 'userText') return false
    if (this._excludeFilter) return !this._excludeFilter.has(toolName)
    if (this._includeFilter) return this._includeFilter.has(toolName)
    return true
  }

  protected override _makeRemovalMarker(count: number): string {
    return `[... ${count} ${count === 1 ? 'message' : 'messages'} elided ...]`
  }

  protected async _replaceBlock(
    block: ContentBlock,
    tokens: number,
    message: Message,
    _agent: LocalAgent,
    stashRefs: string[],
    _invocationContext?: InvocationContext,
    limit?: number
  ): Promise<ContentBlock | null> {
    if (block instanceof ToolResultBlock) {
      // With a model limit, threshold == preview, so an existing preview (plus its header) can sit just
      // above the limit; leave it alone rather than shaving it on every pass.
      if (limit !== undefined && isTruncated(block)) return block
      logger.debug(`toolUseId=<${block.toolUseId}>, tokens=<${tokens}>, limit=<${limit}> | truncated tool result`)
      const config = limit === undefined ? this._truncateConfig : { ...this._truncateConfig, previewTokens: limit }
      const truncated = truncateToolResultBlock(block, config)
      if (truncated !== block) {
        return appendStashRefs(truncated, stashRefs)
      }
      return truncated
    }
    if (block instanceof TextBlock) {
      logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | truncated text block`)
      const truncated = truncateTextBlock(block, this._truncateConfig)
      const refs = formatStashRefs(stashRefs)
      return refs ? new TextBlock(`${truncated.text}\n\n[Stashed]${refs}`) : truncated
    }
    logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | offloaded media block`)
    return new TextBlock(`[Offloaded: ~${tokens} tokens]${formatStashRefs(stashRefs)}`)
  }
}

function isTruncated(block: ToolResultBlock): boolean {
  const text = block.content[0]
  return text instanceof TextBlock && isTruncatedText(text.text)
}

function appendStashRefs(block: ToolResultBlock, stashRefs: string[]): ToolResultBlock {
  const refs = formatStashRefs(stashRefs)
  if (!refs) return block

  const content = [...block.content]
  for (let index = 0; index < content.length; index++) {
    const item = content[index]!
    if (item instanceof TextBlock) {
      content[index] = new TextBlock(`${item.text}\n\n[Stashed]${refs}`)
      return new ToolResultBlock({
        toolUseId: block.toolUseId,
        status: block.status,
        content,
      })
    }
  }
  return block
}

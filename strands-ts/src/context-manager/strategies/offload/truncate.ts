/**
 * Truncate strategy — replaces oversized content with a preview.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { isOffloaded, Message, TextBlock, ToolResultBlock } from '../../../types/messages.js'
import type { ContentBlock } from '../../../types/messages.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ContextState } from '../../types.js'
import {
  PREVIEW_HEAD_SHARE,
  resolvePreviewTokens,
  truncateToolResultBlock,
  truncateTextBlock,
  type TruncateConfig,
} from '../../methods/truncate.js'
import type { Stash } from '../../stash.js'
import { withPairs } from '../../message-trimming.js'
import { formatElided, formatOffloaded } from '../../placeholder.js'
import { BaseOffloadStrategy, removeMessages } from './base.js'
import type { OffloadConditions } from './conditions.js'
import { mediaKind, type OffloadTarget } from './target.js'

export class TruncateStrategy extends BaseOffloadStrategy {
  private readonly _truncateConfig: TruncateConfig
  private readonly _previewTokens: number

  constructor(target: OffloadTarget, config?: TruncateConfig, conditions?: OffloadConditions) {
    super('truncate', target, conditions)
    this._truncateConfig = config ?? {}
    this._previewTokens = resolvePreviewTokens(this._truncateConfig)

    // Every message over a threshold is larger than previewTokens, so middle-out would elide them all, as drop does.
    if (target === '*' && this._conditions.blockThreshold) {
      throw new Error(
        "Offload.truncate('*') doesn't take a blockThreshold; use Offload.drop('*') to remove large messages, or Offload.truncate('toolResults') to preview large blocks"
      )
    }
    // A percent needs the context window, so init checks it.
    const threshold = this._conditions.blockThreshold
    if (threshold && !threshold.isShare) this._checkThresholdExceedsPreview(threshold.value, String(threshold.value))
  }

  when(conditions: OffloadConditions = {}): TruncateStrategy {
    return new TruncateStrategy(this._target, this._truncateConfig, conditions)
  }

  /**
   * Checks a percent blockThreshold against `previewTokens`, then initializes the strategy.
   *
   * @param agent - The agent this strategy is attached to
   * @param stash - The stash offloaded content is stored in
   * @throws Error when a percent `blockThreshold` of the context window is no larger than `previewTokens`, or the
   *   base strategy's conditions can't run on this agent
   */
  override init(agent: LocalAgent, stash?: Stash): void {
    if (this._conditions.blockThreshold?.isShare) {
      const tokens = this._conditions.thresholdTokens(agent)!
      this._checkThresholdExceedsPreview(tokens, `${tokens} tokens of the context window`)
    }
    super.init(agent, stash)
  }

  private _checkThresholdExceedsPreview(tokens: number, shown: string): void {
    if (tokens > this._previewTokens) return
    throw new Error(
      `blockThreshold (${shown}) must be greater than previewTokens (${this._previewTokens}) to ensure truncation converges; raise blockThreshold or lower previewTokens`
    )
  }

  /** Middle-out: keeps the oldest and newest eligible messages within the preview budget and elides the rest. */
  protected async _applyPerMessage(context: ContextState): Promise<boolean> {
    const { messages, agent } = context
    const middle = withPairs(messages, await this._selectMiddle(await this._getEligibleMessages(context), agent))
    // A middle of only earlier markers has nothing new to elide.
    if (middle.every((message) => message.content.every(isElisionMarker))) return false
    const text = async (_removed: Message[], count: number): Promise<string> => formatElided(count)
    return removeMessages(messages, middle, text, 'truncate', this._stash)
  }

  protected async _replaceBlock(
    block: ContentBlock,
    tokens: number,
    message: Message,
    _agent: LocalAgent,
    stashRef: string | undefined
  ): Promise<ContentBlock | null> {
    if (block instanceof ToolResultBlock) {
      const truncated = truncateToolResultBlock(block, this._truncateConfig)
      if (!truncated) return null
      logger.debug(`toolUseId=<${block.toolUseId}>, tokens=<${tokens}> | truncated tool result`)
      return block.withContent([this._placeholder(truncated.preview, stashRef), ...truncated.kept])
    }
    if (block instanceof TextBlock) {
      const truncated = truncateTextBlock(block, this._truncateConfig)
      if (truncated === block) return null
      logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | truncated text block`)
      return this._placeholder(truncated.text, stashRef)
    }
    logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | offloaded media block`)
    return this._placeholder(formatOffloaded(tokens, mediaKind(block)), stashRef)
  }

  /** The eligible messages between the head and tail kept within the preview token budget. */
  private async _selectMiddle(eligible: Message[], agent: LocalAgent): Promise<Message[]> {
    const headBudget = this._previewTokens * PREVIEW_HEAD_SHARE[this._truncateConfig.preview ?? 'headTail']
    const headCount = await countWithinBudget(eligible, headBudget, agent)
    const rest = eligible.slice(headCount)
    const tailCount = await countWithinBudget([...rest].reverse(), this._previewTokens - headBudget, agent)
    return rest.slice(0, rest.length - tailCount)
  }
}

/** Whether a block is the marker truncate left where it elided messages; other methods' markers don't count. */
function isElisionMarker(block: ContentBlock): boolean {
  return (
    isOffloaded(block) &&
    block.metadata.offloaded.method === 'truncate' &&
    block.metadata.offloaded.removedMessages !== undefined
  )
}

/** How many leading messages fit within `budget` tokens. */
async function countWithinBudget(messages: Message[], budget: number, agent: LocalAgent): Promise<number> {
  let total = 0
  let count = 0
  for (const message of messages) {
    total += await agent.model.countTokens([message])
    if (total > budget) break
    count++
  }
  return count
}

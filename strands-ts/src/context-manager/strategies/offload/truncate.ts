/**
 * Truncate strategy — replaces oversized content with a preview.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import type { ContentBlock } from '../../../types/messages.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { InvocationContext } from '../../../agent/invocation-context.js'
import type { JSONSchema } from '../../../types/json.js'
import { BeforeToolCallEvent } from '../../../hooks/events.js'
import { HookOrder } from '../../../hooks/types.js'
import { InvokeModelStage } from '../../../middleware/index.js'
import { addInputProperty } from '../../../tools/input-schema.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../../tools/structured-output-tool.js'
import { MANAGE_TOOL_NAME } from '../../../background-tasks/types.js'
import { DEFAULT_CONTEXT_WINDOW_LIMIT } from '../../../models/defaults.js'
import type { ContextStrategy } from '../../types.js'
import type { Stash } from '../../stash.js'
import {
  DEFAULT_PREVIEW_TOKENS,
  TRUNCATED_HEADER,
  truncateToolResultBlock,
  truncateTextBlock,
  type TruncateConfig,
} from '../../methods/truncate.js'
import { formatStashRefs } from '../../stash.js'
import { RETRIEVAL_TOOL_NAME } from '../../retrieval-tool.js'
import { pinContextTool, summarizeContextTool, truncateContextTool } from '../../modes/agentic/agentic-context.js'
import { BaseOffloadStrategy, type OffloadConditions, type OffloadTarget } from './base.js'

/**
 * Backstop for `dynamicLimit: true`: large enough to rarely bind, but no single result can fill
 * the window. Not tuned against benchmarks.
 */
const DYNAMIC_LIMIT_WINDOW_SHARE = 0.5

/**
 * Tool input property through which the model picks a per-call result token limit.
 *
 * @internal
 */
export const RESULT_LIMIT_PROPERTY = '_max_result_tokens'

/**
 * Reads the model-selected result token limit from a tool-use input.
 *
 * @param input - The tool-use input as emitted by the model
 * @returns The non-negative integer limit, or undefined when absent or invalid
 * @internal
 */
export function readResultLimit(input: unknown): number | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  const value = (input as Record<string, unknown>)[RESULT_LIMIT_PROPERTY]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

/**
 * Builds a toolUseId → model-selected result token limit map from the tool-use inputs in
 * assistant messages.
 *
 * @param messages - The conversation to scan
 * @param maxTokens - Upper bound the model may not exceed; larger values are clamped to it
 * @returns Limits keyed by toolUseId; calls without a valid limit are absent
 * @internal
 */
export function buildResultLimitMap(messages: Message[], maxTokens: number): Map<string, number> {
  const map = new Map<string, number>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (!(block instanceof ToolUseBlock)) continue
      const limit = readResultLimit(block.input)
      if (limit !== undefined) map.set(block.toolUseId, Math.min(limit, maxTokens))
    }
  }
  return map
}

// Tools whose results are never truncated, or are not produced by a model-issued call.
const RESULT_LIMIT_EXEMPT_TOOLS = new Set([
  RETRIEVAL_TOOL_NAME,
  STRUCTURED_OUTPUT_TOOL_NAME,
  MANAGE_TOOL_NAME,
  summarizeContextTool.name,
  truncateContextTool.name,
  pinContextTool.name,
])

export class TruncateStrategy extends BaseOffloadStrategy {
  readonly name = 'offload:truncate'

  private readonly _truncateConfig: TruncateConfig
  private readonly _dynamicLimit: true | number | undefined
  private readonly _previewTokens: number

  constructor(target?: OffloadTarget, config?: TruncateConfig, conditions?: OffloadConditions) {
    super(target, conditions)
    this._truncateConfig = config ?? {}
    const dynamicLimit = this._truncateConfig.dynamicLimit
    if (dynamicLimit !== undefined && dynamicLimit !== true && !(Number.isFinite(dynamicLimit) && dynamicLimit > 0)) {
      throw new Error(`dynamicLimit must be true or a positive number, got ${dynamicLimit}`)
    }
    this._dynamicLimit = dynamicLimit

    this._previewTokens =
      typeof this._truncateConfig.previewTokens === 'number' && Number.isFinite(this._truncateConfig.previewTokens)
        ? this._truncateConfig.previewTokens
        : DEFAULT_PREVIEW_TOKENS
    if (this._threshold !== undefined && this._threshold <= this._previewTokens) {
      throw new Error(
        `threshold (${conditions?.threshold}) must be greater than previewTokens (${this._previewTokens}) to ensure truncation converges`
      )
    }
  }

  when(conditions: OffloadConditions): ContextStrategy {
    return new TruncateStrategy(this._target, this._truncateConfig, conditions)
  }

  override init(agent: LocalAgent, stash?: Stash): void {
    super.init(agent, stash)
    if (this._dynamicLimit) this._registerResultLimitSelection(agent)
  }

  protected override _resultLimits(messages: Message[], agent: LocalAgent): ReadonlyMap<string, number> | undefined {
    return this._dynamicLimit ? buildResultLimitMap(messages, this._dynamicLimitCap(agent)) : undefined
  }

  /** The largest result limit the model may pick. A falsy window falls back to the default, like `estimateUtilization`. */
  private _dynamicLimitCap(agent: LocalAgent): number {
    if (typeof this._dynamicLimit === 'number') return this._dynamicLimit
    const window = agent.model.getConfig().contextWindowLimit || DEFAULT_CONTEXT_WINDOW_LIMIT
    return Math.floor(window * DYNAMIC_LIMIT_WINDOW_SHARE)
  }

  /** Advertises `_max_result_tokens` on the tools this strategy targets and strips it before the tool runs. */
  private _registerResultLimitSelection(agent: LocalAgent): void {
    agent.addMiddleware(InvokeModelStage.Input, async (context) => {
      const retrievable = context.toolSpecs.some((spec) => spec.name === RETRIEVAL_TOOL_NAME)
      // Models rarely set this on description alone; stating the default and when to raise it is what moves uptake.
      const schema: JSONSchema = {
        type: 'integer',
        minimum: 0,
        maximum: this._dynamicLimitCap(agent),
        description:
          `Token budget for this call's result. By default, results over ${this._threshold ?? this._previewTokens} tokens ` +
          `are cut to a ~${this._previewTokens}-token preview` +
          (retrievable ? ' and the full content is stashed for retrieval' : '') +
          '. Set a higher value when you need the complete output in one call (e.g. a whole file, every match), ' +
          'or a lower one when a glance is enough.',
      }
      return {
        ...context,
        toolSpecs: context.toolSpecs.map((spec) =>
          RESULT_LIMIT_EXEMPT_TOOLS.has(spec.name) || !this._targetsTool(spec.name)
            ? spec
            : (addInputProperty(spec, RESULT_LIMIT_PROPERTY, schema) ?? spec)
        ),
      }
    })
    agent.addHook(
      BeforeToolCallEvent,
      (event) => {
        const input = event.toolUse.input
        if (input === null || typeof input !== 'object' || Array.isArray(input) || !(RESULT_LIMIT_PROPERTY in input)) {
          return
        }
        // A tool that declares the property itself owns it; leave its input alone.
        if (event.tool?.toolSpec.inputSchema?.properties?.[RESULT_LIMIT_PROPERTY] !== undefined) return
        const { [RESULT_LIMIT_PROPERTY]: value, ...rest } = input
        if (readResultLimit(input) === undefined) {
          logger.debug(
            `toolUseId=<${event.toolUse.toolUseId}>, value=<${JSON.stringify(value)}> | ignoring invalid ${RESULT_LIMIT_PROPERTY}`
          )
        }
        event.toolUse = { ...event.toolUse, input: rest }
      },
      { order: HookOrder.SDK_FIRST }
    )
  }

  /** Whether results of the named tool fall under this strategy's target. */
  private _targetsTool(toolName: string): boolean {
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
    agent: LocalAgent,
    stashRefs: string[],
    _invocationContext?: InvocationContext,
    limit?: number
  ): Promise<ContentBlock | null> {
    if (block instanceof ToolResultBlock) {
      // With a model limit, threshold == preview, so an existing preview (plus its header) can sit just
      // above the limit; leave it alone rather than shaving it on every pass.
      const first = block.content[0]
      const alreadyTruncated = first instanceof TextBlock && TRUNCATED_HEADER.test(first.text)
      if (limit !== undefined && alreadyTruncated) return block
      logger.debug(`toolUseId=<${block.toolUseId}>, tokens=<${tokens}>, limit=<${limit}> | truncated tool result`)
      const config = limit === undefined ? this._truncateConfig : { ...this._truncateConfig, previewTokens: limit }
      const truncated = truncateToolResultBlock(block, config)
      if (truncated === block) return truncated
      const refs = formatStashRefs(stashRefs)
      const notes = [refs && `[Stashed]${refs}`]
      // Wording is load-bearing: "…: N … keep this result whole" read as status and halved uptake in evals.
      if (this._dynamicLimit && limit === undefined && !alreadyTruncated) {
        const suggested = Math.min(Math.ceil(tokens / 1000) * 1000, this._dynamicLimitCap(agent))
        notes.push(`[Set ${RESULT_LIMIT_PROPERTY} on the call (e.g. ${suggested}) to keep more of this result]`)
      }
      return appendNotes(truncated, notes.filter(Boolean).join('\n'))
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

function appendNotes(block: ToolResultBlock, notes: string): ToolResultBlock {
  if (!notes) return block

  const content = [...block.content]
  for (let index = 0; index < content.length; index++) {
    const item = content[index]!
    if (item instanceof TextBlock) {
      content[index] = new TextBlock(`${item.text}\n\n${notes}`)
      return new ToolResultBlock({
        toolUseId: block.toolUseId,
        status: block.status,
        content,
      })
    }
  }
  return block
}

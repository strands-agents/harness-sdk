import {
  InvokeModelStage,
  Message,
  Model,
  type Agent,
  type ContentBlock,
  type InvokeModelContext,
} from '@strands-agents/sdk'

import type { ChatContextBreakdown, ChatContextUsage } from './chat/types.js'
import { normalizeUsage } from '../usage.js'

type ContextKind = ChatContextBreakdown['categories'][number]['kind']
type ContextEstimates = Record<ContextKind, number>

const CONTEXT_KINDS: readonly ContextKind[] = [
  'systemPrompt',
  'tools',
  'userMessages',
  'assistantMessages',
  'toolResults',
  'injectedContext',
  'other',
]

interface CapturedContext {
  estimates: ContextEstimates
  inputTokens: number
  outputTokens: number
}

/** Observes effective model inputs after prompt middleware, retaining only token estimates. */
export class ContextBreakdownCapture {
  private _agent: Agent | undefined
  private _cleanup: (() => void) | undefined
  private _latest: CapturedContext | undefined

  beforeModelCall(agent: Agent): void {
    this._latest = undefined
    if (this._agent === agent) return
    this._cleanup?.()
    this._agent = agent
    const capture = (value: CapturedContext | undefined): void => {
      this._latest = value
    }
    this._cleanup = agent.addMiddleware(InvokeModelStage.Wrap, async function* (context, next) {
      capture(undefined)
      const estimates = await estimateContext(context).catch(() => undefined)
      const response = yield* next(context)
      const usage = response.result.metadata?.usage
      const normalized = usage && normalizeUsage(context.model, usage)
      if (estimates && normalized?.inputTokens !== undefined && normalized.outputTokens !== undefined) {
        capture({
          estimates,
          inputTokens: normalized.inputTokens,
          outputTokens: normalized.outputTokens,
        })
      }
      return response
    })
  }

  breakdown(context: ChatContextUsage | undefined): ChatContextBreakdown | undefined {
    const latest = this._latest
    const input = context?.currentTokens
    const occupied = context?.projectedTokens ?? input
    if (
      !latest ||
      input === undefined ||
      occupied === undefined ||
      !Number.isSafeInteger(input) ||
      !Number.isSafeInteger(occupied) ||
      input < 0 ||
      occupied < input ||
      input !== latest.inputTokens ||
      occupied - input !== latest.outputTokens
    ) {
      return undefined
    }
    const estimated = CONTEXT_KINDS.reduce((sum, kind) => sum + latest.estimates[kind], 0)
    const scale = estimated > input ? input / estimated : 1
    const categories = CONTEXT_KINDS.map((kind) => ({
      kind,
      tokens: Math.floor(latest.estimates[kind] * scale),
    }))
    const assigned = categories.reduce((sum, category) => sum + category.tokens, 0)
    categories.find((category) => category.kind === 'other')!.tokens += input - assigned
    categories.find((category) => category.kind === 'assistantMessages')!.tokens += occupied - input
    return { categories: categories.filter((category) => category.tokens > 0) }
  }

  dispose(): void {
    this._cleanup?.()
    this._cleanup = undefined
    this._agent = undefined
    this._latest = undefined
  }
}

async function estimateContext(context: InvokeModelContext): Promise<ContextEstimates> {
  const blocks: Record<ContextKind, ContentBlock[]> = {
    systemPrompt: [],
    tools: [],
    userMessages: [],
    assistantMessages: [],
    toolResults: [],
    injectedContext: [],
    other: [],
  }
  const lastIndex = context.messages.length - 1
  for (const [messageIndex, message] of context.messages.entries()) {
    const injectionStart =
      messageIndex === lastIndex && message.role === 'user'
        ? message.content.length - (context.dynamicTrailingBlocks ?? 0)
        : message.content.length
    for (const [blockIndex, block] of message.content.entries()) {
      const kind =
        blockIndex >= injectionStart
          ? 'injectedContext'
          : block.type === 'toolResultBlock'
            ? 'toolResults'
            : message.role === 'assistant'
              ? 'assistantMessages'
              : 'userMessages'
      blocks[kind].push(block)
    }
  }

  const entries = await Promise.all(
    CONTEXT_KINDS.map(async (kind): Promise<readonly [ContextKind, number]> => {
      const messages = blocks[kind].length > 0 ? [new Message({ role: 'user', content: blocks[kind] })] : []
      // The base implementation is local; provider overrides may send token-count requests.
      const tokens = await Model.prototype.countTokens.call(context.model, messages, {
        ...(kind === 'systemPrompt' && context.systemPrompt !== undefined && { systemPrompt: context.systemPrompt }),
        ...(kind === 'tools' && { toolSpecs: [...context.toolSpecs] }),
      })
      return [kind, tokens]
    })
  )
  return Object.fromEntries(entries) as ContextEstimates
}

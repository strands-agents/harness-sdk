import { unwrapInvocationContext, type InvocationContext } from '../agent/invocation-context.js'
import { logger } from '../logging/logger.js'
import { warnOnce } from '../logging/warn-once.js'
import { Message, TextBlock, type ContentBlock } from '../types/messages.js'
import type { CountTokensOptions, Model, StreamAggregatedResult, StreamOptions } from './model.js'
import type { ModelStreamEvent } from './streaming.js'

/**
 * SDK-internal wrapper that sends a model call's messages in the form models accept and
 * adds the call's token usage to its request. The agent loop and every auxiliary call
 * route their model calls through it. The {@link InvocationContext} is passed per call
 * rather than on {@link StreamOptions}, so providers never see request state. Usage is
 * added only when the call returns normally and the provider reported it; a thrown error
 * passes through and adds nothing.
 *
 * An `InjectedBlock` reaches a model whose `modelInfo.capabilities.temporaryMessages` is set as it is
 * stored, and that provider sends it so the model reads it only until the next user message. Every
 * other model, custom ones included, gets the latest user message's injected blocks as text and none
 * of the earlier ones.
 *
 * @internal
 */
export class ModelProxy {
  private readonly _model: Model

  constructor(model: Model) {
    this._model = model
  }

  /**
   * Delegates to the wrapped model's `streamAggregated` with the messages the model accepts,
   * passing every event through unchanged, then adds the call's usage to the request.
   *
   * @param messages - The conversation history to send to the model
   * @param options - Optional streaming configuration
   * @param invocationContext - The request to add the usage to, or `undefined` to add it nowhere
   * @returns Async generator mirroring {@link Model.streamAggregated}
   */
  async *streamAggregated(
    messages: Message[],
    options?: StreamOptions,
    invocationContext?: InvocationContext
  ): AsyncGenerator<ModelStreamEvent | ContentBlock, StreamAggregatedResult, undefined> {
    const { messages: prepared, dynamicTrailingBlocks } = this._prepare(messages)
    // The cache point stays ahead of injected text, which the next call no longer sends.
    const keepsCachePoint = dynamicTrailingBlocks > (options?.dynamicTrailingBlocks ?? 0)
    const result = yield* this._model.streamAggregated(
      prepared,
      keepsCachePoint ? { ...options, dynamicTrailingBlocks } : options
    )
    this._record(result, invocationContext)
    return result
  }

  /**
   * Delegates to the wrapped model's `countTokens` with the messages {@link streamAggregated} would send.
   *
   * @param messages - The messages to count
   * @param options - Optional system prompt and tool specs to count with them
   * @returns The wrapped model's count
   */
  countTokens(messages: Message[], options?: CountTokensOptions): Promise<number> {
    return this._model.countTokens(this._prepare(messages).messages, options)
  }

  private _prepare(messages: Message[]): RenderedMessages {
    if (!messages.some(hasInjectedBlock) || this._model.modelInfo.capabilities?.temporaryMessages === true) {
      return { messages, dynamicTrailingBlocks: 0 }
    }
    return renderInjectedBlocks(messages)
  }

  /** Adds a completed call's reported usage to the request. */
  private _record(result: StreamAggregatedResult, invocationContext?: InvocationContext): void {
    const usage = result?.metadata?.usage
    const context = unwrapInvocationContext(invocationContext)
    if (usage !== undefined && context !== undefined) {
      context.recordUsage(usage)
    }
  }
}

interface RenderedMessages {
  /** The messages to send. */
  messages: Message[]
  /** Trailing blocks of the last message, from its first injected block on, that the next call sends differently. */
  dynamicTrailingBlocks: number
}

/**
 * Returns the messages as a model without temporary messages receives them. The latest user message's
 * injected blocks become text blocks in their place, and every other injected block is left out. Messages
 * without an injected block are returned as they are, and the input is never changed.
 *
 * Some providers join adjacent text blocks, so the injected text is kept apart from the text
 * around it. The separator always goes on the later of the two blocks: a block is sent the same
 * way however much content is added after it.
 *
 * @param messages - The messages of a model call
 * @returns The messages to send, and how many trailing blocks the cache point must stay ahead of
 */
function renderInjectedBlocks(messages: Message[]): RenderedMessages {
  const latestUser = lastIndexOfRole(messages, 'user')
  let dynamicTrailingBlocks = 0
  const rendered = messages.map((message, index) => {
    if (!hasInjectedBlock(message)) return message
    if (message.role !== 'user') {
      warnOnce(logger, `role=<${message.role}> | injected block outside a user message | skipping it`)
    }
    const content = index === latestUser ? withInjectedText(message.content) : withoutInjectedBlocks(message.content)
    if (index === latestUser && index === messages.length - 1) {
      dynamicTrailingBlocks = message.content.length - message.content.findIndex(isInjectedBlock)
    }
    return new Message({
      role: message.role,
      content,
      trackingId: message.trackingId,
      ...(message.metadata !== undefined && { metadata: message.metadata }),
    })
  })
  return { messages: rendered, dynamicTrailingBlocks }
}

/** The content with each injected block as a text block in its place. */
function withInjectedText(content: ContentBlock[]): ContentBlock[] {
  const result: ContentBlock[] = []
  let previous: ContentBlock | undefined
  for (const block of content) {
    if (block.type === 'injectedBlock') {
      result.push(withSeparator(block.injected.text, result.length > 0))
    } else if (block.type === 'textBlock' && previous?.type === 'injectedBlock') {
      result.push(withSeparator(block.text, true))
    } else {
      result.push(block)
    }
    previous = block
  }
  return result
}

function withoutInjectedBlocks(content: ContentBlock[]): ContentBlock[] {
  return content.filter((block) => !isInjectedBlock(block))
}

function lastIndexOfRole(messages: Message[], role: Message['role']): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role === role) return index
  }
  return -1
}

function hasInjectedBlock(message: Message): boolean {
  return message.content.some(isInjectedBlock)
}

function isInjectedBlock(block: ContentBlock): boolean {
  return block.type === 'injectedBlock'
}

/** A text block with `"\n\n"` in front of the text when something comes before it, unless it starts with a newline. */
function withSeparator(text: string, afterContent: boolean): TextBlock {
  return new TextBlock(afterContent && !text.startsWith('\n') ? `\n\n${text}` : text)
}

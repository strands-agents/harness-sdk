import { unwrapInvocationContext, type InvocationContext } from '../agent/invocation-context.js'
import { Message, TextBlock, ToolResultBlock, type ContentBlock } from '../types/messages.js'
import { LOAD_TOOLS_TOOL_NAME } from '../tools/load-tools.js'
import { latestUserIndex } from './model.js'
import { hasToolReferences, withToolReferenceText } from './tool-references.js'
import type { ToolSpec } from '../tools/types.js'
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
 * An `InjectedBlock` reaches a model whose `modelInfo.capabilities.temporaryMessages` is `true` as it is
 * stored, and that provider sends it so the model reads it only until the next user message. Every
 * other model, custom ones included, gets the latest user message's injected blocks as text and none
 * of the earlier ones.
 *
 * Deferred tools take one of two paths, by the model's `modelInfo.capabilities.deferredTools`. With `'native'`, the
 * deferred specs and every `ToolReferenceBlock` reach the provider as they are, and the provider sends them its API's
 * way. With `'stubs'`, each deferred spec becomes a stub: its name, its description with a pointer to
 * `strands_load_tools`, and an open schema, so the model can call the tool before it loads the schema. Every model but
 * a `'native'` one gets each `ToolReferenceBlock` as the parameters of the call's tool with that name, in text.
 *
 * A tool result whose content is all `UnknownBlock`s gets a placeholder text, since providers skip unknown blocks and
 * some reject an empty tool result.
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
   * passing every event through unchanged, then adds the call's usage to the request. A model without
   * `serverSideSummary` gets each summary block's text instead of the block.
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
    const { messages: prepared, dynamicTrailingBlocks } = this._prepare(messages, options?.toolSpecs)
    // The cache point stays ahead of injected text, which the next call no longer sends.
    const keepsCachePoint = dynamicTrailingBlocks > (options?.dynamicTrailingBlocks ?? 0)
    const result = yield* this._model.streamAggregated(
      prepared,
      this._withStubs(keepsCachePoint ? { ...options, dynamicTrailingBlocks } : options)
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
    return this._model.countTokens(this._prepare(messages, options?.toolSpecs).messages, this._withStubs(options))
  }

  /** Sends each deferred spec as a stub with an open schema when the model takes stubs. */
  private _withStubs<T extends { toolSpecs?: ToolSpec[] }>(options: T | undefined): T | undefined {
    if (!options?.toolSpecs?.some((spec) => spec.deferLoading)) return options
    if (this._model.modelInfo.capabilities?.deferredTools !== 'stubs') return options
    const toolSpecs = options.toolSpecs.map((spec) =>
      spec.deferLoading
        ? { name: spec.name, description: `${spec.description} ${STUB_HINT}`, inputSchema: { type: 'object' as const } }
        : spec
    )
    return { ...options, toolSpecs }
  }

  private _prepare(messages: Message[], toolSpecs: ToolSpec[] = []): RenderedMessages {
    messages = withUnknownOnlyToolResultsFilled(this._withToolReferenceText(this._withSummaryText(messages), toolSpecs))
    if (!messages.some(hasInjectedBlock) || this._model.modelInfo.capabilities?.temporaryMessages === true) {
      return { messages, dynamicTrailingBlocks: 0 }
    }
    return renderInjectedBlocks(messages)
  }

  /** Replaces summary blocks with their text, since only a provider with server-side summaries reads them. */
  private _withSummaryText(messages: Message[]): Message[] {
    const hasSummary = messages.some((message) => message.content.some((block) => block.type === 'summaryBlock'))
    if (!hasSummary || this._model.modelInfo.capabilities?.serverSideSummary === true) return messages
    return messages.map(
      (message) =>
        new Message({
          role: message.role,
          content: message.content.map((block) => (block.type === 'summaryBlock' ? new TextBlock(block.text) : block)),
          trackingId: message.trackingId,
          ...(message.metadata !== undefined && { metadata: message.metadata }),
        })
    )
  }

  /** Sends tool references as text to a model that doesn't defer tools natively; a native provider sends them. */
  private _withToolReferenceText(messages: Message[], toolSpecs: ToolSpec[]): Message[] {
    if (!hasToolReferences(messages) || this._model.modelInfo.capabilities?.deferredTools === 'native') return messages
    return withToolReferenceText(messages, toolSpecs, false)
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
  readonly messages: Message[]
  /** Trailing blocks of the latest user message, from its first injected block on, that the next call drops. */
  readonly dynamicTrailingBlocks: number
}

/**
 * Returns the messages as a model without temporary messages receives them. The latest user message's
 * injected blocks become text blocks in their place, and every other injected block is left out. Messages
 * without an injected block are returned as they are, and the input is never changed.
 *
 * @param messages - The messages of a model call
 * @returns The messages to send, and how many trailing blocks the cache point must stay ahead of
 */
function renderInjectedBlocks(messages: Message[]): RenderedMessages {
  const latestUser = latestUserIndex(messages)
  let dynamicTrailingBlocks = 0
  const rendered = messages.map((message, index) => {
    if (!hasInjectedBlock(message)) return message
    const content = index === latestUser ? withInjectedText(message.content) : withoutInjectedBlocks(message.content)
    if (index === latestUser) {
      dynamicTrailingBlocks = message.content.length - message.content.findIndex(isInjectedBlock)
    }
    return withContent(message, content)
  })
  return { messages: rendered, dynamicTrailingBlocks }
}

/**
 * Gives a tool result whose content is all `UnknownBlock`s a placeholder text. Providers skip unknown blocks, and
 * some reject a tool result left with no content (Nova on Bedrock, OpenAI chat), on every later call.
 */
function withUnknownOnlyToolResultsFilled(messages: Message[]): Message[] {
  if (!messages.some((message) => message.content.some(isUnknownOnlyToolResult))) return messages
  return messages.map((message) =>
    message.content.some(isUnknownOnlyToolResult)
      ? withContent(
          message,
          message.content.map((block) =>
            isUnknownOnlyToolResult(block)
              ? new ToolResultBlock({
                  toolUseId: block.toolUseId,
                  status: block.status,
                  content: [new TextBlock(UNSUPPORTED_CONTENT_PLACEHOLDER)],
                  ...(block.error !== undefined && { error: block.error }),
                })
              : block
          )
        )
      : message
  )
}

const UNSUPPORTED_CONTENT_PLACEHOLDER = '[unsupported content omitted]'

const STUB_HINT = `Call ${LOAD_TOOLS_TOOL_NAME} with this name for its parameters first.`

function isUnknownOnlyToolResult(block: ContentBlock): block is ToolResultBlock {
  return (
    block.type === 'toolResultBlock' &&
    block.content.length > 0 &&
    block.content.every((content) => content.type === 'unknownBlock')
  )
}

function withContent(message: Message, content: ContentBlock[]): Message {
  return new Message({
    role: message.role,
    content,
    trackingId: message.trackingId,
    ...(message.metadata !== undefined && { metadata: message.metadata }),
  })
}

/**
 * The content with each injected block as a text block in its place. Some providers join adjacent text blocks, so
 * injected text after other content starts with a blank line.
 */
function withInjectedText(content: ContentBlock[]): ContentBlock[] {
  return content.map((block, index) => {
    if (block.type !== 'injectedBlock') return block
    const { text } = block.injected
    return new TextBlock(index > 0 && !text.startsWith('\n') ? `\n\n${text}` : text)
  })
}

function withoutInjectedBlocks(content: ContentBlock[]): ContentBlock[] {
  return content.filter((block) => !isInjectedBlock(block))
}

function hasInjectedBlock(message: Message): boolean {
  return message.content.some(isInjectedBlock)
}

function isInjectedBlock(block: ContentBlock): boolean {
  return block.type === 'injectedBlock'
}

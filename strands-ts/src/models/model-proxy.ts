import { unwrapInvocationContext, type InvocationContext } from '../agent/invocation-context.js'
import type { ContentBlock, Message } from '../types/messages.js'
import type { Model, StreamAggregatedResult, StreamOptions } from './model.js'
import type { ModelStreamEvent, Usage } from './streaming.js'

/**
 * SDK-internal wrapper that adds a model call's token usage to its request. The
 * agent loop and every auxiliary call route their model calls through it. The
 * {@link InvocationContext} is passed per call rather than on {@link StreamOptions},
 * so providers never see request state. Usage is added whenever the provider
 * reported it, including a call that throws after its metadata event.
 *
 * @internal
 */
export class ModelProxy {
  private readonly _model: Model

  constructor(model: Model) {
    this._model = model
  }

  /**
   * Delegates to the wrapped model's `streamAggregated`, passing every event
   * through unchanged, then adds the call's usage to the request.
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
    const stream = this._model.streamAggregated(messages, options)
    let streamedUsage: Usage | undefined
    try {
      let next = await stream.next()
      while (!next.done) {
        if (next.value?.type === 'modelMetadataEvent') {
          streamedUsage = next.value.usage
        }
        yield next.value
        next = await stream.next()
      }
      this._record(next.value?.metadata?.usage, invocationContext)
      return next.value
    } catch (error) {
      // Usage the provider already reported is spent even though the call failed.
      this._record(streamedUsage, invocationContext)
      throw error
    }
  }

  /** Adds a call's reported usage to the request. */
  private _record(usage: Usage | undefined, invocationContext?: InvocationContext): void {
    const context = unwrapInvocationContext(invocationContext)
    if (usage !== undefined && context !== undefined) {
      context.recordUsage(usage)
    }
  }
}

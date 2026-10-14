import { toInternal, type Invocation } from '../agent/invocation.js'
import type { ContentBlock, Message } from '../types/messages.js'
import type { Model, StreamAggregatedResult, StreamOptions } from './model.js'
import type { ModelStreamEvent } from './streaming.js'

/**
 * SDK-internal wrapper that ties a model call to the request's
 * {@link Invocation}: the agent loop and the SDK's auxiliary calls
 * (summarization, routing, extraction, steering, HITL, goal judging, web-fetch)
 * all route through it, so each call's token usage is added to the request
 * total. The {@link Invocation} is passed per call rather than carried on
 * {@link StreamOptions}, so the provider layer stays free of request-scoped
 * state. Recording is on a clean return only, and only when the provider
 * reported usage — a throw propagates untouched and contributes no tokens.
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
   * through unchanged, then folds the call's usage into the invocation's
   * request total.
   *
   * @param messages - The conversation history to send to the model
   * @param options - Optional streaming configuration
   * @param invocation - Request-scoped state to record into, or `undefined` to run unrecorded
   * @returns Async generator mirroring {@link Model.streamAggregated}
   */
  async *streamAggregated(
    messages: Message[],
    options?: StreamOptions,
    invocation?: Invocation
  ): AsyncGenerator<ModelStreamEvent | ContentBlock, StreamAggregatedResult, undefined> {
    const result = yield* this._model.streamAggregated(messages, options)
    this._record(result, invocation)
    return result
  }

  /** Adds a completed call's reported usage to the invocation and every enclosing one. */
  private _record(result: StreamAggregatedResult, invocation?: Invocation): void {
    const usage = result?.metadata?.usage
    const internal = toInternal(invocation)
    if (usage !== undefined && internal !== undefined) {
      internal.recordUsage(usage)
    }
  }
}

import { toInternal, type Invocation } from '../agent/invocation.js'
import type { ContentBlock, Message } from '../types/messages.js'
import type { Model, StreamAggregatedResult, StreamOptions } from './model.js'
import { accumulateUsage, type ModelStreamEvent } from './streaming.js'

/**
 * SDK-internal wrapper that ties one model call to the request's
 * {@link Invocation}. It is the single seam every model call routes through —
 * the agent loop and every auxiliary call (summarization, routing, extraction,
 * steering, HITL, goal judging) alike — so request-scoped work that today lives
 * in the agent loop can move onto this one component without touching call sites
 * or the provider-facing {@link Model} contract.
 *
 * Today it does one such job: fold each call's token usage into the request
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

  /**
   * Folds a completed call's reported usage into the invocation's request
   * total. The single place per-call state is recorded — where limit
   * enforcement and turn counting join as this grows into the request's
   * model-call component.
   */
  private _record(result: StreamAggregatedResult, invocation?: Invocation): void {
    const usage = result?.metadata?.usage
    const internal = toInternal(invocation)
    if (usage !== undefined && internal !== undefined) {
      accumulateUsage(internal.usage, usage)
    }
  }
}

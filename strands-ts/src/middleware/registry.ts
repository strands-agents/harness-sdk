import type {
  MiddlewareStage,
  MiddlewareHandler,
  MiddlewareNext,
  MiddlewarePhaseKind,
  MiddlewareInputPhase,
  MiddlewareOutputPhase,
  MiddlewareInputHandler,
  MiddlewareOutputHandler,
} from './types.js'

/** Internal tagged handler with phase metadata for compose ordering. */
interface TaggedHandler<TContext, TResult, TEvent> {
  phase: MiddlewarePhaseKind
  handler: MiddlewareHandler<TContext, TResult, TEvent>
}

/** Compose layering: input (outermost) → output → wrap (innermost). Execution order: input → wrap → output. */
const PHASE_ORDER: Record<MiddlewarePhaseKind, number> = { input: 0, output: 1, wrap: 2 }

/**
 * Registry that stores middleware handlers keyed by stage tokens
 * and composes them into execution chains with phase ordering.
 */
export class MiddlewareRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _handlers: Map<MiddlewareStage<any, any, any>, TaggedHandler<any, any, any>[]>

  constructor() {
    this._handlers = new Map()
  }

  /**
   * Register a middleware handler for a given stage (Wrap phase).
   * Handlers are stored in registration order within their phase.
   *
   * @param stage - The stage token to register the handler for
   * @param handler - The middleware handler function
   */
  add<TContext, TResult, TEvent>(
    stage: MiddlewareStage<TContext, TResult, TEvent>,
    handler: MiddlewareHandler<TContext, TResult, TEvent>
  ): void {
    const handlers = this._handlers.get(stage) ?? []
    handlers.push({ phase: 'wrap', handler })
    this._handlers.set(stage, handlers)
  }

  /**
   * Register an Input phase handler. Transforms context before the Wrap chain runs.
   * Multiple Input handlers compose in registration order (each sees the previous handler's output).
   * Returns the adapted handler for cleanup purposes.
   */
  addInput<TContext, TResult, TEvent>(
    phase: MiddlewareInputPhase<TContext, TResult, TEvent>,
    handler: MiddlewareInputHandler<TContext>
  ): MiddlewareHandler<TContext, TResult, TEvent> {
    const stage = phase._stage
    const handlers = this._handlers.get(stage) ?? []
    const adapted: MiddlewareHandler<TContext, TResult, TEvent> = async function* (context, next) {
      const transformed = await handler(context)
      return yield* next(transformed)
    }
    handlers.push({ phase: 'input', handler: adapted })
    this._handlers.set(stage, handlers)
    return adapted
  }

  /**
   * Register an Output phase handler. Transforms result after the Wrap chain completes.
   * Multiple Output handlers compose in registration order (each sees the previous handler's output).
   * Returns the adapted handler for cleanup purposes.
   */
  addOutput<TContext, TResult, TEvent>(
    phase: MiddlewareOutputPhase<TContext, TResult, TEvent>,
    handler: MiddlewareOutputHandler<TResult>
  ): MiddlewareHandler<TContext, TResult, TEvent> {
    const stage = phase._stage
    const handlers = this._handlers.get(stage) ?? []
    const adapted: MiddlewareHandler<TContext, TResult, TEvent> = async function* (context, next) {
      const result = yield* next(context)
      return await handler(result)
    }
    handlers.push({ phase: 'output', handler: adapted })
    this._handlers.set(stage, handlers)
    return adapted
  }

  /**
   * Remove a previously registered middleware handler for a given stage.
   * Removes the first occurrence of the handler (by reference equality on the adapted handler).
   *
   * @param stage - The stage token to remove the handler from
   * @param handler - The middleware handler function to remove
   */
  remove<TContext, TResult, TEvent>(
    stage: MiddlewareStage<TContext, TResult, TEvent>,
    handler: MiddlewareHandler<TContext, TResult, TEvent>
  ): void {
    const handlers = this._handlers.get(stage)
    if (!handlers) return
    const idx = handlers.findIndex((h) => h.handler === handler)
    if (idx !== -1) handlers.splice(idx, 1)
  }

  /**
   * Compose all registered handlers for a stage into a single middleware chain.
   * Handlers are ordered by phase (input → output → wrap), then by registration order within phase.
   * First in the composed chain = outermost.
   *
   * @param stage - The stage token to compose handlers for
   * @param terminal - The innermost function that performs actual stage execution
   * @returns A single function representing the full middleware chain
   */
  compose<TContext, TResult, TEvent>(
    stage: MiddlewareStage<TContext, TResult, TEvent>,
    terminal: MiddlewareNext<TContext, TResult, TEvent>
  ): MiddlewareNext<TContext, TResult, TEvent> {
    const tagged = (this._handlers.get(stage) ?? []) as TaggedHandler<TContext, TResult, TEvent>[]

    // Stable sort by phase: input first, output second, wrap last (closest to terminal)
    const sorted = [...tagged].sort((a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase])

    let current: MiddlewareNext<TContext, TResult, TEvent> = terminal
    for (let i = sorted.length - 1; i >= 0; i--) {
      const handler = sorted[i]!.handler
      const next = current
      current = (context: TContext): AsyncGenerator<TEvent, TResult, undefined> => handler(context, next)
    }

    return current
  }

  /**
   * Compose and invoke the middleware chain for a stage in one call.
   * Equivalent to `compose(stage, terminal)(context)` but reads more clearly at call sites.
   *
   * @param stage - The stage token to invoke
   * @param context - The context to pass into the chain
   * @param terminal - The innermost function that performs actual stage execution
   * @returns An async generator yielding events and returning the stage result
   */
  invoke<TContext, TResult, TEvent>(
    stage: MiddlewareStage<TContext, TResult, TEvent>,
    context: TContext,
    terminal: MiddlewareNext<TContext, TResult, TEvent>
  ): AsyncGenerator<TEvent, TResult, undefined> {
    const chain = this.compose(stage, terminal)
    return chain(context)
  }
}

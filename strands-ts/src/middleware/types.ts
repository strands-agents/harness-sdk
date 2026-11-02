/**
 * A stage token that identifies a middleware interception point.
 * Stages are created via `createStage()` and carry their Context/Event/Result types
 * as generics, enabling full type inference at registration sites.
 */
export interface MiddlewareStage<TContext, TResult, TEvent> {
  /** Human-readable name for debugging and logging. */
  readonly name: string
  /** @internal Phantom field for type inference. Never accessed at runtime. */
  readonly _types?: { context: TContext; event: TEvent; result: TResult }
  /** Phase sub-token: transform context before execution. */
  readonly Input: MiddlewareInputPhase<TContext, TResult, TEvent>
  /** Phase sub-token: full async generator wrap (before + call next + after). */
  readonly Wrap: MiddlewareWrapPhase<TContext, TResult, TEvent>
  /** Phase sub-token: transform result after execution. */
  readonly Output: MiddlewareOutputPhase<TContext, TResult, TEvent>
}

/** Phase ordering. Compose layering: input (outermost) → output → wrap (innermost). Execution order: input → wrap → output. */
export type MiddlewarePhaseKind = 'input' | 'wrap' | 'output'

/** Phase sub-token for Input handlers. */
export interface MiddlewareInputPhase<TContext, TResult, TEvent> {
  /** @internal */
  readonly _phase: 'input'
  /** @internal Back-reference to parent stage. */
  readonly _stage: MiddlewareStage<TContext, TResult, TEvent>
}

/** Phase sub-token for Wrap handlers. */
export interface MiddlewareWrapPhase<TContext, TResult, TEvent> {
  /** @internal */
  readonly _phase: 'wrap'
  /** @internal Back-reference to parent stage. */
  readonly _stage: MiddlewareStage<TContext, TResult, TEvent>
}

/** Phase sub-token for Output handlers. */
export interface MiddlewareOutputPhase<TContext, TResult, TEvent> {
  /** @internal */
  readonly _phase: 'output'
  /** @internal Back-reference to parent stage. */
  readonly _stage: MiddlewareStage<TContext, TResult, TEvent>
}

/** Union of all phase sub-tokens. */
export type MiddlewarePhase<TContext, TResult, TEvent> =
  | MiddlewareInputPhase<TContext, TResult, TEvent>
  | MiddlewareWrapPhase<TContext, TResult, TEvent>
  | MiddlewareOutputPhase<TContext, TResult, TEvent>

/**
 * The `next` function passed to middleware.
 * Returns an async generator that yields events of type TEvent and returns the stage result.
 * Middleware can choose not to call `next` to short-circuit execution.
 */
export type MiddlewareNext<TContext, TResult, TEvent> = (
  context: TContext
) => AsyncGenerator<TEvent, TResult, undefined>

/**
 * A middleware handler function (Wrap phase).
 * Receives the context and a `next` function to call the next layer.
 * Must be an async generator that yields TEvent and returns TResult.
 * Middleware can yield its own events, forward events from next, or suppress them.
 */
export type MiddlewareHandler<TContext, TResult, TEvent> = (
  context: TContext,
  next: MiddlewareNext<TContext, TResult, TEvent>
) => AsyncGenerator<TEvent, TResult, undefined>

/** Handler for Input phase — transforms context before execution. */
export type MiddlewareInputHandler<TContext> = (context: TContext) => TContext | Promise<TContext>

/** Handler for Output phase — transforms result after execution. */
export type MiddlewareOutputHandler<TResult> = (result: TResult) => TResult | Promise<TResult>

/**
 * Extracts the `MiddlewareHandler` type from a stage token.
 * Use this to type middleware methods or properties without repeating the generic parameters.
 *
 * @example
 * ```typescript
 * class MyPlugin implements Plugin {
 *   private _handler: MiddlewareHandlerOf<typeof InvokeModelStage> = async function* (context, next) { ... }
 * }
 * ```
 */
export type MiddlewareHandlerOf<S> =
  S extends MiddlewareStage<infer C, infer R, infer E> ? MiddlewareHandler<C, R, E> : never

/**
 * Extracts the `MiddlewareNext` type from a stage token.
 * Use this to type the `next` parameter in standalone middleware methods.
 *
 * @example
 * ```typescript
 * private async *_handler(context: ..., next: MiddlewareNextOf<typeof AgentStreamStage>) { ... }
 * ```
 */
export type MiddlewareNextOf<S> = S extends MiddlewareStage<infer C, infer R, infer E> ? MiddlewareNext<C, R, E> : never

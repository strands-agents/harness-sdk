import { AfterInvocationEvent } from '../../hooks/events.js'
import { HookOrder } from '../../hooks/types.js'
import { ExtractionTrigger, type ExtractionTriggerContext } from './types.js'

/**
 * Runs extraction after every agent invocation.
 *
 * The highest-fidelity option: nothing said in a turn is missed. Also the most expensive when an
 * {@link Extractor} is configured (a model call per turn) — for a server-side-extraction backend
 * with no extractor it is just a per-turn write.
 *
 * @example
 * ```typescript
 * extraction: { trigger: [new InvocationTrigger()] }
 * ```
 */
export class InvocationTrigger extends ExtractionTrigger {
  readonly name = 'invocation'

  attach(context: ExtractionTriggerContext): void {
    // Run after the SDK's own after-invocation hooks (e.g. session persistence) so extraction sees
    // the fully settled turn.
    context.agent.addHook(AfterInvocationEvent, (event) => context.fire(event.invocation), {
      order: HookOrder.SDK_LAST,
    })
  }
}

/** Options for {@link IntervalTrigger}. */
export interface IntervalTriggerOptions {
  /** Run extraction once every this many invocations. Must be a positive integer. */
  turns: number
}

/**
 * Runs extraction every N agent invocations.
 *
 * A controllable middle ground: extraction (and any model call it entails) happens on a cadence
 * rather than every turn, while the high-water mark guarantees the messages from the skipped turns
 * are still processed when the trigger does fire.
 *
 * @example
 * ```typescript
 * extraction: { trigger: [new IntervalTrigger({ turns: 5 })] }
 * ```
 */
export class IntervalTrigger extends ExtractionTrigger {
  readonly name = 'interval'
  private readonly _turns: number

  constructor(options: IntervalTriggerOptions) {
    super()
    if (!Number.isInteger(options.turns) || options.turns < 1) {
      throw new Error(`IntervalTrigger: turns must be a positive integer, got ${options.turns}`)
    }
    this._turns = options.turns
  }

  attach(context: ExtractionTriggerContext): void {
    // Per-attach counter: each store this trigger is configured on gets its own count via a fresh
    // closure, so two stores sharing one IntervalTrigger instance still fire independently.
    let count = 0
    context.agent.addHook(
      AfterInvocationEvent,
      (event) => {
        count++
        // `fire` is fire-and-forget (returns void); it dispatches extraction in the background.
        if (count % this._turns === 0) {
          context.fire(event.invocation)
        }
      },
      { order: HookOrder.SDK_LAST }
    )
  }
}

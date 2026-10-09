/**
 * Base hide strategy and shared infrastructure.
 *
 * Hide strategies operate on the per-call model input (`InvokeModelContext`), not on
 * `ContextState.messages`. They register an `InvokeModelStage.Input` handler from `init()`
 * and are a no-op in the message pipeline. Nothing durable changes: a hidden spec is absent
 * from one call's projection, and the next invocation recomputes the view.
 *
 * Not exported from the package barrel while the API is experimental.
 *
 * @internal
 */

import { MANAGE_TOOL_NAME as BACKGROUND_TASK_TOOL_NAME } from '../../../background-tasks/background-tasks.js'
import { AfterInvocationEvent, BeforeInvocationEvent } from '../../../hooks/events.js'
import { HookOrder } from '../../../hooks/types.js'
import { InvokeModelStage } from '../../../middleware/stages.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../../tools/structured-output-tool.js'
import { RETRIEVAL_TOOL_NAME as OFFLOADED_CONTENT_RETRIEVAL_TOOL_NAME } from '../../../vended-plugins/context-offloader/plugin.js'
import { RETRIEVAL_TOOL_NAME } from '../../retrieval-tool.js'
import type { InvokeModelContext } from '../../../middleware/stages.js'
import type { ToolSpec } from '../../../tools/types.js'
import type { InvocationState, LocalAgent } from '../../../types/agent.js'
import type { ContextState, ContextStrategy } from '../../types.js'

/**
 * Target for hide operations. This union is intentionally extensible — new string-literal
 * members can be added as new per-call segments emerge.
 *
 * - `"toolSpecs"` — every tool spec on the call
 * - `string[]` — tool specs by name, namespaced with `toolSpec::` (e.g. `['toolSpec::*']` or
 *   `['toolSpec::billing_search']`); prefix with `!` to pin a spec so it is always visible, never
 *   a candidate, and outside any budget
 *
 * Pin any plugin tool the model is told to call by injected prompt text (for `AgentSkills`,
 * `'!toolSpec::skills'`), since a hidden spec cannot be called.
 *
 * @internal
 */
export type HideTarget = 'toolSpecs' | string[]

/**
 * Conditions that determine when a hide strategy fires.
 *
 * Hide strategies fire on catalog size, not on token utilization. Message conditions
 * (`threshold`, `utilization`, `preserveRecent`) do not apply.
 *
 * @internal
 */
export interface HideConditions {
  /** Fire only when at least this many candidate items are on the call. */
  count?: number
}

/**
 * Intermediate builder result that allows chaining `.when()` conditions.
 * Also implements `ContextStrategy` directly so it can be used without `.when()`.
 *
 * @internal
 */
export interface HideStrategyBuilder extends ContextStrategy {
  /** Add conditions that determine when this strategy fires. */
  when(conditions: HideConditions): ContextStrategy
}

// --- Shared helpers ---

const TOOL_SPEC_PREFIX = 'toolSpec::'
const TOOL_SPEC_WILDCARD = `${TOOL_SPEC_PREFIX}*`

/**
 * Tools that SDK-injected content tells the model to call: the structured-output tool, the
 * retrieval tools whose offload placeholders reference them, and the background-task tool whose
 * synthetic tool uses report task completion. Never hidden.
 *
 * Plugin tools with the same property that are not listed here, such as the `skills` tool whose
 * `available_skills` prompt section `AgentSkills` injects, are pinned by the user with
 * `!toolSpec::<name>`; opting into selection means owning which plugin tools stay visible.
 */
export const PROTECTED_TOOLS: ReadonlySet<string> = new Set([
  STRUCTURED_OUTPUT_TOOL_NAME,
  RETRIEVAL_TOOL_NAME,
  OFFLOADED_CONTENT_RETRIEVAL_TOOL_NAME,
  BACKGROUND_TASK_TOOL_NAME,
])

/**
 * Parses a target into candidate and pinned names. `toolSpec::*`, or no plain entries at all,
 * makes every spec a candidate.
 */
export function resolveHideTarget(target: HideTarget): {
  candidates: ReadonlySet<string> | undefined
  pinned: ReadonlySet<string>
} {
  const pinned = new Set<string>()
  if (!Array.isArray(target)) return { candidates: undefined, pinned }

  const candidates = new Set<string>()
  let wildcard = false
  for (const entry of target) {
    const isPin = entry.startsWith('!')
    const body = isPin ? entry.slice(1) : entry
    const name = body.startsWith(TOOL_SPEC_PREFIX) ? body.slice(TOOL_SPEC_PREFIX.length) : ''
    if (name.length === 0 || (isPin && name === '*')) {
      throw new Error(
        `Hide targets must be '${TOOL_SPEC_PREFIX}<name>', '${TOOL_SPEC_WILDCARD}', or '!${TOOL_SPEC_PREFIX}<name>', got '${entry}'`
      )
    }
    if (isPin) pinned.add(name)
    else if (name === '*') wildcard = true
    else candidates.add(name)
  }
  for (const name of pinned) {
    if (candidates.has(name)) throw new Error(`'${TOOL_SPEC_PREFIX}${name}' is both a candidate and pinned`)
  }
  return { candidates: wildcard || candidates.size === 0 ? undefined : candidates, pinned }
}

/** Whether a bare tool name is written in the target grammar. */
export function isTargetEntry(name: string): boolean {
  return name.startsWith(TOOL_SPEC_PREFIX) || name.startsWith(`!${TOOL_SPEC_PREFIX}`)
}

// --- Base strategy class ---

/**
 * Shared hide logic: target routing, middleware registration, per-invocation state, and the
 * `count` gate. Subclasses implement `_transform` to filter one segment of the model input.
 *
 * @internal
 */
export abstract class BaseHideStrategy<TState extends object> implements ContextStrategy {
  abstract readonly name: string

  protected readonly _target: HideTarget
  protected readonly _count: number | undefined
  /** Candidate names from `toolSpec::<name>` entries; undefined means every spec is a candidate. */
  protected readonly _candidates: ReadonlySet<string> | undefined
  /** Names from `!toolSpec::<name>` entries; always visible, never candidates. */
  protected readonly _pinned: ReadonlySet<string>
  /**
   * Per-invocation state, keyed by agent and then by the invocation's state object. The agent key
   * matters because `AgentAsTool` forwards the parent's `invocationState` to the child, and one
   * strategy instance may serve both; the invocation key matters because callers may reuse one
   * `invocationState` object across invocations, which is why the boundary hooks still clear it.
   */
  private readonly _state = new WeakMap<LocalAgent, WeakMap<InvocationState, TState>>()

  constructor(target: HideTarget, conditions?: HideConditions) {
    if (target !== 'toolSpecs' && !Array.isArray(target)) {
      throw new Error(`Hide target must be 'toolSpecs' or an array of entries, got ${JSON.stringify(target)}`)
    }
    if (Array.isArray(target) && target.length === 0) {
      throw new Error('Empty array target matches nothing — provide at least one target')
    }
    if (conditions?.count !== undefined && (!Number.isInteger(conditions.count) || conditions.count < 0)) {
      throw new Error(`count must be a non-negative integer, got ${conditions.count}`)
    }
    this._target = target
    this._count = conditions?.count
    const resolved = resolveHideTarget(target)
    this._candidates = resolved.candidates
    this._pinned = resolved.pinned
  }

  init(agent: LocalAgent): void {
    agent.addMiddleware(InvokeModelStage.Input, (context) => this._transform(context))
    agent.addHook(AfterInvocationEvent, (event) => this._clearState(event.agent, event.invocationState), {
      order: HookOrder.SDK_LAST,
    })
    agent.addHook(BeforeInvocationEvent, (event) => this._clearState(event.agent, event.invocationState), {
      order: HookOrder.SDK_FIRST,
    })
  }

  /** Hide strategies do not touch the message pipeline. */
  async apply(_context: ContextState): Promise<boolean> {
    return false
  }

  /** Filter the model input for one call. */
  protected abstract _transform(context: InvokeModelContext): Promise<InvokeModelContext>

  /** A candidate for hiding: in the target, not pinned, not a protected tool. */
  protected _isCandidate(spec: ToolSpec): boolean {
    if (PROTECTED_TOOLS.has(spec.name) || this._pinned.has(spec.name)) return false
    return this._candidates === undefined || this._candidates.has(spec.name)
  }

  protected _getState(agent: LocalAgent, invocationState: InvocationState): TState | undefined {
    return this._state.get(agent)?.get(invocationState)
  }

  protected _setState(agent: LocalAgent, invocationState: InvocationState, state: TState): void {
    let states = this._state.get(agent)
    if (states === undefined) {
      states = new WeakMap()
      this._state.set(agent, states)
    }
    states.set(invocationState, state)
  }

  private _clearState(agent: LocalAgent, invocationState: InvocationState): void {
    this._state.get(agent)?.delete(invocationState)
  }
}

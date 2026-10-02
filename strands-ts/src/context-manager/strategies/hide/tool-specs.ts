/**
 * Hide tool specs — filters which tool specs the model sees on each call.
 *
 * Tool specs are a per-call projection of the tool registry, rebuilt for every model call and
 * carried on `InvokeModelContext.toolSpecs`. The registry is never touched: a hidden spec is
 * absent from one call's projection, and the next invocation recomputes the view.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../../tools/structured-output-tool.js'
import { TextBlock } from '../../../types/messages.js'
import { OFFLOADED_CONTENT_RETRIEVAL_TOOL_NAME } from '../../../vended-plugins/context-offloader/plugin.js'
import { RETRIEVAL_TOOL_NAME } from '../../retrieval-tool.js'
import { BaseHideStrategy } from './base.js'
import { KeywordToolSearch, contentTerms } from './tool-search.js'
import type { InvokeModelContext } from '../../../middleware/stages.js'
import type { ToolSpec } from '../../../tools/types.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { Message } from '../../../types/messages.js'
import type { ContextStrategy } from '../../types.js'
import type { HideConditions } from './base.js'
import type { ToolSearchStrategy } from './tool-search.js'

/**
 * Target for `Hide.toolSpecs` — which specs are candidates for hiding.
 *
 * - `"toolSpecs"` — every tool spec on the call
 * - `string[]` — `toolSpec::*` (every spec) or `toolSpec::<name>` entries name the candidates;
 *   a `!toolSpec::<name>` entry is pinned: always visible, never a candidate, and outside the `keep` budget
 *
 * @internal
 */
export type HideToolSpecsTarget = 'toolSpecs' | string[]

/**
 * What the model sees when search fails or returns no usable match and there is no previous
 * selection to carry forward.
 *
 * - `"all"` — every candidate
 * - `"none"` — only pinned and protected tools
 *
 * @internal
 */
export type HideFailurePolicy = 'all' | 'none'

/**
 * Configuration for `Hide.toolSpecs`.
 *
 * @internal
 */
export interface HideToolSpecsConfig {
  /** Ranks candidates by relevance to the latest user text. Defaults to `KeywordToolSearch`. */
  search?: ToolSearchStrategy
  /**
   * How many candidates the model sees: the best matches first, then unmatched candidates in
   * catalog order until the budget is met. A catalog that fits within the budget passes through.
   * Pinned and protected tools are shown in addition, so the wire carries
   * `min(keep, candidates) + pinned + protected` specs on a ranked turn. Defaults to 10.
   */
  keep?: number
  /**
   * Tool names the model never sees, regardless of search, `count`, or pinning. Tools that
   * SDK-injected content tells the model to call are never hidden, even if listed here.
   */
  alwaysHide?: readonly string[]
  /**
   * What to show when no selection can be made. `keep` bounds ranked turns; this governs turns
   * with no ranking signal at all, where `"all"` shows every candidate. Defaults to `"all"`.
   */
  onFailure?: HideFailurePolicy
}

const DEFAULT_KEEP = 10
const TOOL_SPEC_PREFIX = 'toolSpec::'
const TOOL_SPEC_WILDCARD = `${TOOL_SPEC_PREFIX}*`

/**
 * Tools that SDK-injected content tells the model to call: the structured-output tool, and the
 * retrieval tools whose offload placeholders reference them. Never hidden. Third-party plugin
 * tools with the same property are pinned by the user with `!toolSpec::<name>`.
 */
const PROTECTED_TOOLS: ReadonlySet<string> = new Set([
  STRUCTURED_OUTPUT_TOOL_NAME,
  RETRIEVAL_TOOL_NAME,
  OFFLOADED_CONTENT_RETRIEVAL_TOOL_NAME,
])

/**
 * The decision for one invocation, made on its first model call and reused on every later one.
 * Specs that join the catalog later in the invocation were never ranked and stay visible.
 */
interface ToolSpecsState {
  /** Names to show among the candidates; undefined when the catalog passes through. */
  selected: ReadonlySet<string> | undefined
  /** The candidate names at decision time. */
  considered: ReadonlySet<string>
}

/**
 * Selects once per invocation and reuses the selection through the tool loop, so a stable
 * selection is a byte-identical tool prefix from call to call.
 *
 * @internal
 */
export class HideToolSpecsStrategy extends BaseHideStrategy<ToolSpecsState> {
  readonly name = 'hide:toolSpecs'

  private readonly _target: HideToolSpecsTarget
  private readonly _config: HideToolSpecsConfig
  private readonly _search: ToolSearchStrategy
  private readonly _keep: number
  private readonly _alwaysHide: ReadonlySet<string>
  private readonly _onFailure: HideFailurePolicy
  /** Candidate names from `toolSpec::<name>` entries; undefined means every spec is a candidate. */
  private readonly _candidates: ReadonlySet<string> | undefined
  /** Names from `!toolSpec::<name>` entries; always visible, never candidates. */
  private readonly _pinned: ReadonlySet<string>
  /** The candidates each agent's model last saw, carried forward when a continuation turn has no matches. */
  private readonly _previous = new WeakMap<LocalAgent, ReadonlySet<string>>()

  constructor(target: HideToolSpecsTarget, config?: HideToolSpecsConfig, conditions?: HideConditions) {
    super(conditions)
    if (Array.isArray(target) && target.length === 0) {
      throw new Error('Empty array target matches nothing — provide at least one target')
    }
    if (config?.keep !== undefined && (!Number.isInteger(config.keep) || config.keep < 1)) {
      throw new Error(`keep must be a positive integer, got ${config.keep}`)
    }
    this._target = target
    this._config = config ?? {}
    this._search = config?.search ?? KeywordToolSearch
    this._keep = config?.keep ?? DEFAULT_KEEP
    this._alwaysHide = new Set(config?.alwaysHide ?? [])
    this._onFailure = config?.onFailure ?? 'all'
    const { candidates, pinned } = resolveTarget(target)
    this._candidates = candidates
    this._pinned = pinned
  }

  when(conditions: HideConditions): ContextStrategy {
    return new HideToolSpecsStrategy(this._target, this._config, conditions)
  }

  /**
   * A forced call (`toolChoice` names a tool) keeps that tool visible whatever the selection, so
   * the forced structured-output call at the end of an invocation ships the same prefix as the
   * calls before it rather than re-expanding to the full catalog.
   */
  protected async _transform(context: InvokeModelContext): Promise<InvokeModelContext> {
    const catalog = context.toolSpecs
    const forced =
      context.toolChoice !== undefined && 'tool' in context.toolChoice ? context.toolChoice.tool.name : undefined
    const shown = catalog.filter(
      (spec) => PROTECTED_TOOLS.has(spec.name) || spec.name === forced || !this._alwaysHide.has(spec.name)
    )

    const state = this._getState(context.invocationState) ?? (await this._decide(context, shown))
    if (state.selected === undefined) return this._emit(context, catalog, shown)

    const { selected, considered } = state
    const visible = shown.filter(
      (spec) => spec.name === forced || !this._isEligible(spec) || !considered.has(spec.name) || selected.has(spec.name)
    )
    return this._emit(context, catalog, visible)
  }

  /**
   * Make the invocation's decision from the catalog on its first model call and store it. The
   * catalog passes through when `count` is not met or the candidates already fit within `keep`.
   */
  private async _decide(context: InvokeModelContext, shown: readonly ToolSpec[]): Promise<ToolSpecsState> {
    const eligible = shown.filter((spec) => this._isEligible(spec))
    const considered = new Set(eligible.map((spec) => spec.name))
    const gated = this._count !== undefined && eligible.length < this._count
    let selected: ReadonlySet<string> | undefined
    if (gated || eligible.length <= this._keep) {
      this._previous.set(context.agent, considered)
    } else {
      selected = await this._select(context, eligible)
    }
    const state = { selected, considered }
    this._setState(context.invocationState, state)
    return state
  }

  /** The context with `visible` as its tool specs; the same context object when nothing was removed. */
  private async _emit(
    context: InvokeModelContext,
    catalog: readonly ToolSpec[],
    visible: ToolSpec[]
  ): Promise<InvokeModelContext> {
    if (visible.length === catalog.length) return context
    logger.debug(
      `strategy=<${this.name}>, catalog=<${catalog.length}>, visible=<${visible.length}> | tool specs filtered`
    )
    const projectedInputTokens = await this._correctProjection(context, catalog, visible)
    return {
      ...context,
      toolSpecs: visible,
      ...(projectedInputTokens !== undefined && { projectedInputTokens }),
    }
  }

  /**
   * Select the names to show for this invocation and record them as what the agent's model last
   * saw. A continuation turn ("yes, do it", "ok confirm") carries the previous view forward without
   * ranking, so an acknowledgement that happens to share a word with a tool name cannot swap out
   * the tool the model is mid-task with. Anything else is ranked; no matches, or a search failure,
   * goes to `onFailure`.
   */
  private async _select(context: InvokeModelContext, eligible: readonly ToolSpec[]): Promise<ReadonlySet<string>> {
    const eligibleNames = new Set(eligible.map((spec) => spec.name))
    const query = queryFromMessages(context.messages)

    let selected: ReadonlySet<string>
    try {
      const carried = isContinuation(query) ? this._carryForward(context.agent, eligibleNames) : undefined
      if (carried) {
        logger.debug(`strategy=<${this.name}> | continuation turn, carrying previous view forward`)
        selected = carried
      } else {
        selected = await this._rank(eligible, query)
        if (selected.size === 0) {
          logger.debug(`strategy=<${this.name}>, onFailure=<${this._onFailure}> | no matches`)
          selected = this._fallback(eligibleNames)
        }
      }
    } catch (error) {
      logger.warn(`strategy=<${this.name}>, onFailure=<${this._onFailure}>, error=<${error}> | search failed`)
      selected = this._fallback(eligibleNames)
    }
    this._previous.set(context.agent, selected)
    return selected
  }

  /**
   * The best `keep` matches among the candidates, filled from unmatched candidates in catalog
   * order when there are fewer matches than the budget. Empty when nothing matched.
   */
  private async _rank(eligible: readonly ToolSpec[], query: string): Promise<Set<string>> {
    const eligibleNames = new Set(eligible.map((spec) => spec.name))
    const selected = new Set<string>()
    for (const result of await this._search.search(query, eligible, this._keep)) {
      if (selected.size >= this._keep) break
      if (eligibleNames.has(result.name)) selected.add(result.name)
    }
    if (selected.size === 0) return selected

    for (const spec of eligible) {
      if (selected.size >= this._keep) break
      selected.add(spec.name)
    }
    return selected
  }

  private _fallback(eligibleNames: ReadonlySet<string>): ReadonlySet<string> {
    return this._onFailure === 'all' ? eligibleNames : new Set()
  }

  /** The agent's previous selection, intersected with what is eligible now; undefined if nothing survives. */
  private _carryForward(agent: LocalAgent, eligibleNames: ReadonlySet<string>): ReadonlySet<string> | undefined {
    const previous = this._previous.get(agent)
    if (previous === undefined) return undefined
    const carried = new Set([...previous].filter((name) => eligibleNames.has(name)))
    return carried.size > 0 ? carried : undefined
  }

  /**
   * The loop projects input tokens against the full catalog before input middleware runs, but only
   * on a cold start. Warm calls derive the projection from the previous call's actual usage, which
   * already excluded hidden specs, so subtracting again would double-count. The recount uses the
   * agent's model, as the loop does, rather than the model the call was routed to.
   */
  private async _correctProjection(
    context: InvokeModelContext,
    catalog: readonly ToolSpec[],
    visible: readonly ToolSpec[]
  ): Promise<number | undefined> {
    if (context.projectedInputTokens === undefined || visible.length === catalog.length) {
      return context.projectedInputTokens
    }
    if (hasUsageBaseline(context.messages)) return context.projectedInputTokens

    const visibleNames = new Set(visible.map((spec) => spec.name))
    const removed = catalog.filter((spec) => !visibleNames.has(spec.name))
    try {
      const removedTokens = await context.agent.model.countTokens([], { toolSpecs: removed })
      return Math.max(0, context.projectedInputTokens - removedTokens)
    } catch (error) {
      logger.debug(`strategy=<${this.name}>, error=<${error}> | token recount failed, keeping projection`)
      return context.projectedInputTokens
    }
  }

  /** A candidate for hiding: in the target, not pinned, not a protected tool. */
  private _isEligible(spec: ToolSpec): boolean {
    if (PROTECTED_TOOLS.has(spec.name) || this._pinned.has(spec.name)) return false
    return this._candidates === undefined || this._candidates.has(spec.name)
  }
}

/**
 * Parses a target into candidate and pinned names. `toolSpec::*`, or no plain entries at all,
 * makes every spec a candidate.
 */
function resolveTarget(target: HideToolSpecsTarget): {
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

/** Latest user text is the query; tool-result-only user turns are skipped. */
function queryFromMessages(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'user') continue
    const text = message.content
      .filter((block): block is TextBlock => block instanceof TextBlock)
      .map((block) => block.text)
      .join(' ')
      .trim()
    if (text.length > 0) return text
  }
  return ''
}

/** True once an assistant message carries usage; the loop then projects from that baseline. */
function hasUsageBaseline(messages: readonly Message[]): boolean {
  return messages.some((message) => message.role === 'assistant' && message.metadata?.usage !== undefined)
}
/**
 * A turn made only of function words and acknowledgements ("yes, do it", "ok thanks") continues
 * the previous topic. Anything else that fails to match is treated as new and goes to `onFailure`,
 * since showing every tool costs tokens while carrying stale tools costs correctness.
 */
function isContinuation(query: string): boolean {
  for (const term of contentTerms(query)) {
    if (!ACKNOWLEDGEMENTS.has(term)) return false
  }
  return true
}

const ACKNOWLEDGEMENTS: ReadonlySet<string> = new Set([
  'yes',
  'yeah',
  'yep',
  'nope',
  'ok',
  'okay',
  'sure',
  'fine',
  'good',
  'great',
  'right',
  'correct',
  'thanks',
  'thank',
  'please',
  'go',
  'ahead',
  'proceed',
  'continue',
  'confirm',
  'confirmed',
  'done',
])

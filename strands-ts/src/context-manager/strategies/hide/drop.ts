/**
 * Drop strategy — removes tool specs from the model call that are not relevant to the turn.
 *
 * Tool specs are a per-call projection of the tool registry, rebuilt for every model call and
 * carried on `InvokeModelContext.toolSpecs`. Unlike `Offload.drop`, nothing durable changes and
 * nothing is stashed: a dropped spec is absent from one call's projection, and the next
 * invocation recomputes the view.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { TextBlock, ToolUseBlock } from '../../../types/messages.js'
import { BaseHideStrategy, PROTECTED_TOOLS, isTargetEntry } from './base.js'
import { KeywordToolSearchStrategy, contentTerms, namesTool } from './search/keyword.js'
import type { InvokeModelContext } from '../../../middleware/stages.js'
import type { ToolSpec } from '../../../tools/types.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { Message } from '../../../types/messages.js'
import type { ContextStrategy } from '../../types.js'
import type { HideConditions, HideTarget } from './base.js'
import type { ToolSearchStrategy } from './search/index.js'

/**
 * What the model sees when search fails or returns no usable match and there is no previous
 * selection to carry forward.
 *
 * - `"all"` — every candidate
 * - `"none"` — only pinned and protected tools. With nothing pinned, a call can carry no tool
 *   specs at all; some providers reject that once the history contains tool use, so pin at
 *   least one tool when choosing `"none"`.
 *
 * @internal
 */
export type HideFailurePolicy = 'all' | 'none'

/**
 * Configuration for `Hide.drop`.
 *
 * @internal
 */
export interface HideDropConfig {
  /** Ranks candidates by relevance to the latest user text. Defaults to `KeywordToolSearchStrategy`. */
  search?: ToolSearchStrategy
  /**
   * How many candidates the model sees: the best matches, then unmatched candidates in catalog
   * order until the budget is met, all emitted in catalog order. A catalog that fits within the
   * budget passes through. Specs outside the target, pinned, or protected are shown in addition,
   * so the wire carries `min(keep, candidates) + everything that is not a candidate` on a ranked
   * turn. Defaults to 10.
   */
  keep?: number
  /**
   * Bare tool names the model never sees, regardless of search, `count`, or pinning. Tools that
   * SDK-injected content tells the model to call are never hidden, nor is a tool that `toolChoice`
   * forces by name, even if listed here.
   */
  alwaysHide?: readonly string[]
  /**
   * What to show when no selection can be made. `keep` bounds ranked turns; this governs turns
   * with no ranking signal at all, where `"all"` shows every candidate. Defaults to `"all"`.
   */
  onFailure?: HideFailurePolicy
}

const DEFAULT_KEEP = 10

/**
 * The decision for one invocation, made on its first model call and reused on every later one.
 * Specs that join the catalog later in the invocation were never ranked and stay visible.
 */
interface DropState {
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
export class HideDropStrategy extends BaseHideStrategy<DropState> {
  readonly name = 'hide:drop'

  private readonly _config: HideDropConfig
  private readonly _search: ToolSearchStrategy
  private readonly _keep: number
  private readonly _alwaysHide: ReadonlySet<string>
  private readonly _onFailure: HideFailurePolicy
  /**
   * The candidates each agent's model last saw, carried forward on a continuation turn. An
   * in-memory fast path: a restored agent has none, and `_carryForward` falls back to the tools
   * the history shows the model used. Keyed by agent alone: carry-forward assumes sequential
   * invocations, as ContextManager does.
   */
  private readonly _previous = new WeakMap<LocalAgent, ReadonlySet<string>>()

  constructor(target: HideTarget, config?: HideDropConfig, conditions?: HideConditions) {
    super(target, conditions)
    const keep = config?.keep ?? DEFAULT_KEEP
    if (!Number.isInteger(keep) || keep < 1) {
      throw new Error(`keep must be a positive integer, got ${config?.keep}`)
    }
    for (const name of config?.alwaysHide ?? []) {
      if (isTargetEntry(name)) throw new Error(`alwaysHide takes bare tool names, got '${name}'`)
      if (this._pinned.has(name)) throw new Error(`'${name}' is both pinned and in alwaysHide`)
      if (PROTECTED_TOOLS.has(name)) logger.warn(`tool=<${name}> | alwaysHide names a protected tool, it stays visible`)
    }
    if (this._count !== undefined && this._count <= keep) {
      logger.warn(
        `count=<${this._count}>, keep=<${keep}> | count at or below keep never fires, a catalog that fits within keep already passes through`
      )
    }
    this._config = config ?? {}
    this._search = config?.search ?? KeywordToolSearchStrategy
    this._keep = keep
    this._alwaysHide = new Set(config?.alwaysHide ?? [])
    this._onFailure = config?.onFailure ?? 'all'
  }

  when(conditions: HideConditions): ContextStrategy {
    return new HideDropStrategy(this._target, this._config, conditions)
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

    const state = this._getState(context.agent, context.invocationState) ?? (await this._decide(context, shown))
    if (state.selected === undefined) return this._emit(context, catalog, shown)

    const { selected, considered } = state
    const visible = shown.filter(
      (spec) =>
        spec.name === forced || !this._isCandidate(spec) || !considered.has(spec.name) || selected.has(spec.name)
    )
    return this._emit(context, catalog, visible)
  }

  /**
   * Make the invocation's decision from the catalog on its first model call and store it. The
   * catalog passes through when `count` is not met or the candidates already fit within `keep`.
   */
  private async _decide(context: InvokeModelContext, shown: readonly ToolSpec[]): Promise<DropState> {
    const candidates = shown.filter((spec) => this._isCandidate(spec))
    const considered = new Set(candidates.map((spec) => spec.name))
    const gated = this._count !== undefined && candidates.length < this._count
    let selected: ReadonlySet<string> | undefined
    if (gated || candidates.length <= this._keep) {
      this._previous.set(context.agent, considered)
    } else {
      selected = await this._select(context, candidates)
    }
    const state = { selected, considered }
    this._setState(context.agent, context.invocationState, state)
    return state
  }

  /** The context with `visible` as its tool specs; the same context object when nothing was removed. */
  private async _emit(
    context: InvokeModelContext,
    catalog: readonly ToolSpec[],
    visible: ToolSpec[]
  ): Promise<InvokeModelContext> {
    if (visible.length === catalog.length) return context
    const visibleNames = new Set(visible.map((spec) => spec.name))
    const hidden = catalog.filter((spec) => !visibleNames.has(spec.name)).map((spec) => spec.name)
    logger.debug(
      `strategy=<${this.name}>, catalog=<${catalog.length}>, visible=<${visible.map((spec) => spec.name).join(',')}>, hidden=<${hidden.join(',')}> | tool specs filtered`
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
   * saw. A continuation turn ("yes, do it", "ok confirm") keeps the previous view and adds only the
   * tools its words name, without ranking, so an acknowledgement can neither swap out the tool the
   * model is mid-task with nor hide the one it asks for, and a word that merely appears in some
   * description does not grow the prefix. Anything else is ranked; no matches, or a search
   * failure, goes to `onFailure`.
   */
  private async _select(context: InvokeModelContext, candidates: readonly ToolSpec[]): Promise<ReadonlySet<string>> {
    const candidateNames = new Set(candidates.map((spec) => spec.name))
    // The durable history, not the per-call projection: earlier input middleware (memory,
    // context injection) folds text into the projection's last user message, and that text is
    // not what the user asked for.
    const history = context.agent.messages
    const query = queryFromMessages(history)

    let selected: ReadonlySet<string>
    try {
      const carried =
        isContinuation(query) && hasPriorTurn(history)
          ? this._carryForward(context.agent, history, candidateNames)
          : undefined
      if (carried) {
        const named = candidates.filter((spec) => namesTool(query, spec)).map((spec) => spec.name)
        selected = new Set([...carried, ...named])
        logger.debug(
          `strategy=<${this.name}>, added=<${named.join(',')}> | continuation turn, carrying previous view forward`
        )
      } else {
        selected = await this._rank(candidates, query)
        if (selected.size === 0) {
          logger.debug(`strategy=<${this.name}>, onFailure=<${this._onFailure}> | no matches`)
          selected = this._fallback(candidateNames)
        }
      }
    } catch (error) {
      logger.warn(`strategy=<${this.name}>, onFailure=<${this._onFailure}>, error=<${error}> | search failed`)
      selected = this._fallback(candidateNames)
    }
    this._previous.set(context.agent, selected)
    return selected
  }

  /**
   * The best `keep` matches among the candidates, filled from unmatched candidates in catalog
   * order when there are fewer matches than the budget. Empty when nothing matched. The fill is
   * `Hide`'s budget semantics and applies whatever strategy produced the matches.
   */
  private async _rank(candidates: readonly ToolSpec[], query: string): Promise<Set<string>> {
    const candidateNames = new Set(candidates.map((spec) => spec.name))
    const selected = new Set<string>()
    for (const result of await this._search.search(query, candidates, { limit: this._keep })) {
      if (selected.size >= this._keep) break
      if (candidateNames.has(result.name)) selected.add(result.name)
    }
    if (selected.size === 0) return selected

    for (const spec of candidates) {
      if (selected.size >= this._keep) break
      selected.add(spec.name)
    }
    return selected
  }

  private _fallback(candidateNames: ReadonlySet<string>): ReadonlySet<string> {
    return this._onFailure === 'all' ? candidateNames : new Set()
  }

  /**
   * The agent's previous view, intersected with the current candidates; undefined if nothing
   * survives. With no in-memory view (a restored agent), the tools the last assistant turns called
   * stand in for it: those are durable, and they are what the model demonstrably saw and used.
   */
  private _carryForward(
    agent: LocalAgent,
    history: readonly Message[],
    candidateNames: ReadonlySet<string>
  ): ReadonlySet<string> | undefined {
    const previous = this._previous.get(agent) ?? toolsUsedInLastTurn(history)
    const carried = new Set([...previous].filter((name) => candidateNames.has(name)))
    return carried.size > 0 ? carried : undefined
  }

  /**
   * Keeps `projectedInputTokens` honest for any input middleware that runs after this one. The
   * loop projects against the full catalog before input middleware runs, but only on a cold start;
   * warm calls derive the projection from the previous call's actual usage, which already excluded
   * hidden specs, so subtracting again would double-count. The recount uses the agent's model, as
   * the loop does, rather than the model the call was routed to.
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
}

/**
 * Latest user text is the query; tool-result-only user turns are skipped. A newest turn with no
 * text at all (image-only input) is ranked against the user's previous text rather than treated
 * as a continuation. If an `Offload` strategy targets `userText`, the latest user text may already
 * be its placeholder, and the turn ranks against that.
 */
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

/** True when the history holds an assistant turn, so there is a previous view worth carrying. */
function hasPriorTurn(messages: readonly Message[]): boolean {
  return messages.some((message) => message.role === 'assistant')
}

/** Names of the tools the assistant called since the previous user text turn. */
function toolsUsedInLastTurn(messages: readonly Message[]): ReadonlySet<string> {
  const names = new Set<string>()
  for (let index = messages.length - 2; index >= 0; index--) {
    const message = messages[index]!
    if (message.role === 'user' && message.content.some((block) => block instanceof TextBlock)) break
    for (const block of message.content) {
      if (block instanceof ToolUseBlock) names.add(block.name)
    }
  }
  return names
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

/** Spelled as `contentTerms` emits them: lowercase and plural-normalized (`thank`, `sound`). */
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
  'thank',
  'please',
  'go',
  'ahead',
  'proceed',
  'continue',
  'confirm',
  'confirmed',
  'done',
  'sound',
  'perfect',
  'alright',
  'cool',
  'awesome',
  'nice',
  'yup',
  'agreed',
  'understood',
  'exactly',
  'absolutely',
])

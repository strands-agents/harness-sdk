/**
 * Offload conditions: when a strategy fires, how large content must be to act on, and what it protects.
 */

import { logger } from '../../../logging/logger.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ContextState } from '../../types.js'
import { DEFAULT_CONTEXT_WINDOW_LIMIT } from '../../../models/defaults.js'

/**
 * A share of a whole, written as a percent string such as `'70%'` or `'12.5%'`.
 *
 * @internal
 */
export type Percent = `${number}%`

/**
 * Conditions that determine when and how an offload strategy fires.
 *
 * - `contextUtilization` sets when the strategy fires. `'80%'` fires at 80% of the context window; a whole number of
 *   1,000 or more fires at that many conversation tokens, and throws if it exceeds the model's `contextWindowLimit`.
 * - `blockThreshold` sets how large each block, or each message for target `'*'`, must be to act on. A whole number
 *   selects content larger than that many tokens; `'5%'` selects content larger than 5% of the context window (10,000
 *   tokens of a 200,000-token window).
 * - `preserveRecent` sets which matching messages it never touches. A whole number keeps that many of the newest;
 *   `'70%'` keeps the newest 70% of them.
 *
 * With no `contextUtilization`, the strategy runs before every model call, or on each message as it arrives when the
 * target isn't `'*'` and `preserveRecent` is unset.
 *
 * Granularity: target `'*'` acts on whole messages, and `blockThreshold` measures each message. Drop removes them,
 * summarize merges each contiguous run, and truncate elides the middle or, with a `blockThreshold`, shortens each one.
 * Any other target acts on each block, and `blockThreshold` measures each block. `contextUtilization` only gates when
 * the strategy fires, and `preserveRecent` only protects the newest matching messages.
 *
 * Strategies run as an ordered pipeline, so once an earlier strategy shrinks a block, it falls below the next
 * strategy's threshold and gets skipped.
 *
 * @experimental
 */
export interface OffloadConditions {
  /**
   * Context usage at or above which the strategy fires: `'80%'` of the context window, or a whole number of 1,000 or
   * more for conversation tokens, at most the model's `contextWindowLimit`.
   */
  contextUtilization?: number | Percent

  /**
   * Size above which a message (target `'*'`) or block is offloaded: a whole number of tokens above 0, or `'5%'` of the
   * context window. Unset, there is no size check. Media the token count can't measure always passes.
   */
  blockThreshold?: number | Percent

  /**
   * Newest matching messages never touched: a count, or `'70%'` of the matches, rounded up so a share above 0 keeps at
   * least one.
   */
  preserveRecent?: number | Percent
}

type ConditionName = keyof OffloadConditions

/**
 * A parsed condition: a count in the condition's unit, or a share of a whole.
 *
 * @internal
 */
export class ParsedCondition {
  /**
   * @param value - The count, or the share in `[0, 1]`
   * @param isShare - Whether `value` is a share of a whole rather than a count
   */
  constructor(
    readonly value: number,
    readonly isShare: boolean
  ) {}

  /** The count this condition stands for out of `whole`, rounded up. */
  of(whole: number): number {
    return this.isShare ? Math.ceil(this.value * whole) : this.value
  }
}

const PERCENT_PATTERN = /^\d+(\.\d+)?%$/

/** Smaller whole numbers are almost always a percent written without "%", like `contextUtilization: 80`. */
const MIN_UTILIZATION_TOKENS = 1000

/** Per condition: the accepted range for a `'N%'` value's N, the smallest whole count, and the accepted forms. */
const CONDITION_RULES = {
  contextUtilization: {
    percentInRange: (percent: number): boolean => percent > 0 && percent <= 100,
    minCount: MIN_UTILIZATION_TOKENS,
    expected: `a "N%" string up to "100%" or a whole token count of at least ${MIN_UTILIZATION_TOKENS}`,
  },
  blockThreshold: {
    percentInRange: (percent: number): boolean => percent > 0 && percent < 100,
    minCount: 1,
    expected: 'a "N%" string below "100%" or a whole token count above 0',
  },
  preserveRecent: {
    percentInRange: (percent: number): boolean => percent >= 0 && percent < 100,
    minCount: 0,
    expected: 'a "N%" string below "100%" or a whole message count',
  },
} satisfies Record<ConditionName, object>

/**
 * Parses one offload condition value: a `'N%'` string is a share, and a whole number is a count.
 *
 * @param name - The condition name
 * @param raw - The value as supplied, or undefined when unset
 * @returns The parsed condition, or undefined when unset
 * @throws Error when the value is not accepted for the condition
 * @internal
 */
export function parseCondition(name: ConditionName, raw: unknown): ParsedCondition | undefined {
  if (raw === undefined) return undefined
  const rule = CONDITION_RULES[name]
  if (typeof raw === 'string' && PERCENT_PATTERN.test(raw)) {
    const percent = Number(raw.slice(0, -1))
    if (rule.percentInRange(percent)) return new ParsedCondition(percent / 100, true)
  }
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= rule.minCount) return new ParsedCondition(raw, false)
  throw new Error(`${name}=${formatConditionValue(raw)} is invalid: expected ${rule.expected}${percentHint(raw)}`)
}

/** Suggests the `'N%'` spelling for a rejected number that reads as a share or a percent. */
function percentHint(raw: unknown): string {
  if (typeof raw !== 'number' || !(raw > 0 && raw <= 100)) return ''
  const percent = raw <= 1 ? Number((raw * 100).toPrecision(6)) : raw
  return `; for ${percent}%, write "${percent}%"`
}

function formatConditionValue(raw: unknown): string {
  return typeof raw === 'string' ? `"${raw}"` : String(raw)
}

/** The model's context window limit, falling back to the default `estimateUtilization` uses. */
function effectiveWindowLimit(agent: LocalAgent): number {
  return agent.model.getConfig().contextWindowLimit || DEFAULT_CONTEXT_WINDOW_LIMIT
}

/**
 * A strategy's parsed conditions, and what they resolve to on an agent.
 *
 * @internal
 */
export class ResolvedConditions {
  readonly contextUtilization: ParsedCondition | undefined
  readonly blockThreshold: ParsedCondition | undefined
  readonly preserveRecent: ParsedCondition | undefined

  /**
   * @param conditions - The conditions as supplied
   * @throws Error when a condition name is unknown or its value is invalid
   */
  constructor(conditions: OffloadConditions | undefined) {
    for (const name of Object.keys(conditions ?? {})) {
      if (!Object.hasOwn(CONDITION_RULES, name)) {
        throw new Error(`unknown condition "${name}": expected contextUtilization, blockThreshold, or preserveRecent`)
      }
    }
    this.contextUtilization = parseCondition('contextUtilization', conditions?.contextUtilization)
    this.blockThreshold = parseCondition('blockThreshold', conditions?.blockThreshold)
    const preserveRecent = parseCondition('preserveRecent', conditions?.preserveRecent)
    this.preserveRecent = preserveRecent?.value === 0 ? undefined : preserveRecent
  }

  /** Whether no condition narrows when or what the strategy acts on. */
  get isEmpty(): boolean {
    return this.contextUtilization === undefined && this.blockThreshold === undefined && !this.preserveRecent
  }

  /** Whether something other than size defers the strategy past a message's arrival. */
  get defersArrival(): boolean {
    return this.contextUtilization !== undefined || this.preserveRecent !== undefined
  }

  /** Whether the utilization gate (if any) is open: on overflow, or at or above the configured share. */
  reached(context: ContextState): boolean {
    const utilization = this.contextUtilization
    if (!utilization || context.overflow) return true
    const share = utilization.isShare ? utilization.value : utilization.value / effectiveWindowLimit(context.agent)
    return context.utilization >= share
  }

  /** Tokens above which content is offloaded, or undefined when `blockThreshold` is unset so no size check applies. */
  thresholdTokens(agent: LocalAgent): number | undefined {
    const threshold = this.blockThreshold
    if (!threshold) return undefined
    return threshold.isShare ? threshold.of(effectiveWindowLimit(agent)) : threshold.value
  }

  /** `matching` without the newest ones `preserveRecent` protects. */
  withoutPreserved<T>(matching: T[]): T[] {
    const keep = this.preserveRecent?.of(matching.length) ?? 0
    return keep >= matching.length ? [] : matching.slice(0, matching.length - keep)
  }

  /**
   * Checks a token-count `contextUtilization` fits the model's context window.
   *
   * @throws Error when it is larger than the model's `contextWindowLimit`
   */
  checkFits(agent: LocalAgent): void {
    const utilization = this.contextUtilization
    if (!utilization || utilization.isShare) return
    const limit = agent.model.getConfig().contextWindowLimit
    if (!limit) {
      logger.warn(
        `contextUtilization=<${utilization.value}> | contextWindowLimit is not set on the model, skipping the context window check | set contextWindowLimit in your model config`
      )
      return
    }
    if (utilization.value <= limit) return
    throw new Error(
      `contextUtilization (${utilization.value}) is larger than the model's context window (${limit} tokens); use a smaller token count or a "N%" share`
    )
  }
}

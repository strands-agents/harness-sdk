/**
 * Prompt-caching modes: the strategies a caller may ask for in `CacheConfig.strategy`, the modes a model resolves
 * to, and the one table that turns the first into the second for every provider.
 */

import type { CacheConfig } from './model.js'
import type { PromptCaching } from './model-info.js'

/**
 * A prompt-caching strategy to ask for in `CacheConfig.strategy`.
 *
 * - `'auto'`: the most capable mode the provider and model support (see {@link ResolvedCacheStrategy})
 * - `'sdk'`, `'provider'`, `'implicit'`, `'manual'`: that mode; one the provider or model cannot apply warns once
 *   and falls back to `'auto'`
 * - `'anthropic'`: same as `'sdk'`
 */
export type CacheStrategy =
  | 'auto'
  | 'sdk'
  | 'provider'
  | 'implicit'
  | 'manual'
  /** @deprecated Use `'sdk'`. */
  | 'anthropic'

/**
 * The prompt-caching mode a model runs in, read from `Model.resolvedCacheStrategy`.
 *
 * - `'sdk'`: the SDK places cache points
 * - `'provider'`: the provider's own explicit caching mechanism; no provider applies it yet
 * - `'implicit'`: the provider caches by prompt prefix with nothing sent by the SDK
 * - `'manual'`: the SDK places no cache points; cache points in the messages and system prompt are sent as written
 */
export type ResolvedCacheStrategy = 'sdk' | 'provider' | 'implicit' | 'manual'

/**
 * The provider rules that resolve a `CacheConfig`: `'converse'` is Bedrock Converse, `'none'` is a provider that
 * does not apply `cacheConfig`.
 *
 * @internal
 */
export type CacheStrategyRules = 'converse' | 'anthropic' | 'openaiResponses' | 'openaiChat' | 'none'

/**
 * What a model's facts say about its caching.
 *
 * @internal
 */
export interface CacheStrategyFacts {
  /** How the model caches prompts, from the resolved model info. */
  readonly promptCaching?: PromptCaching | undefined
  /** The model id; on Converse an unlisted id naming Claude takes cache points. */
  readonly modelId?: string | undefined
}

/**
 * A resolved cache strategy and how it was reached.
 *
 * @internal
 */
export interface CacheStrategyResolution {
  /** The mode the model runs in. */
  readonly strategy: ResolvedCacheStrategy
  /** Whether `strategy` is what `'auto'` resolved to for an applied `cacheConfig`, asked for or fallen back to. */
  readonly auto: boolean
  /** The explicit strategy the provider or model cannot apply, set when it fell back to `'auto'`. */
  readonly unsupported?: string
  /** Whether a `cacheConfig` is set on a provider that does not apply it. */
  readonly ignored: boolean
}

interface StrategyTable {
  /** Explicit modes the provider applies to a model. */
  honors(promptCaching: PromptCaching | undefined): readonly ResolvedCacheStrategy[]
  /** What `'auto'` resolves to with a `cacheConfig` set. */
  auto(promptCaching: PromptCaching | undefined): ResolvedCacheStrategy
  /** What the model runs in with no `cacheConfig` (or `false`). */
  unconfigured(promptCaching: PromptCaching | undefined): ResolvedCacheStrategy
}

const implicitOrManual = (promptCaching: PromptCaching | undefined): ResolvedCacheStrategy =>
  promptCaching === 'auto' ? 'implicit' : 'manual'

// OpenAI caches every prefix server-side, unless a `modelInfo` override says the model does not cache.
const implicitUnlessUnsupported = (promptCaching: PromptCaching | undefined): ResolvedCacheStrategy =>
  promptCaching === 'unsupported' ? 'manual' : 'implicit'

const TABLES: Readonly<Record<CacheStrategyRules, StrategyTable>> = {
  // `sdk` is honored on any model, so an ARN or prompt router the data cannot describe can still opt in.
  converse: {
    honors: (promptCaching) => (promptCaching === 'auto' ? ['sdk', 'implicit', 'manual'] : ['sdk', 'manual']),
    auto: (promptCaching) => (promptCaching === 'cachePoints' ? 'sdk' : implicitOrManual(promptCaching)),
    unconfigured: implicitOrManual,
  },
  anthropic: {
    honors: () => ['sdk', 'manual'],
    auto: (promptCaching) => (promptCaching === 'unsupported' ? 'manual' : 'sdk'),
    unconfigured: () => 'manual',
  },
  openaiResponses: {
    honors: (promptCaching) =>
      promptCaching === 'cachePoints' ? ['sdk', 'implicit', 'manual'] : ['implicit', 'manual'],
    auto: (promptCaching) => (promptCaching === 'cachePoints' ? 'sdk' : implicitUnlessUnsupported(promptCaching)),
    unconfigured: implicitUnlessUnsupported,
  },
  openaiChat: {
    honors: () => ['implicit', 'manual'],
    auto: implicitUnlessUnsupported,
    unconfigured: implicitUnlessUnsupported,
  },
  none: {
    honors: () => [],
    auto: implicitOrManual,
    unconfigured: implicitOrManual,
  },
}

/**
 * Resolves the prompt-caching mode a model runs in from its `cacheConfig`, its facts and its provider's rules.
 *
 * @internal
 * @param cacheConfig - The configured `cacheConfig`; `false` and `undefined` turn caching off
 * @param rules - The provider rules to resolve with
 * @param facts - What the model info says about the model
 * @returns The mode, whether `'auto'` chose it, and the explicit strategy that fell back, if any
 */
export function resolveCacheStrategy(
  cacheConfig: CacheConfig | false | undefined,
  rules: CacheStrategyRules,
  facts: CacheStrategyFacts
): CacheStrategyResolution {
  const table = TABLES[rules]
  const promptCaching = rules === 'converse' ? conversePromptCaching(facts) : facts.promptCaching
  if (!cacheConfig || rules === 'none') {
    return { strategy: table.unconfigured(promptCaching), auto: false, ignored: Boolean(cacheConfig) }
  }
  const requested = cacheConfig.strategy === 'anthropic' ? 'sdk' : (cacheConfig.strategy ?? 'auto')
  const honored = table.honors(promptCaching).find((strategy) => strategy === requested)
  if (honored) {
    return { strategy: honored, auto: false, ignored: false }
  }
  const strategy = table.auto(promptCaching)
  if (requested === 'auto') {
    return { strategy, auto: true, ignored: false }
  }
  return { strategy, auto: true, unsupported: String(cacheConfig.strategy), ignored: false }
}

/**
 * The `cacheConfig` to apply, or `undefined` when caching is off.
 *
 * @internal
 * @param cacheConfig - The configured `cacheConfig`
 * @returns The config object, or `undefined` for `false` and `undefined`
 */
export function appliedCacheConfig(cacheConfig: CacheConfig | false | undefined): CacheConfig | undefined {
  return cacheConfig || undefined
}

// Unlisted Converse ids (a Claude release newer than the data, a prompt-router or custom-model ARN) keep the
// name test so caching does not turn off until the data catches up.
function conversePromptCaching(facts: CacheStrategyFacts): PromptCaching | undefined {
  if (facts.promptCaching !== undefined) return facts.promptCaching
  const modelId = facts.modelId?.toLowerCase() ?? ''
  return modelId.includes('claude') || modelId.includes('anthropic') ? 'cachePoints' : undefined
}

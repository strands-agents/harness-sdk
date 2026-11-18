import { describe, expect, it } from 'vitest'
import {
  appliedCacheConfig,
  resolveCacheStrategy,
  type CacheStrategyFacts,
  type CacheStrategyResolution,
  type CacheStrategyRules,
} from '../cache-strategy.js'
import type { CacheConfig } from '../model.js'

type Row = [CacheStrategyRules, CacheConfig | false | undefined, CacheStrategyFacts, CacheStrategyResolution]

const CACHE_POINTS: CacheStrategyFacts = { promptCaching: 'cachePoints' }
const IMPLICIT: CacheStrategyFacts = { promptCaching: 'auto' }
const UNSUPPORTED: CacheStrategyFacts = { promptCaching: 'unsupported' }
const UNKNOWN: CacheStrategyFacts = {}

const chosen = (strategy: CacheStrategyResolution['strategy']): CacheStrategyResolution => ({
  strategy,
  auto: false,
  ignored: false,
})
const byAuto = (strategy: CacheStrategyResolution['strategy']): CacheStrategyResolution => ({
  strategy,
  auto: true,
  ignored: false,
})
const fellBack = (strategy: CacheStrategyResolution['strategy'], unsupported: string): CacheStrategyResolution => ({
  strategy,
  auto: true,
  unsupported,
  ignored: false,
})

const ROWS: Row[] = [
  // Converse: explicit sdk on any model, implicit only where Converse caches implicitly, manual
  ['converse', {}, CACHE_POINTS, byAuto('sdk')],
  ['converse', { strategy: 'auto' }, CACHE_POINTS, byAuto('sdk')],
  ['converse', {}, IMPLICIT, byAuto('implicit')],
  ['converse', {}, UNSUPPORTED, byAuto('manual')],
  ['converse', {}, UNKNOWN, byAuto('manual')],
  ['converse', {}, { modelId: 'us.anthropic.claude-unlisted-9' }, byAuto('sdk')],
  ['converse', {}, { modelId: 'arn:aws:bedrock:us-east-1:1:application-inference-profile/x' }, byAuto('manual')],
  ['converse', {}, { promptCaching: 'unsupported', modelId: 'anthropic.claude-x' }, byAuto('manual')],
  ['converse', { strategy: 'sdk' }, UNKNOWN, chosen('sdk')],
  ['converse', { strategy: 'anthropic' }, UNSUPPORTED, chosen('sdk')],
  ['converse', { strategy: 'implicit' }, IMPLICIT, chosen('implicit')],
  ['converse', { strategy: 'implicit' }, CACHE_POINTS, fellBack('sdk', 'implicit')],
  ['converse', { strategy: 'manual' }, CACHE_POINTS, chosen('manual')],
  ['converse', undefined, CACHE_POINTS, chosen('manual')],
  ['converse', false, CACHE_POINTS, chosen('manual')],
  ['converse', undefined, IMPLICIT, chosen('implicit')],
  ['converse', false, IMPLICIT, chosen('implicit')],

  // Anthropic: sdk and manual
  ['anthropic', {}, UNKNOWN, byAuto('sdk')],
  ['anthropic', {}, CACHE_POINTS, byAuto('sdk')],
  ['anthropic', {}, UNSUPPORTED, byAuto('manual')],
  ['anthropic', { strategy: 'sdk' }, UNSUPPORTED, chosen('sdk')],
  ['anthropic', { strategy: 'anthropic' }, UNSUPPORTED, chosen('sdk')],
  ['anthropic', { strategy: 'manual' }, CACHE_POINTS, chosen('manual')],
  ['anthropic', { strategy: 'implicit' }, CACHE_POINTS, fellBack('sdk', 'implicit')],
  ['anthropic', undefined, CACHE_POINTS, chosen('manual')],
  ['anthropic', false, CACHE_POINTS, chosen('manual')],

  // OpenAI Responses: sdk only on models that take cache points, implicit, manual
  ['openaiResponses', {}, CACHE_POINTS, byAuto('sdk')],
  ['openaiResponses', {}, UNKNOWN, byAuto('implicit')],
  ['openaiResponses', {}, UNSUPPORTED, byAuto('manual')],
  ['openaiResponses', { strategy: 'sdk' }, CACHE_POINTS, chosen('sdk')],
  ['openaiResponses', { strategy: 'sdk' }, UNKNOWN, fellBack('implicit', 'sdk')],
  ['openaiResponses', { strategy: 'anthropic' }, UNKNOWN, fellBack('implicit', 'anthropic')],
  ['openaiResponses', { strategy: 'implicit' }, CACHE_POINTS, chosen('implicit')],
  ['openaiResponses', { strategy: 'manual' }, CACHE_POINTS, chosen('manual')],
  ['openaiResponses', undefined, CACHE_POINTS, chosen('implicit')],
  ['openaiResponses', false, CACHE_POINTS, chosen('implicit')],

  // OpenAI Chat Completions: implicit and manual
  ['openaiChat', {}, CACHE_POINTS, byAuto('implicit')],
  ['openaiChat', {}, UNSUPPORTED, byAuto('manual')],
  ['openaiChat', { strategy: 'implicit' }, UNKNOWN, chosen('implicit')],
  ['openaiChat', { strategy: 'manual' }, UNKNOWN, chosen('manual')],
  ['openaiChat', { strategy: 'sdk' }, CACHE_POINTS, fellBack('implicit', 'sdk')],
  ['openaiChat', undefined, UNKNOWN, chosen('implicit')],
  ['openaiChat', false, UNKNOWN, chosen('implicit')],

  // A provider that does not apply cacheConfig resolves from the model info and reports the config as ignored
  ['none', undefined, IMPLICIT, chosen('implicit')],
  ['none', undefined, CACHE_POINTS, chosen('manual')],
  ['none', undefined, UNKNOWN, chosen('manual')],
  ['none', false, IMPLICIT, chosen('implicit')],
  ['none', {}, IMPLICIT, { strategy: 'implicit', auto: false, ignored: true }],
  ['none', { strategy: 'sdk' }, UNKNOWN, { strategy: 'manual', auto: false, ignored: true }],
]

describe('resolveCacheStrategy', () => {
  it.each(ROWS)('%s cacheConfig=%j facts=%j', (rules, cacheConfig, facts, expected) => {
    expect(resolveCacheStrategy(cacheConfig, rules, facts)).toStrictEqual(expected)
  })

  it('reports a misspelled strategy as unsupported and resolves auto', () => {
    const cacheConfig = { strategy: 'sometimes' } as unknown as CacheConfig
    expect(resolveCacheStrategy(cacheConfig, 'anthropic', UNKNOWN)).toStrictEqual(fellBack('sdk', 'sometimes'))
  })
})

describe('appliedCacheConfig', () => {
  it.each([
    [undefined, undefined],
    [false, undefined],
    [{ ttl: '1h' }, { ttl: '1h' }],
  ] as const)('%j → %j', (cacheConfig, expected) => {
    expect(appliedCacheConfig(cacheConfig)).toStrictEqual(expected)
  })
})

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CONTEXT_WINDOW_LIMIT,
  cachePointsOnlyOffApi,
  lookupCachePointRules,
  lookupModelInfo,
  getContextWindowLimit,
  lookupModel,
} from '../model-info.js'
import modelInfoData from '../model-info.json' with { type: 'json' }

describe('shared model info data', () => {
  it('resolves every spelling of a model to its one entry', () => {
    const entry = lookupModel('claude-opus-5-5')
    expect(entry?.limits?.contextWindow).toBe(1_000_000)
    expect(lookupModel('anthropic.claude-opus-5-5')).toBe(entry)
    expect(lookupModel('us.anthropic.claude-opus-5-5')).toBe(entry)
    expect(lookupModel('arn:aws:bedrock:us-west-2:123:inference-profile/global.anthropic.claude-opus-5-5')).toBe(entry)
  })

  it('resolves a dated snapshot to the undated model', () => {
    expect(lookupModel('anthropic.claude-opus-5-5-20260401-v1:0')).toBe(lookupModel('claude-opus-5-5'))
    expect(lookupModel('claude-haiku-4-5@20251001')).toBe(lookupModel('claude-haiku-4-5'))
    expect(lookupModel('claude-3-5-haiku-20241022')?.limits?.contextWindow).toBe(200_000)
  })

  it('does not read inherited object keys', () => {
    expect(lookupModel('toString')).toBeUndefined()
    expect(lookupModel('x.constructor')).toBeUndefined()
  })

  it('ignores a trailing Bedrock version suffix', () => {
    expect(lookupModel('anthropic.claude-3-5-haiku-20241022-v1:0')).toBe(lookupModel('claude-3-5-haiku-20241022'))
    expect(lookupModel('us.anthropic.claude-3-5-sonnet-20241022-v2:0')?.limits?.contextWindow).toBe(200_000)
  })

  it('keeps the typed fields and skips the rest', () => {
    // The data entry also carries defaultEffort, which the SDK does not type.
    expect(lookupModelInfo('claude-opus-5-5')).toStrictEqual({
      capabilities: {
        promptCaching: 'cachePoints',
        forcedToolChoice: false,
        nativeStructuredOutput: true,
        serverSideSummary: true,
        temporaryMessages: true,
      },
      limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    })
  })

  it('returns undefined for unknown ids', () => {
    expect(lookupModel('unknown-model')).toBeUndefined()
    expect(lookupModel('')).toBeUndefined()
  })

  it('returns the entry facts and nothing for unknown ids', () => {
    expect(lookupModelInfo('eu.anthropic.claude-sonnet-4-6')).toEqual({
      capabilities: { promptCaching: 'cachePoints' },
      limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    })
    for (const modelId of ['anthropic.claude-opus-5-5', 'global.anthropic.claude-fable-5-2', 'claude-mythos-5-2']) {
      expect(lookupModelInfo(modelId)).toEqual({
        capabilities: {
          promptCaching: 'cachePoints',
          forcedToolChoice: false,
          nativeStructuredOutput: true,
          serverSideSummary: true,
          temporaryMessages: true,
        },
        limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      })
    }
    expect(lookupModelInfo('amazon.nova-pro-v1:0')).toEqual({
      capabilities: { forcedToolChoice: true, nativeStructuredOutput: false, promptCaching: 'cachePoints' },
      limits: { contextWindow: 300_000 },
    })
    expect(lookupModelInfo('claude-future-9')).toEqual({})
    expect(lookupModelInfo('')).toEqual({})
  })

  it('keeps getContextWindowLimit working for ids the Python table already knew', () => {
    expect(getContextWindowLimit('mistral-large-latest')).toBe(1_048_576)
    expect(getContextWindowLimit('o3')).toBe(200_000)
  })

  it('exposes the context window default from the data', () => {
    expect(DEFAULT_CONTEXT_WINDOW_LIMIT).toBe(200_000)
  })

  it('has only the fields ModelInfo defines, with the right types, in every entry', () => {
    const data = modelInfoData as Record<string, unknown>
    expect(Object.keys(data).sort()).toEqual(['$comment', 'defaults', 'models'])
    expect(data.defaults).toEqual({ limits: { contextWindow: expect.any(Number) } })

    for (const [id, entry] of Object.entries(data.models as Record<string, Record<string, Record<string, unknown>>>)) {
      expect(id, id).toMatch(/^[a-z0-9][a-z0-9.:@-]*$/)
      expect(
        Object.keys(entry).every((key) => ['limits', 'capabilities', 'apis', 'cachePointRules'].includes(key)),
        id
      ).toBe(true)
      expectModelInfoShape(id, entry)
      for (const [api, info] of Object.entries(entry.apis ?? {})) {
        expect(['converse'], `${id}.apis.${api}`).toContain(api)
        expect(
          Object.keys(info as object).every((key) => ['limits', 'capabilities'].includes(key)),
          `${id}.apis.${api}`
        ).toBe(true)
        expectModelInfoShape(`${id}.apis.${api}`, info as Record<string, Record<string, unknown>>)
      }
      expectCachePointRulesShape(id, entry.cachePointRules ?? {})
    }
  })
})

function expectModelInfoShape(id: string, entry: Record<string, Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(entry.limits ?? {})) {
    expect(['contextWindow', 'maxOutputTokens'], `${id}.limits.${key}`).toContain(key)
    expect(Number.isInteger(value) && (value as number) > 0, `${id}.limits.${key}`).toBe(true)
  }
  for (const [key, value] of Object.entries(entry.capabilities ?? {})) {
    if (key === 'promptCaching') expect(['unsupported', 'auto', 'cachePoints'], `${id}.${key}`).toContain(value)
    else if (['forcedToolChoice', 'nativeStructuredOutput', 'serverSideSummary', 'temporaryMessages'].includes(key))
      expect(typeof value, `${id}.${key}`).toBe('boolean')
    // Read by another consumer (the harness), not typed by the SDK.
    else if (key === 'defaultEffort')
      expect(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], `${id}.${key}`).toContain(value)
    else throw new Error(`${id}.capabilities.${key} is not a known model info field`)
  }
}

function expectCachePointRulesShape(id: string, rules: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(rules)) {
    if (key === 'cachePointPlacement') expect(['afterText'], `${id}.${key}`).toContain(value)
    else if (['toolsCachePoint', 'cachePointTTL'].includes(key)) expect(typeof value, `${id}.${key}`).toBe('boolean')
    else throw new Error(`${id}.cachePointRules.${key} is not a known cache point rule`)
  }
}

const NOVA_RULES = { cachePointPlacement: 'afterText', toolsCachePoint: false, cachePointTTL: false }

describe('prompt-caching facts', () => {
  it.each([
    ['global.anthropic.claude-sonnet-4-6', 'converse', 'cachePoints', {}],
    ['us.amazon.nova-pro-v1:0', 'converse', 'cachePoints', NOVA_RULES],
    ['us.openai.gpt-6-luna', 'converse', 'auto', {}],
    ['openai.gpt-oss-120b', 'converse', undefined, {}],
    ['us.xai.grok-4.7', 'converse', 'auto', {}],
    ['openai.o3', 'converse', 'auto', {}],
    ['chat-latest', 'converse', 'auto', {}],
    ['openai.gpt-6-luna', undefined, 'cachePoints', {}],
  ] as const)('%s on %s → %s', (modelId, api, promptCaching, rules) => {
    expect(lookupModelInfo(modelId, api).capabilities?.promptCaching).toBe(promptCaching)
    expect(lookupCachePointRules(modelId)).toStrictEqual(rules)
  })

  it('keeps the API facts and cache-point rules out of the model info', () => {
    expect(lookupModelInfo('us.openai.gpt-6-luna', 'converse')).toStrictEqual({
      capabilities: { promptCaching: 'auto' },
      limits: { contextWindow: 1_050_000 },
    })
    expect(lookupModelInfo('amazon.nova-pro-v1:0')).not.toHaveProperty('cachePointRules')
  })

  it.each([
    ['us.openai.gpt-5.6-luna', 'auto'],
    ['us.openai.gpt-6-luna', 'auto'],
    ['openai.gpt-6.1-sol', 'auto'],
    ['us.openai.gpt-5.4', 'auto'],
    ['us.xai.grok-4.7', 'auto'],
    ['amazon.nova-pro-v1:0', 'cachePoints'],
    ['us.amazon.nova-lite-v1:0', 'cachePoints'],
    ['us.amazon.nova-micro-v1:0', 'cachePoints'],
    ['us.amazon.nova-2-lite-v1:0', 'cachePoints'],
    ['openai.gpt-oss-120b-1:0', undefined],
    ['us.openai.gpt-oss-20b-1:0', undefined],
    ['us.amazon.nova-premier-v1:0', undefined],
    ['us.amazon.nova-2-pro-preview-20251202-v1:0', undefined],
    ['global.anthropic.claude-sonnet-4-6', 'cachePoints'],
    ['meta.llama4-maverick-17b-instruct-v1:0', undefined],
  ])('Converse caching for %s → %s', (modelId, promptCaching) => {
    expect(lookupModelInfo(modelId, 'converse').capabilities?.promptCaching).toBe(promptCaching)
  })

  it.each([
    ['amazon.nova-pro-v1:0', true],
    ['us.amazon.nova-pro-v1:0', true],
    ['us.amazon.nova-lite-v1:0', true],
    ['us.amazon.nova-micro-v1:0', true],
    ['us.amazon.nova-2-lite-v1:0', true],
    ['arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-pro-v1:0', true],
    ['us.amazon.nova-premier-v1:0', false],
    ['global.anthropic.claude-sonnet-4-6', false],
    ['us.openai.gpt-6-luna', false],
  ])('Nova cache-point rules for %s → %s', (modelId, nova) => {
    expect(lookupCachePointRules(modelId)).toStrictEqual(nova ? NOVA_RULES : {})
  })

  it.each([
    ['us.openai.gpt-6-luna', true],
    ['openai.gpt-6.1-sol', true],
    ['us.openai.gpt-5.4', false],
    ['openai.gpt-6.1-terra', false],
    ['us.xai.grok-4.7', false],
    ['openai.gpt-oss-120b', false],
    ['global.anthropic.claude-sonnet-4-6', false],
    ['us.amazon.nova-pro-v1:0', false],
  ])('Converse caches %s implicitly while it takes cache points elsewhere → %s', (modelId, expected) => {
    expect(cachePointsOnlyOffApi(modelId, 'converse')).toBe(expected)
  })
})

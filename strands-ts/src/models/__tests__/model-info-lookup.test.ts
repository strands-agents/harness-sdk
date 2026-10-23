import { describe, it, expect } from 'vitest'
import { DEFAULT_CONTEXT_WINDOW_LIMIT, lookupModelInfo, getContextWindowLimit, lookupModel } from '../model-info.js'
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

  it('returns undefined for unknown ids', () => {
    expect(lookupModel('unknown-model')).toBeUndefined()
    expect(lookupModel('')).toBeUndefined()
  })

  it('returns the entry facts and nothing for unknown ids', () => {
    expect(lookupModelInfo('eu.anthropic.claude-sonnet-4-6')).toEqual({
      capabilities: { promptCaching: 'cachePoints' },
      limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    })
    expect(lookupModelInfo('anthropic.claude-opus-5-5').capabilities).toEqual({
      promptCaching: 'cachePoints',
      forcedToolChoice: false,
      nativeStructuredOutput: true,
    })
    expect(lookupModelInfo('amazon.nova-pro-v1:0')).toEqual({
      capabilities: { forcedToolChoice: true, nativeStructuredOutput: false },
      limits: { contextWindow: 300_000 },
    })
    expect(lookupModelInfo('claude-future-9')).toEqual({})
    expect(lookupModelInfo('')).toEqual({})
  })

  it('keeps getContextWindowLimit working for ids the Python table already knew', () => {
    expect(getContextWindowLimit('mistral-large-latest')).toBe(262_144)
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
        Object.keys(entry).every((key) => ['limits', 'capabilities'].includes(key)),
        id
      ).toBe(true)
      for (const [key, value] of Object.entries(entry.limits ?? {})) {
        expect(['contextWindow', 'maxOutputTokens'], `${id}.limits.${key}`).toContain(key)
        expect(Number.isInteger(value) && (value as number) > 0, `${id}.limits.${key}`).toBe(true)
      }
      for (const [key, value] of Object.entries(entry.capabilities ?? {})) {
        if (key === 'promptCaching') expect(['unsupported', 'auto', 'cachePoints'], `${id}.${key}`).toContain(value)
        else if (key === 'forcedToolChoice' || key === 'nativeStructuredOutput')
          expect(typeof value, `${id}.${key}`).toBe('boolean')
        else throw new Error(`${id}.capabilities.${key} is not a ModelCapabilities field`)
      }
    }
  })
})

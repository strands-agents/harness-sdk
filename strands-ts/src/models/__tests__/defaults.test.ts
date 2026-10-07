import { describe, it, expect, vi, afterEach } from 'vitest'
import { getContextWindowLimit } from '../defaults.js'
import { logger } from '../../logging/logger.js'

describe('getContextWindowLimit', () => {
  it('returns the context window limit for known model IDs across all providers', () => {
    // Anthropic direct API
    expect(getContextWindowLimit('claude-sonnet-4-6')).toBe(1_000_000)
    expect(getContextWindowLimit('claude-opus-4-6')).toBe(1_000_000)
    expect(getContextWindowLimit('claude-opus-4-5')).toBe(200_000)
    expect(getContextWindowLimit('claude-haiku-4-5')).toBe(200_000)
    // Bedrock Anthropic
    expect(getContextWindowLimit('anthropic.claude-sonnet-4-6')).toBe(1_000_000)
    // Bedrock Amazon Nova
    expect(getContextWindowLimit('amazon.nova-pro-v1:0')).toBe(300_000)
    expect(getContextWindowLimit('amazon.nova-micro-v1:0')).toBe(128_000)
    // OpenAI
    expect(getContextWindowLimit('gpt-6-astra')).toBe(1_050_000)
    expect(getContextWindowLimit('gpt-5.4')).toBe(1_050_000)
    expect(getContextWindowLimit('gpt-4o')).toBe(128_000)
    expect(getContextWindowLimit('o3')).toBe(200_000)
    expect(getContextWindowLimit('o4-mini')).toBe(200_000)
    // Gemini
    expect(getContextWindowLimit('gemini-2.5-flash')).toBe(1_048_576)
    expect(getContextWindowLimit('gemini-2.5-pro')).toBe(1_048_576)
  })

  it('returns 1M for the current-generation Anthropic models', () => {
    // Guards against the 1M-context 5.5 / 5.1 models resolving to undefined (#4692),
    // which silently disables proactive compression and reports a wrong utilization.
    expect(getContextWindowLimit('claude-sonnet-5-5')).toBe(1_000_000)
    expect(getContextWindowLimit('claude-opus-5-5')).toBe(1_000_000)
    expect(getContextWindowLimit('claude-fable-5-1')).toBe(1_000_000)
    expect(getContextWindowLimit('anthropic.claude-sonnet-5-5')).toBe(1_000_000)
    expect(getContextWindowLimit('anthropic.claude-opus-5-5')).toBe(1_000_000)
    expect(getContextWindowLimit('anthropic.claude-fable-5-1')).toBe(1_000_000)
    expect(getContextWindowLimit('global.anthropic.claude-opus-5-5')).toBe(1_000_000)
    expect(getContextWindowLimit('us.anthropic.claude-fable-5-1')).toBe(1_000_000)
  })

  it('strips Bedrock cross-region prefix before lookup', () => {
    expect(getContextWindowLimit('us.anthropic.claude-sonnet-4-6')).toBe(1_000_000)
    expect(getContextWindowLimit('global.anthropic.claude-sonnet-4-6')).toBe(1_000_000)
  })

  it('strips nested Bedrock prefixes before lookup', () => {
    expect(getContextWindowLimit('us.openai.gpt-5.6-luna')).toBe(1_050_000)
    expect(getContextWindowLimit('global.openai.gpt-5.6-luna')).toBe(1_050_000)
    expect(getContextWindowLimit('global.openai.gpt-6-astra')).toBe(1_050_000)
    expect(
      getContextWindowLimit('arn:aws:bedrock:eu-west-2:123456789012:inference-profile/global.openai.gpt-5.6-luna')
    ).toBe(1_050_000)
  })

  it('resolves one table entry from every provider-prefixed form', () => {
    expect(getContextWindowLimit('gpt-6-astra')).toBe(1_050_000)
    expect(getContextWindowLimit('openai.gpt-6-astra')).toBe(1_050_000)
    expect(getContextWindowLimit('global.openai.gpt-6-astra')).toBe(1_050_000)

    expect(getContextWindowLimit('glm-4.7')).toBe(203_000)
    expect(getContextWindowLimit('zai.glm-4.7')).toBe(203_000)
    expect(getContextWindowLimit('global.zai.glm-4.7')).toBe(203_000)

    expect(getContextWindowLimit('nova-pro-v1:0')).toBe(300_000)
    expect(getContextWindowLimit('amazon.nova-pro-v1:0')).toBe(300_000)
    expect(getContextWindowLimit('us.amazon.nova-pro-v1:0')).toBe(300_000)

    expect(getContextWindowLimit('claude-haiku-4-5-20251001-v1:0')).toBe(200_000)
    expect(getContextWindowLimit('anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(200_000)
    expect(getContextWindowLimit('eu.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(200_000)
  })

  it('strips any prefix as a fallback', () => {
    expect(getContextWindowLimit('custom.anthropic.claude-sonnet-4-6')).toBe(1_000_000)
    expect(getContextWindowLimit('custom.gpt-5.4')).toBe(1_050_000)
    expect(getContextWindowLimit('openai.gpt-6-astra')).toBe(1_050_000)
  })

  it('returns undefined for unknown model IDs', () => {
    expect(getContextWindowLimit('unknown-model-xyz')).toBeUndefined()
    expect(getContextWindowLimit('foo.unknown-model-xyz')).toBeUndefined()
    expect(getContextWindowLimit('us.unknown.model-v1:0')).toBeUndefined()
  })

  it('returns undefined for Object.prototype property names', () => {
    expect(getContextWindowLimit('constructor')).toBeUndefined()
    expect(getContextWindowLimit('x.constructor')).toBeUndefined()
    expect(getContextWindowLimit('global.openai.toString')).toBeUndefined()
    expect(getContextWindowLimit('__proto__')).toBeUndefined()
  })

  describe('debug logging', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('logs the stripped id when a prefix strip resolves the model id', () => {
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})

      getContextWindowLimit('global.openai.gpt-6-astra')

      expect(debugSpy).toHaveBeenCalledOnce()
      expect(debugSpy).toHaveBeenCalledWith(
        'model_id=<global.openai.gpt-6-astra>, stripped_id=<gpt-6-astra> | resolved context window limit via prefix strip'
      )
    })

    it('does not log for a direct match or an unknown model id', () => {
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})

      getContextWindowLimit('gpt-6-astra')
      getContextWindowLimit('us.unknown.model-v1:0')

      expect(debugSpy).not.toHaveBeenCalled()
    })
  })
})

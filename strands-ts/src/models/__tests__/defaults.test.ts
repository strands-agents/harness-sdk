import { describe, it, expect } from 'vitest'
import { getContextWindowLimit } from '../defaults.js'

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

  it('strips Bedrock cross-region prefix before lookup', () => {
    expect(getContextWindowLimit('us.anthropic.claude-sonnet-4-6')).toBe(1_000_000)
    expect(getContextWindowLimit('global.anthropic.claude-sonnet-4-6')).toBe(1_000_000)
  })

  it('does not strip unknown prefixes', () => {
    expect(getContextWindowLimit('custom.gpt-5.4')).toBeUndefined()
  })

  it('returns undefined for unknown model IDs', () => {
    expect(getContextWindowLimit('unknown-model-xyz')).toBeUndefined()
    expect(getContextWindowLimit('us.unknown.model-v1:0')).toBeUndefined()
  })
})

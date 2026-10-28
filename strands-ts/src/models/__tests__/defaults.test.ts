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
    // Bedrock Z.AI (GLM-5.3 resolves to its 1M window, not the 200K default: #5300)
    expect(getContextWindowLimit('zai.glm-4.7')).toBe(203_000)
    expect(getContextWindowLimit('zai.glm-4.7-flash')).toBe(203_000)
    expect(getContextWindowLimit('zai.glm-5')).toBe(200_000)
    expect(getContextWindowLimit('zai.glm-5.3')).toBe(1_000_000)
    expect(getContextWindowLimit('us.zai.glm-5.3')).toBe(1_000_000)
    expect(getContextWindowLimit('global.zai.glm-5.3')).toBe(1_000_000)
    // Bedrock Mistral
    expect(getContextWindowLimit('mistral.mistral-large-3-675b-instruct')).toBe(256_000)
    expect(getContextWindowLimit('mistral.ministral-3-14b-instruct')).toBe(128_000)
    expect(getContextWindowLimit('mistral.ministral-3-8b-instruct')).toBe(128_000)
    expect(getContextWindowLimit('mistral.ministral-3-3b-instruct')).toBe(128_000)
    expect(getContextWindowLimit('mistral.magistral-small-2509')).toBe(128_000)
    expect(getContextWindowLimit('mistral.pixtral-large-2502-v1:0')).toBe(128_000)
    expect(getContextWindowLimit('mistral.mistral-small-2402-v1:0')).toBe(32_000)
    expect(getContextWindowLimit('mistral.mistral-large-2402-v1:0')).toBe(32_000)
    expect(getContextWindowLimit('us.mistral.mistral-large-3-675b-instruct')).toBe(256_000)
    expect(getContextWindowLimit('global.mistral.mistral-large-3-675b-instruct')).toBe(256_000)
    // Bedrock Google Gemma
    expect(getContextWindowLimit('google.gemma-4-31b')).toBe(256_000)
    expect(getContextWindowLimit('google.gemma-4-26b-a4b')).toBe(256_000)
    expect(getContextWindowLimit('google.gemma-4-e2b')).toBe(128_000)
    expect(getContextWindowLimit('us.google.gemma-4-31b')).toBe(256_000)

    // Bedrock xAI
    expect(getContextWindowLimit('xai.grok-4.7')).toBe(524_288)
    expect(getContextWindowLimit('xai.grok-4.6')).toBe(500_000)
    expect(getContextWindowLimit('xai.grok-4.3')).toBe(1_000_000)
    expect(getContextWindowLimit('us.xai.grok-4.7')).toBe(524_288)
    expect(getContextWindowLimit('global.xai.grok-4.7')).toBe(524_288)
    // OpenAI
    expect(getContextWindowLimit('chat-latest')).toBe(272_000)
    expect(getContextWindowLimit('gpt-6-astra')).toBe(1_050_000)
    expect(getContextWindowLimit('gpt-6.1-sol')).toBe(1_050_000)
    expect(getContextWindowLimit('gpt-6-sol')).toBe(1_050_000)
    expect(getContextWindowLimit('gpt-6-luna')).toBe(1_050_000)
    expect(getContextWindowLimit('gpt-5.4')).toBe(1_050_000)
    expect(getContextWindowLimit('gpt-4o')).toBe(128_000)
    expect(getContextWindowLimit('o3')).toBe(200_000)
    expect(getContextWindowLimit('o4-mini')).toBe(200_000)
    expect(getContextWindowLimit('gpt-oss-120b')).toBe(131_072)
    expect(getContextWindowLimit('gpt-oss-20b')).toBe(131_072)
    // Gemini
    expect(getContextWindowLimit('gemini-4-argon')).toBe(1_048_576)
    expect(getContextWindowLimit('gemini-3.8-flash')).toBe(1_048_576)
    expect(getContextWindowLimit('gemini-3.7-flash')).toBe(1_048_576)
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
    // Claude Haiku 5.5 has the same 1M window (#4996).
    expect(getContextWindowLimit('claude-haiku-5-5')).toBe(1_000_000)
    expect(getContextWindowLimit('anthropic.claude-haiku-5-5')).toBe(1_000_000)
    expect(getContextWindowLimit('eu.anthropic.claude-haiku-5-5')).toBe(1_000_000)
    expect(getContextWindowLimit('global.anthropic.claude-haiku-5-5')).toBe(1_000_000)
  })

  it('returns the Bedrock window for gpt-oss, not the OpenAI-hosted one', () => {
    expect(getContextWindowLimit('openai.gpt-oss-120b')).toBe(128_000)
    expect(getContextWindowLimit('openai.gpt-oss-120b-1:0')).toBe(128_000)
    expect(getContextWindowLimit('openai.gpt-oss-20b')).toBe(128_000)
    expect(getContextWindowLimit('openai.gpt-oss-20b-1:0')).toBe(128_000)
    expect(getContextWindowLimit('openai.gpt-oss-safeguard-120b')).toBe(128_000)
    expect(getContextWindowLimit('openai.gpt-oss-safeguard-20b')).toBe(128_000)
    expect(getContextWindowLimit('us.openai.gpt-oss-120b-1:0')).toBe(128_000)
    expect(getContextWindowLimit('global.openai.gpt-oss-120b')).toBe(128_000)
  })

  it('resolves Bedrock GPT ids, which are not derivable from the OpenAI-hosted rows', () => {
    expect(getContextWindowLimit('openai.gpt-6-astra')).toBe(1_050_000)
    expect(getContextWindowLimit('openai.gpt-6.1-sol')).toBe(1_000_000)
    expect(getContextWindowLimit('openai.gpt-6-sol')).toBe(1_050_000)
    expect(getContextWindowLimit('openai.gpt-6-luna')).toBe(1_050_000)
    expect(getContextWindowLimit('openai.gpt-5.6-sol')).toBe(1_050_000)
    expect(getContextWindowLimit('openai.gpt-5.6-terra')).toBe(1_050_000)
    expect(getContextWindowLimit('openai.gpt-5.6-luna')).toBe(1_050_000)
    expect(getContextWindowLimit('openai.gpt-5.5')).toBe(1_050_000)
    expect(getContextWindowLimit('openai.gpt-5.4')).toBe(1_050_000)
    expect(getContextWindowLimit('us.openai.gpt-5.5')).toBe(1_050_000)
    expect(getContextWindowLimit('global.openai.gpt-6.1-sol')).toBe(1_000_000)
    expect(getContextWindowLimit('in.openai.gpt-5.6-luna')).toBe(1_050_000)
  })

  it('strips Bedrock cross-region prefix before lookup', () => {
    expect(getContextWindowLimit('us.anthropic.claude-sonnet-4-6')).toBe(1_000_000)
    expect(getContextWindowLimit('global.anthropic.claude-sonnet-4-6')).toBe(1_000_000)
  })

  it('strips leading segments one at a time, like the Python SDK, so unknown prefixes and ARNs resolve', () => {
    expect(getContextWindowLimit('custom.gpt-5.4')).toBe(getContextWindowLimit('gpt-5.4'))
    expect(
      getContextWindowLimit('arn:aws:bedrock:us-west-2:123:inference-profile/us.anthropic.claude-sonnet-4-6')
    ).toBe(1_000_000)
  })

  it('returns undefined for unknown model IDs', () => {
    expect(getContextWindowLimit('unknown-model-xyz')).toBeUndefined()
    expect(getContextWindowLimit('us.unknown.model-v1:0')).toBeUndefined()
  })
})

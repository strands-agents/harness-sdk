import { describe, expect, it } from 'vitest'

import { modelDisplayName } from '../src/tui/model/display.js'

describe('model display names', () => {
  it('presents Bedrock model IDs as official model names', () => {
    expect(modelDisplayName('global.anthropic.claude-opus-4-8')).toBe('Claude Opus 4.8')
    expect(modelDisplayName('bedrock/openai.gpt-5.6-sol')).toBe('GPT-5.6 Sol')
    expect(modelDisplayName('bedrock/google.gemini-3.5-flash')).toBe('Gemini 3.5 Flash')
    expect(modelDisplayName('us.xai.grok-4.6')).toBe('Grok 4.6')
    expect(modelDisplayName('bedrock/us.xai.grok-3-mini')).toBe('Grok 3 Mini')
  })

  it('preserves unknown identifiers', () => {
    expect(modelDisplayName('bedrock/custom-model')).toBe('bedrock/custom-model')
    expect(modelDisplayName('Custom Model')).toBe('Custom Model')
  })
})

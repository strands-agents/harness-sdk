import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic'
import { lookupModel } from '../src/model-info.js'
import { EFFORT_LEVELS } from '../src/models.js'

describe('lookupModel', () => {
  it('reads a copy equal to the shared data', () => {
    const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf-8')
    expect(read('../src/model-info.json')).toBe(read('../../shared/model-info.json'))
  })

  it.each([
    'claude-opus-5-5',
    'global.anthropic.claude-opus-5-5',
    'us.anthropic.claude-opus-5-5-20260401-v1:0',
    'arn:aws:bedrock:us-west-2:123:inference-profile/global.anthropic.claude-opus-5-5',
  ])('resolves %s to its entry', (modelId) => {
    expect(lookupModel(modelId)).toBe(lookupModel('claude-opus-5-5'))
    expect(lookupModel(modelId).limits?.maxOutputTokens).toBe(128_000)
    expect(lookupModel(modelId).capabilities?.defaultEffort).toBe('medium')
  })

  it('has an empty entry for an unknown model', () => {
    expect(lookupModel('unknown-model')).toEqual({})
    expect(lookupModel('toString')).toEqual({})
  })

  it('gives every default effort as an effort level', () => {
    const data = JSON.parse(readFileSync(new URL('../../shared/model-info.json', import.meta.url), 'utf-8')) as {
      models: Record<string, { capabilities?: { defaultEffort?: string } }>
    }
    for (const [id, entry] of Object.entries(data.models)) {
      const level = entry.capabilities?.defaultEffort
      if (level !== undefined) expect(EFFORT_LEVELS.slice(2), id).toContain(level)
    }
  })

  it.each([
    'claude-opus-5-5',
    'us.anthropic.claude-opus-5-5-20260401-v1:0',
    'arn:aws:bedrock:us-west-2:123:inference-profile/global.anthropic.claude-haiku-4-5-20251001-v1:0',
    'claude-haiku-4-5@20251001',
    'anthropic.claude-3-5-haiku-20241022-v2:0',
    'openai.gpt-6.1-sol',
    'global.openai.gpt-6-astra',
    'amazon.nova-pro-v1:0',
    'gemini-3.5-flash',
    'unknown-model',
  ])('matches %s to the same entry as the SDK', (modelId) => {
    const sdk = new AnthropicModel({ modelId, apiKey: 'test' }).modelInfo
    expect(lookupModel(modelId).limits?.maxOutputTokens).toBe(sdk.limits?.maxOutputTokens)
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { lookupModel } from '../src/model-info.js'

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
})

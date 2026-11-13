import { describe, expect, it } from 'vitest'
import { generatorModelId, generatorModelProblem } from '../../../src/dev/temporary-evals-fork/generator-model.js'

describe('separate Bedrock generator connection', () => {
  it.each(['openai.gpt-6.1-sol', 'openai/gpt-5', 'anthropic/claude-sonnet-4-6', 'ollama/local', 'made-up'])(
    'rejects ambiguous or non-Bedrock model %s before running',
    (model) => {
      expect(generatorModelProblem(model)).toContain('not the chat provider')
      expect(() => generatorModelId(model)).toThrow('Choose a Bedrock model ID')
    }
  )
  it.each([
    ['', ''],
    [
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet',
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet',
    ],
    ['global.anthropic.claude-sonnet-4-6', 'global.anthropic.claude-sonnet-4-6'],
    ['bedrock/amazon.nova-pro-v1:0', 'amazon.nova-pro-v1:0'],
    ['bedrock/openai.gpt-oss-120b-1:0', 'openai.gpt-oss-120b-1:0'],
  ])('normalizes explicit Bedrock selection %s', (model, id) => {
    expect(generatorModelProblem(model)).toBeUndefined()
    expect(generatorModelId(model)).toBe(id)
  })
})

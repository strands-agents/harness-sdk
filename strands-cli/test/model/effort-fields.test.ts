import { afterEach, describe, expect, it, vi } from 'vitest'

import { effortFieldsKey, ModelEffortUnavailable, modelEffort } from '../../src/model/effort-fields.js'

const SONNET = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'
const OPUS = 'global.anthropic.claude-opus-4-6-v1'

const bedrock = (fields?: unknown, maxTokens?: number) =>
  modelEffort({ className: 'BedrockModel', python: false, modelId: SONNET, fields, maxTokens })

afterEach(() => vi.unstubAllEnvs())

describe('modelEffort', () => {
  it('shouldListTheLevelsTheHarnessAcceptsForTheModelIdWhenTheModelIsABedrockObject', async () => {
    const effort = await bedrock()

    expect(effort.spec).toBe(`bedrock/${SONNET}`)
    expect(effort.levels).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it.each([
    ['off', undefined],
    ['low', { thinking: { type: 'enabled', budget_tokens: 2048 } }],
    ['auto', { thinking: { type: 'enabled', budget_tokens: 16384 } }],
  ])('shouldReturnTheHarnessReasoningFieldsWhenTheEffortIs %s', async (level, fields) => {
    const effort = await bedrock()

    expect(effort.fieldsFor(level)).toEqual(fields)
  })

  it('shouldKeepTheOtherFieldsAndReplaceOnlyTheReasoningFieldsWhenTheEffortChanges', async () => {
    const effort = await bedrock({ thinking: { type: 'enabled', budget_tokens: 4000 }, anthropic_beta: ['beta'] })

    expect(effort.fieldsFor('medium')).toEqual({
      anthropic_beta: ['beta'],
      thinking: { type: 'enabled', budget_tokens: 8192 },
    })
    expect(effort.fieldsFor('off')).toEqual({ anthropic_beta: ['beta'] })
  })

  it('shouldKeepTheThinkingBudgetBelowTheMaximumTokensWhenTheModelSetsThem', async () => {
    const effort = await bedrock(undefined, 4096)

    expect(effort.fieldsFor('high')).toEqual({ thinking: { type: 'enabled', budget_tokens: 4095 } })
  })

  it.each([
    ['off', undefined],
    ['low', { thinking: { type: 'enabled', budget_tokens: 2048 } }],
    ['auto', { thinking: { type: 'enabled', budget_tokens: 3000 } }],
  ])('shouldReportTheCurrentLevelAs %s WhenTheModelFieldsMatchIt', async (level, fields) => {
    expect((await bedrock(fields)).current).toBe(level)
  })

  it('shouldSetAdaptiveThinkingAndTheEffortWhenTheModelUsesAdaptiveThinking', async () => {
    const effort = await modelEffort({ className: 'BedrockModel', python: false, modelId: OPUS, fields: undefined })

    expect(effort.fieldsFor('low')).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'low' },
    })
  })

  it('shouldUseTheParamsFieldWhenTheModelIsAnAnthropicObject', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')

    const effort = await modelEffort({
      className: 'AnthropicModel',
      python: false,
      modelId: 'claude-sonnet-4-5',
      fields: undefined,
    })

    expect(effort.fieldsFor('low')).toEqual({ thinking: { type: 'enabled', budget_tokens: 2048 } })
  })

  it.each([
    [
      'an unsupported class',
      { className: 'LlamaModel', python: false, modelId: 'llama' },
      'strands dev can set effort only on BedrockModel, AnthropicModel, OpenAIModel objects, not on LlamaModel.',
    ],
    [
      'the Python Chat Completions class',
      { className: 'OpenAIModel', python: true, modelId: 'gpt-5' },
      'strands dev can set effort only on BedrockModel, AnthropicModel, OpenAIResponsesModel objects, not on OpenAIModel.',
    ],
    [
      'the Chat Completions API',
      { className: 'OpenAIModel', python: false, modelId: 'gpt-5', api: 'chat' },
      'The OpenAIModel uses the Chat Completions API, and the harness sets effort only for the Responses API.',
    ],
    [
      'no model id',
      { className: 'BedrockModel', python: false, modelId: undefined },
      'The BedrockModel sets no model id, so strands dev cannot look up its reasoning settings.',
    ],
  ])('shouldRefuseWhenTheModelHas %s', async (_case, model, message) => {
    await expect(modelEffort({ ...model, fields: undefined })).rejects.toThrow(new ModelEffortUnavailable(message))
  })

  it.each([
    ['BedrockModel', false, 'additionalRequestFields'],
    ['BedrockModel', true, 'additional_request_fields'],
    ['AnthropicModel', true, 'params'],
    ['OpenAIModel', false, 'params'],
    ['OpenAIResponsesModel', true, 'params'],
  ] as const)('shouldNameTheReasoningFieldOf %s WhenPythonIs %s', (className, python, key) => {
    expect(effortFieldsKey(className, python)).toBe(key)
  })

  it.each([
    ['LlamaModel', false],
    ['OpenAIModel', true],
  ] as const)('shouldRefuseToNameAReasoningFieldFor %s WhenPythonIs %s', (className, python) => {
    expect(() => effortFieldsKey(className, python)).toThrow(ModelEffortUnavailable)
  })

  it('shouldNameTheProviderErrorWhenNoLevelCanBeRead', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')

    await expect(
      modelEffort({ className: 'AnthropicModel', python: false, modelId: 'claude-sonnet-4-5', fields: undefined })
    ).rejects.toThrow(/^strands dev could not read the reasoning settings for anthropic\/claude-sonnet-4-5: .*API key/u)
  })

  it('shouldRefuseALevelTheModelDoesNotSupport', async () => {
    const effort = await bedrock()

    expect(() => effort.fieldsFor('minimal')).toThrow(
      `bedrock/${SONNET} does not support effort "minimal". It supports auto, off, low, medium, high, xhigh, max.`
    )
  })
})

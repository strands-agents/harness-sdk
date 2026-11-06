import { describe, it, expect, vi } from 'vitest'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import { BedrockModel } from '../bedrock.js'
import { GoogleModel } from '../google/index.js'
import { OpenAIModel } from '../openai/index.js'
import { VercelModel } from '../vercel.js'
import type { Model } from '../model.js'
import type { ModelInfo } from '../model-info.js'

const MODEL_ID = 'claude-sonnet-5-5'

function vercelProvider(): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'anthropic.messages',
    modelId: MODEL_ID,
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(),
  } as unknown as LanguageModelV3
}

describe('providers without server-side summary', () => {
  it.each<[string, (modelInfo?: ModelInfo) => Model]>([
    [
      'bedrock',
      (modelInfo) =>
        new BedrockModel({ modelId: 'us.anthropic.claude-sonnet-5-5-v1:0', ...(modelInfo && { modelInfo }) }),
    ],
    [
      'openai chat',
      (modelInfo) => new OpenAIModel({ api: 'chat', modelId: MODEL_ID, apiKey: 'k', ...(modelInfo && { modelInfo }) }),
    ],
    [
      'openai responses',
      (modelInfo) =>
        new OpenAIModel({ api: 'responses', modelId: MODEL_ID, apiKey: 'k', ...(modelInfo && { modelInfo }) }),
    ],
    ['google', (modelInfo) => new GoogleModel({ modelId: MODEL_ID, apiKey: 'k', ...(modelInfo && { modelInfo }) })],
    ['vercel', (modelInfo) => new VercelModel({ provider: vercelProvider(), ...(modelInfo && { modelInfo }) })],
  ])('%s turns it off for listed models unless the modelInfo override sets it', (_name, makeModel) => {
    expect(makeModel().modelInfo.capabilities?.serverSideSummary).toBe(false)
    const override: ModelInfo = { capabilities: { serverSideSummary: true } }
    expect(makeModel(override).modelInfo.capabilities?.serverSideSummary).toBe(true)
  })
})

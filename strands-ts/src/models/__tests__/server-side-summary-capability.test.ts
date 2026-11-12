import { describe, it, expect, vi } from 'vitest'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import type OpenAI from 'openai'
import { BedrockModel } from '../bedrock.js'
import { GoogleModel } from '../google/index.js'
import { OpenAIModel } from '../openai/index.js'
import { VercelModel } from '../vercel.js'
import type { Model } from '../model.js'
import type { ModelInfo } from '../model-info.js'
import { TestModelProvider } from '../../__fixtures__/model-test-helpers.js'
import { Agent } from '../../agent/agent.js'
import { Offload } from '../../context-manager/strategies/offload/index.js'
import { Message, SummaryBlock, TextBlock } from '../../types/messages.js'
import { formatSummarized, offloadPlaceholder, REMOVED_MESSAGES } from '../../context-manager/placeholder.js'

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

describe('models without server-side summary', () => {
  it.each<[string, (modelInfo?: ModelInfo) => Model]>([
    [
      'bedrock',
      (modelInfo) =>
        new BedrockModel({ modelId: 'us.anthropic.claude-sonnet-5-5-v1:0', ...(modelInfo && { modelInfo }) }),
    ],
    [
      'openai chat',
      (modelInfo) =>
        new OpenAIModel({ api: 'chat', modelId: MODEL_ID, client: {} as OpenAI, ...(modelInfo && { modelInfo }) }),
    ],
    [
      'openai responses',
      (modelInfo) =>
        new OpenAIModel({ api: 'responses', modelId: MODEL_ID, client: {} as OpenAI, ...(modelInfo && { modelInfo }) }),
    ],
    ['google', (modelInfo) => new GoogleModel({ modelId: MODEL_ID, apiKey: 'k', ...(modelInfo && { modelInfo }) })],
    ['vercel', (modelInfo) => new VercelModel({ provider: vercelProvider(), ...(modelInfo && { modelInfo }) })],
  ])('%s turns it off for listed models unless the modelInfo override sets it', (_name, makeModel) => {
    expect(makeModel().modelInfo.capabilities?.serverSideSummary).toBe(false)
    const override: ModelInfo = { capabilities: { serverSideSummary: true } }
    expect(makeModel(override).modelInfo.capabilities?.serverSideSummary).toBe(true)
  })
})

describe('a custom provider with a listed id', () => {
  it('stores its summary as text', async () => {
    const requests: Message[][] = []
    const model = new TestModelProvider(async function* () {
      yield { type: 'modelMessageStartEvent', role: 'assistant' }
      yield { type: 'modelContentBlockStartEvent' }
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'a summary' } }
      yield { type: 'modelContentBlockStopEvent' }
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
    })
    model.updateConfig({ modelId: MODEL_ID })
    const stream = model.stream.bind(model)
    vi.spyOn(model, 'stream').mockImplementation((messages, options) => {
      requests.push(messages)
      return stream(messages, options)
    })
    expect(model.modelInfo.capabilities?.serverSideSummary).toBe(true)
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('task')] }),
      new Message({ role: 'assistant', content: [new TextBlock('old1')] }),
      new Message({ role: 'user', content: [new TextBlock('old2')] }),
      new Message({ role: 'assistant', content: [new TextBlock('old3')] }),
      new Message({ role: 'user', content: [new TextBlock('recent')] }),
    ]
    const tokens = await model.countTokens(messages.slice(1, 4))
    const agent = new Agent({ model, messages, printer: false })
    const strategy = Offload.summarize('*').when({ contextUtilization: '80%', preserveRecent: 1 })

    expect(await strategy.apply({ messages: agent.messages, agent, utilization: 0.9 })).toBe(true)
    await agent.invoke('next')

    const marker = offloadPlaceholder(
      'summarize',
      formatSummarized(REMOVED_MESSAGES, tokens, 'a summary'),
      undefined,
      tokens
    )
    expect(agent.messages.slice(0, 3).map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'user', content: [new TextBlock('task')] },
      { role: 'assistant', content: [marker] },
      { role: 'user', content: [new TextBlock('recent')] },
    ])
    const sentBlocks = requests.flatMap((request) => request.flatMap((message) => message.content))
    expect(sentBlocks.some((block) => block instanceof SummaryBlock)).toBe(false)
  })
})

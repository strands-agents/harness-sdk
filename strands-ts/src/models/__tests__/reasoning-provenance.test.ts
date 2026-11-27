import { describe, expect, it, vi } from 'vitest'
import type OpenAI from 'openai'
import { tagReasoningDelta } from '../reasoning-provenance.js'
import { AnthropicModel } from '../anthropic.js'
import { BedrockModel } from '../bedrock.js'
import { GoogleModel } from '../google/model.js'
import { OpenAIModel } from '../openai/index.js'
import { ModelProxy } from '../model-proxy.js'
import type { Model } from '../model.js'
import { Message, ReasoningBlock, TextBlock, type ReasoningProviderData } from '../../types/messages.js'

const tag = (provider: string): ReasoningProviderData => ({ provider, modelId: 'm', data: {} })

describe('tagReasoningDelta', () => {
  it.each([{ signature: 'sig' }, { redactedContent: new Uint8Array([1]) }])('tags %j', (payload) => {
    const delta = { type: 'reasoningContentDelta' as const, ...payload }
    expect(tagReasoningDelta(delta, 'anthropic', 'm')).toEqual({ ...delta, providerData: tag('anthropic') })
  })

  it('leaves text-only reasoning untagged', () => {
    const delta = { type: 'reasoningContentDelta' as const, text: 'plain' }
    expect(tagReasoningDelta(delta, 'anthropic', 'm')).toBe(delta)
  })
})

describe('the reasoning provider each model reports', () => {
  it.each<[string, () => Model, string[]]>([
    ['AnthropicModel', () => new AnthropicModel({ client: {} as never, modelId: 'claude-x' }), ['anthropic']],
    ['BedrockModel (Claude)', () => new BedrockModel({ modelId: 'us.anthropic.claude-x' }), ['anthropic']],
    [
      'BedrockModel (application profile ARN)',
      () => new BedrockModel({ modelId: 'arn:aws:bedrock:us-west-2:1:application-inference-profile/abc' }),
      ['anthropic'],
    ],
    [
      'BedrockModel (foundation-model ARN of another vendor)',
      () => new BedrockModel({ modelId: 'arn:aws:bedrock:us-west-2::foundation-model/meta.llama3-x' }),
      [],
    ],
    ['BedrockModel (other vendor)', () => new BedrockModel({ modelId: 'us.amazon.nova-pro-v1:0' }), []],
    [
      'BedrockModel (modelInfo override)',
      () =>
        new BedrockModel({
          modelId: 'us.amazon.nova-pro-v1:0',
          modelInfo: { capabilities: { reasoningProvider: 'anthropic' } },
        }),
      ['anthropic'],
    ],
    ['GoogleModel', () => new GoogleModel({ apiKey: 'k', modelId: 'gemini-x' }), ['google']],
    [
      'OpenAIModel (responses)',
      () => new OpenAIModel({ api: 'responses', client: {} as OpenAI, modelId: 'm' }),
      ['openai_responses'],
    ],
  ])('%s', (_name, create, accepts) => {
    expect(create().modelInfo.capabilities?.reasoningProvider).toBe(accepts[0])
  })
})

describe('BedrockModel tagging', () => {
  it.each([
    ['us.anthropic.claude-x', true],
    ['us.amazon.nova-pro-v1:0', false],
    ['arn:aws:bedrock:us-west-2:1:x', false],
  ])('tags signed reasoning from %s: %s', (modelId, tagged) => {
    const model = new BedrockModel({ modelId }) as unknown as {
      _tagReasoning(delta: object): { providerData?: unknown }
    }
    const delta = model._tagReasoning({ type: 'reasoningContentDelta', signature: 'sig' })
    expect(delta.providerData !== undefined).toBe(tagged)
  })
})

describe('ModelProxy with signed reasoning', () => {
  it('keeps another vendor’s signed reasoning out of a Claude request', async () => {
    const model = new BedrockModel({ modelId: 'us.anthropic.claude-x' })
    const gemini = new ReasoningBlock({ text: '', signature: 'g', providerData: tag('google') })
    const claude = new ReasoningBlock({ text: 't', signature: 'c', providerData: tag('anthropic') })
    const legacy = new ReasoningBlock({ text: 't', signature: 'old' })
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('go')] }),
      new Message({ role: 'assistant', content: [gemini, claude, legacy, new TextBlock('ok')] }),
    ]
    const spy = vi.spyOn(model, 'streamAggregated').mockImplementation(async function* () {
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
      return undefined as never
    })
    await new ModelProxy(model).streamAggregated(messages).next()
    const sent = spy.mock.calls[0]![0]
    expect(sent[1]!.content).toEqual([claude, legacy, new TextBlock('ok')])
  })

  it('sends a Claude-signed block to Gemini as text without its signature', async () => {
    const model = new GoogleModel({ apiKey: 'k', modelId: 'gemini-x' })
    const claude = new ReasoningBlock({ text: 't', signature: 'c', providerData: tag('anthropic') })
    const redacted = new ReasoningBlock({ redactedContent: new Uint8Array([1]), providerData: tag('anthropic') })
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('go')] }),
      new Message({ role: 'assistant', content: [claude, redacted, new TextBlock('ok')] }),
    ]
    const spy = vi.spyOn(model, 'streamAggregated').mockImplementation(async function* () {
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
      return undefined as never
    })
    await new ModelProxy(model).streamAggregated(messages).next()
    expect(spy.mock.calls[0]![0][1]!.content).toEqual([new ReasoningBlock({ text: 't' }), new TextBlock('ok')])
  })
})

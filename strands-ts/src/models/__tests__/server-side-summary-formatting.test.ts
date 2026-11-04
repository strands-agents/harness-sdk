import { describe, expect, it, vi } from 'vitest'
import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider'
import { AnthropicModel } from '../anthropic.js'
import { BedrockModel } from '../bedrock.js'
import { VercelModel } from '../vercel.js'
import { formatMessages as formatGoogleMessages } from '../google/adapters.js'
import { formatChatRequest } from '../openai/chat-adapter.js'
import { formatResponsesRequest } from '../openai/responses-adapter.js'
import { Message, TextBlock } from '../../types/messages.js'
import { AnthropicWire } from '../../__fixtures__/anthropic-wire.js'
import { collectIterator } from '../../__fixtures__/model-test-helpers.js'
import { logger } from '../../logging/logger.js'

const OPAQUE = 'OPAQUE-PROVIDER-FIELD'
const COMPACTS = { modelInfo: { capabilities: { serverSideSummary: true } } }

/** A server-side summary written by `provider`, after a user turn. */
function history(provider: string): Message[] {
  const summary = new TextBlock('SUMMARY TEXT', {
    metadata: { serverSideSummary: { provider, signature: OPAQUE } },
  })
  return [
    new Message({ role: 'assistant', content: [summary] }),
    new Message({ role: 'user', content: [new TextBlock('next')] }),
  ]
}

function expectPlainText(request: unknown): void {
  const wire = JSON.stringify(request)
  expect(wire).toContain('SUMMARY TEXT')
  expect(wire).not.toContain(OPAQUE)
  expect(wire).not.toContain('serverSideSummary')
}

describe('server-side summaries on the wire', () => {
  describe('providers other than the producer send only the text', () => {
    it('bedrock', () => {
      const model = new BedrockModel({ region: 'us-east-1', modelId: 'test-model' })
      const format = (model as unknown as { _formatRequest(messages: Message[]): unknown })._formatRequest
      expectPlainText(format.call(model, history('anthropic')))
    })

    it('google', () => {
      expectPlainText(formatGoogleMessages(history('anthropic')))
    })

    it('openai chat', () => {
      expectPlainText(formatChatRequest({ modelId: 'gpt-test' }, history('anthropic')))
    })

    it('openai responses', () => {
      expectPlainText(formatResponsesRequest({ modelId: 'gpt-test' }, history('anthropic'), undefined, false, {}))
    })

    it('vercel', async () => {
      const doStream = vi.fn(async () => ({
        stream: new ReadableStream({
          start(controller): void {
            controller.enqueue({
              type: 'finish',
              usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
              finishReason: { unified: 'stop', raw: 'stop' },
            })
            controller.close()
          },
        }),
      }))
      const provider = { specificationVersion: 'v3', provider: 'test', modelId: 'm', supportedUrls: {}, doStream }
      const model = new VercelModel({ provider: provider as unknown as LanguageModelV3 })
      await collectIterator(model.stream(history('anthropic')))
      const callArgs = doStream.mock.calls[0] as unknown as [LanguageModelV3CallOptions]
      expectPlainText(callArgs[0].prompt)
    })

    it('anthropic, for data another provider produced', async () => {
      const wire = new AnthropicWire().reply({ content: [{ type: 'text', text: 'ok' }] })
      const model = new AnthropicModel({ client: wire.client(), modelId: 'claude-sonnet-4-6', maxTokens: 64 })
      await collectIterator(model.stream(history('openai')))
      expectPlainText(wire.bodies[0])
      expect(wire.requests[0]!.headers['anthropic-beta']).toBeUndefined()
    })
  })

  describe('anthropic, for its own data', () => {
    it('sends the stored block exactly as returned, with the compaction beta', async () => {
      const wire = new AnthropicWire().reply({ content: [{ type: 'text', text: 'ok' }] })
      const model = new AnthropicModel({
        client: wire.client(),
        modelId: 'claude-sonnet-4-6',
        maxTokens: 64,
        ...COMPACTS,
      })
      await collectIterator(model.stream(history('anthropic')))
      expect(wire.bodies[0]!.messages).toStrictEqual([
        { role: 'assistant', content: [{ type: 'compaction', content: 'SUMMARY TEXT', signature: OPAQUE }] },
        { role: 'user', content: [{ type: 'text', text: 'next' }] },
      ])
      expect(wire.requests[0]!.headers['anthropic-beta']).toBe('compact-2026-09-04')
    })

    it('adds the compaction beta after configured betas', async () => {
      const wire = new AnthropicWire().reply({ content: [{ type: 'text', text: 'ok' }] })
      const model = new AnthropicModel({
        client: wire.client(),
        modelId: 'claude-sonnet-4-6',
        maxTokens: 64,
        betas: ['other-beta'],
        ...COMPACTS,
      })
      await collectIterator(model.stream(history('anthropic')))
      expect(wire.requests[0]!.headers['anthropic-beta']).toBe('other-beta,compact-2026-09-04')
    })

    it('sends it as text, warning once, when the sending model lacks the capability', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const wire = new AnthropicWire()
        .reply({ content: [{ type: 'text', text: 'ok' }] })
        .reply({ content: [{ type: 'text', text: 'ok' }] })
      const model = new AnthropicModel({ client: wire.client(), modelId: 'claude-sonnet-4-6', maxTokens: 64 })
      await collectIterator(model.stream(history('anthropic')))
      await collectIterator(model.stream(history('anthropic')))
      expectPlainText(wire.bodies[1])
      expect(wire.requests[1]!.headers['anthropic-beta']).toBeUndefined()
      const compactionWarnings = warn.mock.calls.filter(([message]) => String(message).includes('compaction block'))
      expect(compactionWarnings).toHaveLength(1)
      expect(String(compactionWarnings[0]![0])).toContain('serverSideSummary is off for this model')
      warn.mockRestore()
    })

    it('counts tokens natively with the compaction beta', async () => {
      const wire = new AnthropicWire()
      const client = wire.client()
      const countTokens = vi.spyOn(client.messages, 'countTokens').mockResolvedValue({ input_tokens: 42 })
      const model = new AnthropicModel({
        client,
        modelId: 'claude-sonnet-4-6',
        maxTokens: 64,
        useNativeTokenCount: true,
        ...COMPACTS,
      })
      expect(await model.countTokens(history('anthropic'))).toBe(42)
      expect(countTokens).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'compaction', content: 'SUMMARY TEXT', signature: OPAQUE }],
            },
            { role: 'user', content: [{ type: 'text', text: 'next' }] },
          ],
        }),
        { headers: { 'anthropic-beta': 'compact-2026-09-04' } }
      )
    })
  })
})

describe('anthropic, for messages before its own block', () => {
  it('sends the conversation from the last block, leaving out what it stands in for', async () => {
    const wire = new AnthropicWire().reply({ content: [{ type: 'text', text: 'ok' }] })
    const model = new AnthropicModel({
      client: wire.client(),
      modelId: 'claude-sonnet-4-6',
      maxTokens: 64,
      ...COMPACTS,
    })
    const [summary, next] = history('anthropic')
    const task = new Message({ role: 'user', content: [new TextBlock('task')] })
    const earlier = new Message({ role: 'assistant', content: [new TextBlock('earlier'), ...summary!.content] })
    await collectIterator(model.stream([task, earlier, next!]))
    expect(wire.bodies[0]!.messages).toStrictEqual([
      { role: 'assistant', content: [{ type: 'compaction', content: 'SUMMARY TEXT', signature: OPAQUE }] },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ])
  })
})

describe('anthropic, without server-side summaries', () => {
  it('sends its own block as text, with every message and no compaction beta', async () => {
    const wire = new AnthropicWire().reply({ content: [{ type: 'text', text: 'ok' }] })
    const model = new AnthropicModel({ client: wire.client(), modelId: 'claude-sonnet-4-6', maxTokens: 64 })
    const task = new Message({ role: 'user', content: [new TextBlock('task')] })
    await collectIterator(model.stream([task, ...history('anthropic')]))
    expectPlainText(wire.bodies[0])
    expect((wire.bodies[0]!.messages as unknown[]).length).toBe(3)
    expect(wire.requests[0]!.headers['anthropic-beta']).toBeUndefined()
  })
})

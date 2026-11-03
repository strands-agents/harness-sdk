import { describe, expect, it, vi } from 'vitest'
import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider'
import { AnthropicModel } from '../anthropic.js'
import { BedrockModel } from '../bedrock.js'
import { VercelModel } from '../vercel.js'
import { formatMessages as formatGoogleMessages } from '../google/adapters.js'
import { formatChatRequest } from '../openai/chat-adapter.js'
import { formatResponsesRequest } from '../openai/responses-adapter.js'
import { Message, TextBlock } from '../../types/messages.js'
import type { ProviderData } from '../../types/messages.js'
import { AnthropicWire } from '../../__fixtures__/anthropic-wire.js'
import { collectIterator } from '../../__fixtures__/model-test-helpers.js'

const OPAQUE = 'OPAQUE-PROVIDER-FIELD'
const COUNT = 987_654

/** A summary block carrying metadata and provider data for `provider`, after a user turn. */
function history(provider: string): Message[] {
  const providerData: ProviderData = { provider, data: { type: 'compaction', signature: OPAQUE } }
  const summary = new TextBlock('SUMMARY TEXT', {
    metadata: { offloaded: { method: 'summarize', removedMessages: 3, removedTokens: COUNT } },
    providerData,
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
  expect(wire).not.toContain(String(COUNT))
  expect(wire).not.toContain('offloaded')
  expect(wire).not.toContain('providerData')
}

describe('provider data and text metadata on the wire', () => {
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
      expectPlainText(formatResponsesRequest({ modelId: 'gpt-test' }, history('anthropic'), undefined, false))
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
      const model = new AnthropicModel({ client: wire.client(), modelId: 'claude-sonnet-4-6', maxTokens: 64 })
      await collectIterator(model.stream(history('anthropic')))
      expect(wire.bodies[0]!.messages).toStrictEqual([
        { role: 'assistant', content: [{ type: 'compaction', signature: OPAQUE, content: 'SUMMARY TEXT' }] },
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
      })
      await collectIterator(model.stream(history('anthropic')))
      expect(wire.requests[0]!.headers['anthropic-beta']).toBe('other-beta,compact-2026-09-04')
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
      })
      expect(await model.countTokens(history('anthropic'))).toBe(42)
      expect(countTokens).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'assistant', content: [{ type: 'compaction', signature: OPAQUE, content: 'SUMMARY TEXT' }] },
            { role: 'user', content: [{ type: 'text', text: 'next' }] },
          ],
        }),
        { headers: { 'anthropic-beta': 'compact-2026-09-04' } }
      )
    })
  })
})

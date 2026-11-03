import { describe, expect, it, vi } from 'vitest'
import { BaseSummarizer } from '../base-summarizer.js'
import { summarizeContent, flattenMessagesToContent } from '../../methods/summarize.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import { MaxTokensError } from '../../../errors.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { InvocationContextImpl } from '../../../agent/invocation-context.js'

const body = [
  new Message({
    role: 'assistant',
    content: [new TextBlock('looking'), new ToolUseBlock({ name: 'lookup', toolUseId: 't1', input: { q: 1 } })],
  }),
  new Message({
    role: 'user',
    content: [new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('found')] })],
  }),
]
const usage = { inputTokens: 10, outputTokens: 4, totalTokens: 14 }

describe('BaseSummarizer', () => {
  it('keeps message 0', () => {
    expect(new BaseSummarizer(new MockMessageModel()).keepHead).toBe(1)
  })

  it('streams the same request as the per-block summary, without the live system prompt or tools', async () => {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'S' })
    const stream = vi.spyOn(model, 'stream')
    const signal = new AbortController().signal
    await new BaseSummarizer(model).summarize({ messages: body, instructions: 'keep ids', cancelSignal: signal })

    const reference = new MockMessageModel().addTurn({ type: 'textBlock', text: 'S' })
    const referenceStream = vi.spyOn(reference, 'stream')
    await summarizeContent(flattenMessagesToContent(body), reference, { systemPrompt: 'keep ids' })

    const request = (call: unknown[]): unknown =>
      (call[0] as Message[]).map((message) => ({ role: message.role, content: message.content }))
    expect(request(stream.mock.calls[0]!)).toStrictEqual(request(referenceStream.mock.calls[0]!))
    expect(stream.mock.calls[0]![1]).toStrictEqual({ systemPrompt: 'keep ids', cancelSignal: signal })
    expect(referenceStream.mock.calls[0]![1]).toStrictEqual({ systemPrompt: 'keep ids' })
  })

  it('returns the summary alone with offloaded metadata and records the usage', async () => {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'the summary' }, { usage })
    vi.spyOn(model, 'countTokens').mockResolvedValue(77)
    const context = new InvocationContextImpl()

    expect(await new BaseSummarizer(model, context).summarize({ messages: body })).toStrictEqual({
      block: new TextBlock('the summary', {
        metadata: { offloaded: { method: 'summarize', removedMessages: 2, removedTokens: 77 } },
      }),
    })
    expect(model.countTokens).toHaveBeenCalledWith(body)
    expect(context.usage).toMatchObject(usage)
  })

  it('returns undefined when the model writes no text, and still records the usage', async () => {
    const model = new MockMessageModel().addTurn(
      { type: 'toolUseBlock', name: 'x', toolUseId: 'y', input: {} },
      { usage }
    )
    const context = new InvocationContextImpl()
    expect(await new BaseSummarizer(model, context).summarize({ messages: body })).toBeUndefined()
    expect(context.usage).toMatchObject(usage)
  })

  it('propagates model errors', async () => {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'cut' }, { stopReason: 'maxTokens' })
    await expect(new BaseSummarizer(model).summarize({ messages: body })).rejects.toThrow(MaxTokensError)
  })

  it('stops when the request is cancelled', async () => {
    const controller = new AbortController()
    const model = new MockMessageModel().addTurn(new Error('aborted'))
    controller.abort()
    await expect(
      new BaseSummarizer(model).summarize({ messages: body, cancelSignal: controller.signal })
    ).rejects.toThrow('aborted')
  })
})

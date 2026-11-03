import { describe, expect, it, vi } from 'vitest'
import { NativeSummarizer } from '../native-summarizer.js'
import { Message, TextBlock } from '../../../types/messages.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'

describe('NativeSummarizer', () => {
  it('replaces message 0 and does not re-state it', () => {
    const summarizer = new NativeSummarizer(new MockMessageModel())
    expect(summarizer.keepHead).toBe(0)
    expect(summarizer.restateHead).toBe(false)
  })

  it('passes the request to Model.compact and returns its result', async () => {
    const model = new MockMessageModel()
    const result = { block: new TextBlock('native', { providerData: { provider: 'test', data: { id: 1 } } }) }
    const compact = vi.spyOn(model, 'compact').mockResolvedValue(result)
    const stream = vi.spyOn(model, 'stream')
    const request = {
      messages: [new Message({ role: 'user', content: [new TextBlock('task')] })],
      systemPrompt: 'live',
      toolSpecs: [],
      instructions: 'keep the task',
    }

    expect(await new NativeSummarizer(model).summarize(request)).toStrictEqual({
      block: new TextBlock('native', {
        metadata: { offloaded: { method: 'summarize', removedMessages: 1 } },
        providerData: { provider: 'test', data: { id: 1 } },
      }),
    })
    expect(compact).toHaveBeenCalledWith(request)
    expect(stream).not.toHaveBeenCalled()
  })

  it('returns undefined when Model.compact does', async () => {
    expect(await new NativeSummarizer(new MockMessageModel()).summarize({ messages: [] })).toBeUndefined()
  })
})

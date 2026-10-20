import { describe, it, expect, vi } from 'vitest'
import { ModelExtractor } from '../model-extractor.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { Tracer } from '../../../telemetry/tracer.js'
import type { Model } from '../../../models/model.js'
import type { MessageData } from '../../../types/messages.js'

function userTurn(text: string): MessageData {
  return { role: 'user', content: [{ text }] }
}

describe('ModelExtractor', () => {
  it('parses a JSON array of entries from the model response', async () => {
    const model = new MockMessageModel()
    model.addTurn({
      type: 'textBlock',
      text: '[{"content": "User prefers dark mode"}, {"content": "Lives in Berlin"}]',
    })

    const extractor = new ModelExtractor({ model: model as unknown as Model })
    const entries = await extractor.extract([userTurn('I like dark mode and live in Berlin')])

    expect(entries).toEqual([{ content: 'User prefers dark mode' }, { content: 'Lives in Berlin' }])
  })

  it('extracts a JSON array even when wrapped in prose or a code fence', async () => {
    const model = new MockMessageModel()
    model.addTurn({
      type: 'textBlock',
      text: 'Here are the facts:\n```json\n[{"content": "fact"}]\n```\nHope that helps.',
    })

    const extractor = new ModelExtractor({ model: model as unknown as Model })
    const entries = await extractor.extract([userTurn('something')])

    expect(entries).toEqual([{ content: 'fact' }])
  })

  it('preserves entry metadata', async () => {
    const model = new MockMessageModel()
    model.addTurn({ type: 'textBlock', text: '[{"content": "fact", "metadata": {"topic": "pref"}}]' })

    const extractor = new ModelExtractor({ model: model as unknown as Model })
    const entries = await extractor.extract([userTurn('x')])

    expect(entries).toEqual([{ content: 'fact', metadata: { topic: 'pref' } }])
  })

  it('returns no entries on malformed JSON without throwing', async () => {
    const model = new MockMessageModel()
    model.addTurn({ type: 'textBlock', text: 'not json at all' })

    const extractor = new ModelExtractor({ model: model as unknown as Model })
    const entries = await extractor.extract([userTurn('x')])

    expect(entries).toEqual([])
  })

  it('drops entries without a string content and empty strings', async () => {
    const model = new MockMessageModel()
    model.addTurn({ type: 'textBlock', text: '[{"content": "keep"}, {"content": ""}, {"foo": "bar"}, "loose"]' })

    const extractor = new ModelExtractor({ model: model as unknown as Model })
    const entries = await extractor.extract([userTurn('x')])

    expect(entries).toEqual([{ content: 'keep' }])
  })

  it('returns [] for an empty message batch without calling the model', async () => {
    const model = new MockMessageModel()
    const extractor = new ModelExtractor({ model: model as unknown as Model })

    const entries = await extractor.extract([])

    expect(entries).toEqual([])
    expect(model.callCount).toBe(0)
  })

  it('falls back to the default model from context when none configured', async () => {
    const model = new MockMessageModel()
    model.addTurn({ type: 'textBlock', text: '[{"content": "fact"}]' })

    const extractor = new ModelExtractor()
    const entries = await extractor.extract([userTurn('x')], { defaultModel: model as unknown as Model })

    expect(entries).toEqual([{ content: 'fact' }])
  })

  it('throws when no model is configured and no default is provided', async () => {
    const extractor = new ModelExtractor()
    await expect(extractor.extract([userTurn('x')])).rejects.toThrow('no model configured')
  })

  it('wraps the model call in a model-invoke span when a tracer is supplied', async () => {
    const model = new MockMessageModel()
    model.addTurn({ type: 'textBlock', text: '[{"content": "fact"}]' })
    const startSpy = vi.spyOn(Tracer.prototype, 'startModelInvokeSpan')
    const endSpy = vi.spyOn(Tracer.prototype, 'endModelInvokeSpan')

    const extractor = new ModelExtractor({ model: model as unknown as Model })
    await extractor.extract([userTurn('x')], { tracer: new Tracer() })

    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(endSpy).toHaveBeenCalledTimes(1)
    expect(endSpy.mock.calls[0]![1]?.error).toBeUndefined()
    expect(endSpy.mock.calls[0]![1]?.output).toBeDefined()

    startSpy.mockRestore()
    endSpy.mockRestore()
  })

  it('extracts without a tracer in context (standalone use)', async () => {
    const model = new MockMessageModel()
    model.addTurn({ type: 'textBlock', text: '[{"content": "fact"}]' })

    const extractor = new ModelExtractor({ model: model as unknown as Model })
    // No context at all -> the optional span calls no-op.
    const entries = await extractor.extract([userTurn('x')])

    expect(entries).toEqual([{ content: 'fact' }])
  })

  it('ends the model-invoke span with an error when the model throws', async () => {
    const failing = {
      streamAggregated: () => {
        throw new Error('model down')
      },
    }
    const endSpy = vi.spyOn(Tracer.prototype, 'endModelInvokeSpan')

    const extractor = new ModelExtractor({ model: failing as unknown as Model })
    await expect(extractor.extract([userTurn('x')], { tracer: new Tracer() })).rejects.toThrow('model down')

    expect(endSpy).toHaveBeenCalledTimes(1)
    expect(endSpy.mock.calls[0]![1]?.error).toBeInstanceOf(Error)

    endSpy.mockRestore()
  })
})

import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/agent.js'
import { TextBlock } from '../../types/messages.js'
import { collectIterator } from '../../__fixtures__/model-test-helpers.js'
import { MockMessageModel, TestModelProvider } from '../index.js'

describe('TestModelProvider', () => {
  describe('stream', () => {
    it('requires a factory and propagates mid-stream errors', async () => {
      const model = new TestModelProvider()
      await expect(collectIterator(model.stream([]))).rejects.toThrow('Event generator not set')
      const failure = new Error('stream failed')
      model.setEventGenerator(async function* () {
        yield { type: 'modelMessageStartEvent', role: 'assistant' }
        throw failure
      })
      const stream = model.stream([])
      expect(await stream.next()).toEqual({ value: { type: 'modelMessageStartEvent', role: 'assistant' }, done: false })
      await expect(stream.next()).rejects.toBe(failure)
    })

    it('creates a fresh stream per Agent call and replaces the factory', async () => {
      let count = 0
      const model = new TestModelProvider(async function* () {
        count++
        yield* new MockMessageModel().addTurn(new TextBlock(`call ${count}`)).stream([])
      })
      model.updateConfig({ modelId: 'offline' })
      expect(model.getConfig()).toEqual({ modelId: 'offline' })
      const agent = new Agent({ model, printer: false })
      expect((await agent.invoke('first')).lastMessage.content).toEqual([new TextBlock('call 1')])
      expect((await agent.invoke('second')).lastMessage.content).toEqual([new TextBlock('call 2')])
      model.setEventGenerator(async function* () {
        yield* new MockMessageModel().addTurn(new TextBlock('replacement')).stream([])
      })
      expect((await agent.invoke('third')).lastMessage.content).toEqual([new TextBlock('replacement')])
      expect(count).toBe(2)
    })
  })
})

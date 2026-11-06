import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/agent.js'
import { TextBlock, ToolResultBlock } from '../../types/messages.js'
import { collectIterator } from '../../__fixtures__/model-test-helpers.js'
import { expectAgentResult } from '../../__fixtures__/agent-helpers.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import type { JSONValue } from '../../types/json.js'
import { MockMessageModel } from '../index.js'

describe('MockMessageModel', () => {
  describe('stream', () => {
    it('repeats a single turn and counts only consumed streams', async () => {
      const model = new MockMessageModel().addTurn(new TextBlock('Hello'), {
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      })
      const stream = model.stream([])
      expect(model.callCount).toBe(0)
      const events = await collectIterator(stream)
      expect(events).toEqual([
        { type: 'modelMessageStartEvent', role: 'assistant' },
        { type: 'modelContentBlockStartEvent' },
        { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Hello' } },
        { type: 'modelContentBlockStopEvent' },
        { type: 'modelMessageStopEvent', stopReason: 'endTurn' },
        { type: 'modelMetadataEvent', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } },
      ])
      expect(await collectIterator(model.stream([]))).toEqual(events)
      expect(model.callCount).toBe(2)
    })

    it('consumes error turns and counts exhausted attempts', async () => {
      const failure = new Error('scripted failure')
      const model = new MockMessageModel().addTurn(failure).addTurn([], { stopReason: 'maxTokens' })
      await expect(collectIterator(model.stream([]))).rejects.toBe(failure)
      expect(await collectIterator(model.stream([]))).toEqual([
        { type: 'modelMessageStartEvent', role: 'assistant' },
        { type: 'modelMessageStopEvent', stopReason: 'maxTokens' },
      ])
      await expect(collectIterator(model.stream([]))).rejects.toThrow('All turns have been consumed')
      expect(model.callCount).toBe(3)
    })

    it('rejects an empty script and skips unsupported output blocks', async () => {
      const model = new MockMessageModel()
      await expect(collectIterator(model.stream([]))).rejects.toThrow('All turns have been consumed')
      model.addTurn({ type: 'jsonBlock', json: { ignored: true } })
      expect(await collectIterator(model.stream([]))).toEqual([
        { type: 'modelMessageStartEvent', role: 'assistant' },
        { type: 'modelMessageStopEvent', stopReason: 'endTurn' },
      ])
      expect(model.callCount).toBe(2)
    })

    it('emits reasoning and cache-point events without provider calls', async () => {
      const model = new MockMessageModel().addTurn([
        { type: 'reasoningBlock', text: 'thinking', signature: 'sig', redactedContent: new Uint8Array([1]) },
        { type: 'cachePointBlock', cacheType: 'default' },
      ])
      expect(await collectIterator(model.stream([]))).toEqual([
        { type: 'modelMessageStartEvent', role: 'assistant' },
        { type: 'modelContentBlockStartEvent' },
        {
          type: 'modelContentBlockDeltaEvent',
          delta: {
            type: 'reasoningContentDelta',
            text: 'thinking',
            signature: 'sig',
            redactedContent: new Uint8Array([1]),
          },
        },
        { type: 'modelContentBlockStopEvent' },
        { type: 'modelContentBlockStartEvent' },
        { type: 'modelContentBlockStopEvent' },
        { type: 'modelMessageStopEvent', stopReason: 'endTurn' },
      ])
    })
  })

  describe('Agent integration', () => {
    it('runs a complete tool loop and reports scripted usage', async () => {
      const calls: JSONValue[] = []
      const toolResult = new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('sunny')] })
      const tool = createMockTool('weather', (context) => {
        calls.push(context.toolUse.input)
        return toolResult
      })
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'weather', toolUseId: 't1', input: { city: 'Shenzhen' } })
        .addTurn(
          { type: 'textBlock', text: 'It is sunny.' },
          { usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 } }
        )
      const agent = new Agent({ model, tools: [tool], printer: false })
      const result = await agent.invoke('Weather?')
      expect(result).toEqual(
        expectAgentResult({
          stopReason: 'endTurn',
          messageText: 'It is sunny.',
          cycleCount: 2,
          toolNames: ['weather'],
          usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 },
        })
      )
      expect(calls).toEqual([{ city: 'Shenzhen' }])
      expect(agent.messages[2]?.content).toEqual([toolResult])
      expect(model.callCount).toBe(2)
    })
  })
})

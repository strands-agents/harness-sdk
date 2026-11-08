import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { InvokeModelStage } from '../../middleware/stages.js'
import { AfterModelCallEvent } from '../../hooks/events.js'

describe('Agent', () => {
  describe('model-facing tool order (#5700)', () => {
    it.each([undefined, true, false])('preserves registry order with sortTools=%s', async (sortTools) => {
      const tools = ['zebra', 'alpha', 'Bravo'].map((name) => createMockTool(name, () => 'OK'))
      for (const registered of [tools, [...tools].reverse()]) {
        const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'OK' })
        const stream = vi.spyOn(model, 'stream')
        const agent = new Agent({
          model,
          tools: registered,
          printer: false,
          ...(sortTools !== undefined && { sortTools }),
        })
        await agent.invoke('hello')

        const expected = sortTools === false ? registered : [tools[2]!, tools[1]!, tools[0]!]
        expect(stream.mock.calls[0]?.[1]?.toolSpecs).toEqual(expected.map((tool) => tool.toolSpec))
        expect(agent.tools).toEqual(registered)
      }
    })

    it.each([true, false])('handles middleware additions with sortTools=%s', async (sortTools) => {
      const tools = ['zebra', 'alpha', 'Bravo'].map((name) => createMockTool(name, () => 'OK'))
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'OK' })
      const stream = vi.spyOn(model, 'stream')
      const agent = new Agent({ model, tools: tools.slice(0, 2), printer: false, sortTools })
      const middlewareSpecs = tools.map((tool) => tool.toolSpec)
      const originalSpecs = globalThis.structuredClone(middlewareSpecs)
      const toolChoice = { tool: { name: 'zebra' } }
      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        return yield* next({ ...context, toolSpecs: middlewareSpecs, toolChoice })
      })

      await agent.invoke('hello')

      const expected = sortTools ? [tools[2]!, tools[1]!, tools[0]!] : tools
      expect(stream.mock.calls[0]?.[1]?.toolSpecs).toEqual(expected.map((tool) => tool.toolSpec))
      expect(stream.mock.calls[0]?.[1]?.toolChoice).toEqual(toolChoice)
      expect(middlewareSpecs).toEqual(originalSpecs)
      expect(agent.tools).toEqual(tools.slice(0, 2))
    })

    it('orders newly registered tools on a model retry', async () => {
      const tools = ['zebra', 'alpha', 'Bravo'].map((name) => createMockTool(name, () => 'OK'))
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'OK' })
        .addTurn({ type: 'textBlock', text: 'OK' })
      const stream = vi.spyOn(model, 'stream')
      const agent = new Agent({ model, tools: tools.slice(0, 2), printer: false })
      agent.addHook(AfterModelCallEvent, (event) => {
        if (model.callCount === 1) {
          agent.toolRegistry.add(tools[2]!)
          event.retry = true
        }
      })

      await agent.invoke('hello')

      expect(stream.mock.calls.map((modelCall) => modelCall[1]?.toolSpecs)).toEqual([
        [tools[1]!.toolSpec, tools[0]!.toolSpec],
        [tools[2]!.toolSpec, tools[1]!.toolSpec, tools[0]!.toolSpec],
      ])
    })
  })
})

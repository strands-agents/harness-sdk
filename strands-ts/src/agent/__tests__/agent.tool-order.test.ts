import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { InvokeModelStage } from '../../middleware/stages.js'

describe('Agent', () => {
  describe('model-facing tool order (#5700)', () => {
    it('sends specs sorted by name and keeps registry order', async () => {
      const tools = ['zebra', 'alpha', 'Bravo'].map((name) => createMockTool(name, () => 'OK'))
      for (const registered of [tools, [...tools].reverse()]) {
        const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'OK' })
        const stream = vi.spyOn(model, 'stream')
        const agent = new Agent({ model, tools: registered, printer: false, sortTools: true })
        await agent.invoke('hello')

        const expected = [tools[2]!, tools[1]!, tools[0]!]
        expect(stream.mock.calls[0]?.[1]?.toolSpecs).toEqual(expected.map((tool) => tool.toolSpec))
        expect(agent.tools).toEqual(registered)
      }
    })

    it('sorts before middleware and sends middleware output as-is', async () => {
      const tools = ['zebra', 'alpha', 'Bravo'].map((name) => createMockTool(name, () => 'OK'))
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'OK' })
      const stream = vi.spyOn(model, 'stream')
      const agent = new Agent({ model, tools: tools.slice(0, 2), printer: false, sortTools: true })
      const middlewareSpecs = tools.map((tool) => tool.toolSpec)
      const originalSpecs = globalThis.structuredClone(middlewareSpecs)
      const toolChoice = { tool: { name: 'zebra' } }
      const seenSpecs: unknown[] = []
      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        seenSpecs.push(globalThis.structuredClone(context.toolSpecs))
        return yield* next({ ...context, toolSpecs: middlewareSpecs, toolChoice })
      })

      await agent.invoke('hello')

      expect(seenSpecs).toEqual([[tools[1]!.toolSpec, tools[0]!.toolSpec]])
      expect(stream.mock.calls[0]?.[1]?.toolSpecs).toEqual(originalSpecs)
      expect(stream.mock.calls[0]?.[1]?.toolChoice).toEqual(toolChoice)
      expect(middlewareSpecs).toEqual(originalSpecs)
      expect(agent.tools).toEqual(tools.slice(0, 2))
    })
  })
})

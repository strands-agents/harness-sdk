import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { ClientTool, CLIENT_TOOL_INTERRUPT_NAME } from '../client-tool.js'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { InterruptResponseContent } from '../../types/interrupt.js'
import { ToolResultBlock } from '../../types/messages.js'
import type { JSONValue } from '../../types/json.js'

function createAgent(tool: ClientTool, input: JSONValue): Agent {
  const model = new MockMessageModel()
    .addTurn({ type: 'toolUseBlock', name: 'get_weather', toolUseId: 't1', input })
    .addTurn({ type: 'textBlock', text: 'done' })
  return new Agent({ model, tools: [tool], printer: false })
}

function toolResults(agent: Agent): ToolResultBlock[] {
  return agent.messages
    .flatMap((message) => message.content)
    .filter((block): block is ToolResultBlock => block.type === 'toolResultBlock')
}

const Location = z.object({ city: z.string() })

describe('ClientTool', () => {
  describe('toolSpec', () => {
    it('uses a JSON schema as-is', () => {
      const schema = { type: 'object' as const, properties: { city: { type: 'string' as const } } }
      const tool = new ClientTool({ name: 'get_weather', description: 'Get weather.', inputSchema: schema })

      expect(tool.toolSpec).toEqual({ name: 'get_weather', description: 'Get weather.', inputSchema: schema })
    })

    it('converts a Zod schema', () => {
      const tool = new ClientTool({ name: 'get_weather', description: 'Get weather.', inputSchema: Location })

      expect(tool.toolSpec.inputSchema).toMatchObject({
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      })
    })

    it('defaults to an empty object schema', () => {
      const tool = new ClientTool({ name: 'get_weather', description: 'Get weather.' })

      expect(tool.toolSpec.inputSchema).toEqual({ type: 'object', properties: {} })
    })
  })

  describe('agent loop', () => {
    it('interrupts with the tool call and returns the response as the tool result', async () => {
      const agent = createAgent(new ClientTool({ name: 'get_weather', description: 'Get weather.' }), {
        city: 'Seattle',
      })

      const result = await agent.invoke('weather?')

      expect(result.stopReason).toBe('interrupt')
      const interrupt = result.interrupts![0]!
      expect(interrupt.name).toBe(CLIENT_TOOL_INTERRUPT_NAME)
      expect(interrupt.reason).toEqual({ name: 'get_weather', input: { city: 'Seattle' } })

      const resumed = await agent.invoke([
        new InterruptResponseContent({ interruptId: interrupt.id, response: { tempF: 61 } }),
      ])

      expect(resumed.stopReason).toBe('endTurn')
      const [toolResult] = toolResults(agent)
      expect(toolResult!.status).toBe('success')
      expect(toolResult!.content[0]).toMatchObject({ type: 'jsonBlock', json: { tempF: 61 } })
    })

    it('turns a string response into a text result', async () => {
      const agent = createAgent(new ClientTool({ name: 'get_weather', description: 'Get weather.' }), {})
      const interrupt = (await agent.invoke('weather?')).interrupts![0]!

      await agent.invoke([new InterruptResponseContent({ interruptId: interrupt.id, response: 'sunny' })])

      expect(toolResults(agent)[0]!.content[0]).toMatchObject({ type: 'textBlock', text: 'sunny' })
    })

    it('passes a tool-result-shaped response through, including error status', async () => {
      const agent = createAgent(new ClientTool({ name: 'get_weather', description: 'Get weather.' }), {})
      const interrupt = (await agent.invoke('weather?')).interrupts![0]!

      await agent.invoke([
        new InterruptResponseContent({
          interruptId: interrupt.id,
          response: { status: 'error', content: [{ text: 'location permission denied' }] },
        }),
      ])

      const [toolResult] = toolResults(agent)
      expect(toolResult!.toolUseId).toBe('t1')
      expect(toolResult!.status).toBe('error')
      expect(toolResult!.content[0]).toMatchObject({ type: 'textBlock', text: 'location permission denied' })
    })

    it.each([{}, { city: 3 }])('returns an error without interrupting when Zod validation fails: %j', async (input) => {
      const tool = new ClientTool({ name: 'get_weather', description: 'Get weather.', inputSchema: Location })
      const agent = createAgent(tool, input)

      const result = await agent.invoke('weather?')

      expect(result.stopReason).toBe('endTurn')
      expect(result.interrupts ?? []).toEqual([])
      expect(toolResults(agent)[0]!.status).toBe('error')
    })

    it('interrupts once per parallel call and resumes with all responses', async () => {
      const model = new MockMessageModel()
        .addTurn([
          { type: 'toolUseBlock', name: 'get_weather', toolUseId: 'a', input: { city: 'Oslo' } },
          { type: 'toolUseBlock', name: 'get_weather', toolUseId: 'b', input: { city: 'Rome' } },
        ])
        .addTurn({ type: 'textBlock', text: 'done' })
      const agent = new Agent({
        model,
        tools: [new ClientTool({ name: 'get_weather', description: 'Get weather.' })],
        printer: false,
      })

      const result = await agent.invoke('weather?')

      const cities = result.interrupts!.map((i) => (i.reason as { input: { city: string } }).input.city)
      expect(cities.sort()).toEqual(['Oslo', 'Rome'])
      const resumed = await agent.invoke(
        result.interrupts!.map(
          (i) =>
            new InterruptResponseContent({
              interruptId: i.id,
              response: (i.reason as { input: { city: string } }).input.city,
            })
        )
      )
      expect(resumed.stopReason).toBe('endTurn')
      const byId = Object.fromEntries(toolResults(agent).map((r) => [r.toolUseId, r.content[0]]))
      expect(byId.a).toMatchObject({ text: 'Oslo' })
      expect(byId.b).toMatchObject({ text: 'Rome' })
    })
  })
})

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { ClientTool, CLIENT_TOOL_INTERRUPT_NAME } from '../client-tool.js'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { InterruptResponseContent } from '../../types/interrupt.js'
import { JsonBlock, TextBlock, ToolResultBlock, type ToolResultContent } from '../../types/messages.js'
import { Interrupt } from '../../interrupt.js'
import type { JSONValue } from '../../types/json.js'

function createAgent(tool: ClientTool, ...toolUses: [string, JSONValue][]): Agent {
  const model = new MockMessageModel()
    .addTurn(
      toolUses.map(([toolUseId, input]) => ({ type: 'toolUseBlock' as const, name: 'get_weather', toolUseId, input }))
    )
    .addTurn({ type: 'textBlock', text: 'done' })
  return new Agent({ model, tools: [tool], printer: false })
}

async function respond(agent: Agent, response: JSONValue): Promise<void> {
  const interrupt = (await agent.invoke('weather?')).interrupts![0]!
  await agent.invoke([new InterruptResponseContent({ interruptId: interrupt.id, response })])
}

function toolResults(agent: Agent): ToolResultBlock[] {
  return agent.messages
    .flatMap((message) => message.content)
    .filter((block): block is ToolResultBlock => block.type === 'toolResultBlock')
}

const Forecast = z.object({ city: z.string(), days: z.number().default(3) })
const weatherTool = (): ClientTool => new ClientTool({ name: 'get_weather', description: 'Get weather.' })

describe('ClientTool', () => {
  describe('toolSpec', () => {
    it('uses a JSON schema as-is', () => {
      const schema = { type: 'object' as const, properties: { city: { type: 'string' as const } } }

      const tool = new ClientTool({ name: 'get_weather', description: 'Get weather.', inputSchema: schema })

      expect(tool.toolSpec).toEqual({ name: 'get_weather', description: 'Get weather.', inputSchema: schema })
    })

    it('converts a Zod schema', () => {
      const tool = new ClientTool({ name: 'get_weather', description: 'Get weather.', inputSchema: Forecast })

      // Same conversion as tool(), which lists defaulted fields as required.
      expect(tool.toolSpec.inputSchema).toEqual({
        type: 'object',
        properties: { city: { type: 'string' }, days: { type: 'number', default: 3 } },
        required: ['city', 'days'],
        additionalProperties: false,
      })
    })

    it('defaults to an empty object schema', () => {
      expect(weatherTool().toolSpec.inputSchema).toEqual({
        type: 'object',
        properties: {},
        additionalProperties: false,
      })
    })
  })

  describe('stream', () => {
    it('interrupts with the tool use and returns the response as the tool result', async () => {
      const agent = createAgent(weatherTool(), ['t1', { city: 'Seattle' }])

      const result = await agent.invoke('weather?')

      expect(result.stopReason).toBe('interrupt')
      const interrupt = result.interrupts![0]!
      expect(interrupt.name).toBe(CLIENT_TOOL_INTERRUPT_NAME)
      expect(interrupt.reason).toEqual({ toolUseId: 't1', name: 'get_weather', input: { city: 'Seattle' } })

      const resumed = await agent.invoke([
        new InterruptResponseContent({ interruptId: interrupt.id, response: { tempF: 61 } }),
      ])

      expect(resumed.stopReason).toBe('endTurn')
      expect(toolResults(agent)).toEqual([
        new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new JsonBlock({ json: { tempF: 61 } })] }),
      ])
    })

    it.each<[string, JSONValue, ToolResultContent]>([
      ['a string', 'sunny', new TextBlock('sunny')],
      [
        'data with status and content keys',
        { status: 200, content: 'x' },
        new JsonBlock({ json: { status: 200, content: 'x' } }),
      ],
      [
        'a tool result with unknown content',
        { status: 'success', content: [{ id: 1 }] },
        new JsonBlock({ json: { status: 'success', content: [{ id: 1 }] } }),
      ],
      [
        'a tool result with empty content',
        { status: 'success', content: [] },
        new JsonBlock({ json: { status: 'success', content: [] } }),
      ],
    ])('wraps %s as data', async (_label, response, expected) => {
      const agent = createAgent(weatherTool(), ['t1', {}])

      await respond(agent, response)

      expect(toolResults(agent)).toEqual([
        new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [expected] }),
      ])
    })

    it('passes a tool result response through, including error status', async () => {
      const agent = createAgent(weatherTool(), ['t1', {}])

      await respond(agent, { status: 'error', content: [{ text: 'permission denied' }], extra: 1 })

      expect(toolResults(agent)).toEqual([
        new ToolResultBlock({ toolUseId: 't1', status: 'error', content: [new TextBlock('permission denied')] }),
      ])
    })

    it.each([{}, { city: 3 }, { city: 'Oslo', days: 'many' }])(
      'returns an error without interrupting when validation fails: %j',
      async (input) => {
        const tool = new ClientTool({ name: 'get_weather', description: 'Get weather.', inputSchema: Forecast })
        const agent = createAgent(tool, ['t1', input])

        const result = await agent.invoke('weather?')

        expect(result.stopReason).toBe('endTurn')
        expect(result.interrupts ?? []).toEqual([])
        expect(toolResults(agent)[0]!.status).toBe('error')
      }
    )

    it('forwards the validated input', async () => {
      const tool = new ClientTool({ name: 'get_weather', description: 'Get weather.', inputSchema: Forecast })
      const agent = createAgent(tool, ['t1', { city: 'Oslo' }])

      const result = await agent.invoke('weather?')

      expect(result.interrupts![0]!.reason).toEqual({
        toolUseId: 't1',
        name: 'get_weather',
        input: { city: 'Oslo', days: 3 },
      })
    })

    it('interrupts once per parallel call and resumes with all responses', async () => {
      const tool = weatherTool()
      const agent = createAgent(tool, ['a', { city: 'Oslo' }], ['b', { city: 'Rome' }])

      const result = await agent.invoke('weather?')

      const calls = result.interrupts!.filter((i) => tool.isInterrupt(i))
      expect(calls.map((i) => i.reason.toolUseId).sort()).toEqual(['a', 'b'])
      const resumed = await agent.invoke(
        calls.map(
          (i) =>
            new InterruptResponseContent({ interruptId: i.id, response: (i.reason.input as { city: string }).city })
        )
      )
      expect(resumed.stopReason).toBe('endTurn')
      const contentById = Object.fromEntries(toolResults(agent).map((r) => [r.toolUseId, r.content]))
      expect(contentById).toEqual({ a: [new TextBlock('Oslo')], b: [new TextBlock('Rome')] })
    })
  })

  describe('interruptName', () => {
    it('defaults to CLIENT_TOOL_INTERRUPT_NAME and can be overridden', async () => {
      const tool = new ClientTool({ name: 'get_weather', description: 'Get weather.', interruptName: 'app:weather' })
      const agent = createAgent(tool, ['t1', {}])

      const result = await agent.invoke('weather?')

      expect(weatherTool().interruptName).toBe(CLIENT_TOOL_INTERRUPT_NAME)
      expect(tool.interruptName).toBe('app:weather')
      expect(result.interrupts![0]!.name).toBe('app:weather')
    })
  })

  describe('isInterrupt', () => {
    it.each([
      ['its own call', CLIENT_TOOL_INTERRUPT_NAME, { toolUseId: 't1', name: 'get_weather', input: {} }, true],
      ['another client tool', CLIENT_TOOL_INTERRUPT_NAME, { toolUseId: 't1', name: 'get_location', input: {} }, false],
      ['another interrupt name', 'approve', { toolUseId: 't1', name: 'get_weather', input: {} }, false],
      ['a non-object reason', CLIENT_TOOL_INTERRUPT_NAME, 'get_weather', false],
    ])('matches %s: %s', (_label, name, reason, expected) => {
      expect(weatherTool().isInterrupt(new Interrupt({ id: '1', name, reason }))).toBe(expected)
    })
  })
})

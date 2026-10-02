import { describe, it, expect } from 'vitest'
import { handoffToUser, makeHandoffToUser, HANDOFF_INTERRUPT_NAME } from '../index.js'
import type { ToolContext } from '../../../index.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { JSONValue } from '../../../types/json.js'
import type { InterruptParams } from '../../../types/interrupt.js'
import { InterruptError, InterruptState, interruptFromAgent } from '../../../interrupt.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { Agent } from '../../../agent/agent.js'
import { InterruptResponseContent } from '../../../types/interrupt.js'
import { ToolResultBlock } from '../../../types/messages.js'

/**
 * Build a ToolContext whose `interrupt` is backed by a real `InterruptState`,
 * so `context.interrupt` registers and raises against it.
 */
function createContext(interruptState: InterruptState = new InterruptState()): ToolContext {
  const agent = { _interruptState: interruptState } as unknown as LocalAgent
  return {
    toolUse: { name: 'handoff_to_user', toolUseId: 'id', input: {} },
    agent,
    invocationState: {},
    cancelSignal: new AbortController().signal,
    interrupt: <T = JSONValue>(params: InterruptParams): T =>
      interruptFromAgent<T>(agent, `tool:id:${params.name}`, params, 'tool'),
  }
}

describe('handoff_to_user tool', () => {
  describe('handoff behavior', () => {
    it('raises an interrupt carrying the message and stable name on first call', async () => {
      const error = await handoffToUser.invoke({ message: 'please confirm' }, createContext()).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(InterruptError)
      const interrupt = (error as InterruptError).interrupts[0]!
      expect(interrupt).toMatchObject({ reason: 'please confirm', name: HANDOFF_INTERRUPT_NAME })
    })
  })

  describe('input validation', () => {
    it.each(['', '   '])('rejects blank message %j without registering an interrupt', async (blank) => {
      const state = new InterruptState()
      await expect(handoffToUser.invoke({ message: blank }, createContext(state))).rejects.toThrow(/must not be empty/)
      // Validation runs before any interrupt side effect.
      expect(state.interrupts).toEqual({})
    })

    it('rejects a non-string message without registering an interrupt', async () => {
      const state = new InterruptState()
      await expect(handoffToUser.invoke({ message: 42 as unknown as string }, createContext(state))).rejects.toThrow(
        /expected string/
      )
      expect(state.interrupts).toEqual({})
    })

    it('throws when invoked without a tool context', async () => {
      await expect(handoffToUser.invoke({ message: 'hi' })).rejects.toThrow(/context is required/i)
    })
  })

  describe('tool metadata', () => {
    it('exposes the default name and input schema', () => {
      expect(handoffToUser.name).toBe('handoff_to_user')
      const schema = handoffToUser.toolSpec.inputSchema as {
        properties?: Record<string, unknown>
        required?: string[]
      }
      expect(schema.properties).toHaveProperty('message')
      expect(schema.properties).not.toHaveProperty('tool_context')
      expect(schema.required).toContain('message')
    })

    it('customizes the name and description via the factory', () => {
      const tool = makeHandoffToUser({ name: 'ask_user', description: 'my desc' })
      expect(tool.name).toBe('ask_user')
      expect(tool.toolSpec.description).toBe('my desc')
    })
  })

  describe('agent loop', () => {
    it('halts with stopReason interrupt and the message as the reason', async () => {
      const model = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'handoff_to_user',
          toolUseId: 'htu-1',
          input: { message: 'What is your address?' },
        })
        .addTurn({ type: 'textBlock', text: 'Thanks, got it.' })
      const agent = new Agent({ model, tools: [handoffToUser], printer: false })

      const result = await agent.invoke('Process my order')

      expect(result.stopReason).toBe('interrupt')
      expect(result.interrupts).toHaveLength(1)
      expect(result.interrupts![0]!.name).toBe(HANDOFF_INTERRUPT_NAME)
      expect(result.interrupts![0]!.reason).toBe('What is your address?')
    })

    it('returns the reply as the tool result and the model continues on resume', async () => {
      const model = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'handoff_to_user',
          toolUseId: 'htu-2',
          input: { message: 'Confirm your email' },
        })
        .addTurn({ type: 'textBlock', text: 'All done.' })
      const agent = new Agent({ model, tools: [handoffToUser], printer: false })

      const result = await agent.invoke('Verify me')
      expect(result.stopReason).toBe('interrupt')

      const resumed = await agent.invoke([
        new InterruptResponseContent({ interruptId: result.interrupts![0]!.id, response: 'yes@example.com' }),
      ])

      expect(resumed.stopReason).toBe('endTurn')
      expect(String(resumed)).toContain('All done')
      // The human's reply is surfaced to the model as the handoff tool's result.
      const toolResult = agent.messages
        .flatMap((message) => message.content)
        .find((block) => block.type === 'toolResultBlock') as ToolResultBlock | undefined
      expect(toolResult?.content[0]).toMatchObject({ type: 'textBlock', text: 'yes@example.com' })
    })

    it('reports the stable interrupt name even when the tool is renamed', async () => {
      // The interrupt name is a stable discriminator: renaming the tool via the
      // factory must not change it, so consumers can match on HANDOFF_INTERRUPT_NAME.
      const askUser = makeHandoffToUser({ name: 'ask_user' })
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'ask_user', toolUseId: 'htu-3', input: { message: 'Enter PIN' } })
        .addTurn({ type: 'textBlock', text: 'PIN accepted.' })
      const agent = new Agent({ model, tools: [askUser], printer: false })

      const result = await agent.invoke('Authenticate')

      expect(result.stopReason).toBe('interrupt')
      expect(result.interrupts![0]!.name).toBe(HANDOFF_INTERRUPT_NAME)
    })
  })
})

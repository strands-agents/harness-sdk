import { describe, expect, it } from 'vitest'
import { Agent, BeforeToolCallEvent, tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { bedrock } from './__fixtures__/model-providers.js'
import { resumeUntilDone, timeTool, weatherTool } from './__fixtures__/test-helpers.js'

// Tool that interrupts to ask for the time
const interruptTimeTool = tool({
  name: 'time_tool',
  description: 'Returns the current time',
  inputSchema: z.object({}),
  callback: async (_input, context) => {
    return context!.interrupt({ name: 'test_interrupt', reason: 'need time' }) as string
  },
})

describe.skipIf(bedrock.skip)('Interrupts', () => {
  describe('hook interrupts', () => {
    function createAgentWithApprovalHook() {
      const agent = new Agent({
        model: bedrock.createModel(),
        printer: false,
        tools: [timeTool, weatherTool],
      })
      agent.addHook(BeforeToolCallEvent, (event) => {
        if (event.toolUse.name === 'weather_tool') return
        const response = event.interrupt<string>({ name: 'test_interrupt', reason: 'need approval' })
        if (response !== 'APPROVE') {
          event.cancel = 'tool rejected'
        }
      })
      return agent
    }

    it('interrupts before tool call, resumes with approval', async () => {
      const agent = createAgentWithApprovalHook()

      const result = await agent.invoke('What is the time and weather?')

      expect(result.stopReason).toBe('interrupt')
      expect(result.interrupts).toBeDefined()
      expect(result.interrupts!.length).toBeGreaterThanOrEqual(1)

      const interrupt = result.interrupts![0]!
      expect(interrupt.name).toBe('test_interrupt')
      expect(interrupt.reason).toBe('need approval')

      const finalResult = await resumeUntilDone(agent, result, () => 'APPROVE')

      expect(finalResult.stopReason).toBe('endTurn')

      const text = finalResult.lastMessage.content
        .filter((b) => b.type === 'textBlock')
        .map((b) => b.text)
        .join(' ')
        .toLowerCase()
      expect(text).toMatch(/12:00|sunny/)
    })

    it('interrupts before tool call, resumes with rejection cancels tool', async () => {
      const agent = createAgentWithApprovalHook()

      const result = await agent.invoke('What is the time and weather?')
      expect(result.stopReason).toBe('interrupt')

      const finalResult = await resumeUntilDone(agent, result, () => 'REJECT')
      expect(finalResult.stopReason).toBe('endTurn')

      // Verify at least one tool result was an error (the rejected tool)
      const hasErrorResult = agent.messages.some(
        (msg) => msg.role === 'user' && msg.content.some((b) => b.type === 'toolResultBlock' && b.status === 'error')
      )
      expect(hasErrorResult).toBe(true)
    })
  })

  describe('tool interrupts', () => {
    it('interrupts from tool callback, resumes with response', async () => {
      const agent = new Agent({
        model: bedrock.createModel(),
        printer: false,
        tools: [interruptTimeTool, weatherTool],
      })

      const result = await agent.invoke('What is the time and weather?')
      expect(result.stopReason).toBe('interrupt')
      expect(result.interrupts).toBeDefined()
      expect(result.interrupts!.length).toBeGreaterThanOrEqual(1)

      for (const interrupt of result.interrupts!) {
        expect(interrupt.response).toBeUndefined()
      }

      const finalResult = await resumeUntilDone(agent, result, (interrupt) =>
        interrupt.reason === 'need time' ? '12:01' : 'yes'
      )

      expect(finalResult.stopReason).toBe('endTurn')

      const lastAssistant = agent.messages.filter((m) => m.role === 'assistant').pop()
      expect(lastAssistant).toBeDefined()
      const finalText = lastAssistant!.content
        .filter((b) => b.type === 'textBlock')
        .map((b) => b.text)
        .join(' ')
        .toLowerCase()
      expect(finalText).toMatch(/12:01|sunny/)
    })
  })
})

import { describe, expect, it, vi } from 'vitest'
import { HumanInTheLoop } from '../hitl.js'
import { Agent } from '../../../agent/agent.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../../__fixtures__/tool-helpers.js'
import { createInvocation } from '../../../agent/invocation.js'
import { BeforeToolCallEvent } from '../../../hooks/events.js'

describe('HumanInTheLoop', () => {
  describe('default config (interrupt/resume)', () => {
    it('pauses agent with interrupt on any tool call', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'anyTool', toolUseId: 'tool-1', input: { x: 1 } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('anyTool', () => {
        toolExecuted = true
        return 'result'
      })

      const agent = new Agent({
        model,
        tools: [tool],
        interventions: [new HumanInTheLoop()],
        printer: false,
      })

      const result = await agent.invoke('Do something')

      expect(result.stopReason).toBe('interrupt')
      expect(result.interrupts).toEqual([
        expect.objectContaining({
          name: 'strands:human-in-the-loop',
          reason: expect.stringContaining('anyTool'),
        }),
      ])
      expect(toolExecuted).toBe(false)
    })
  })

  describe('inline mode (with ask callback)', () => {
    it('allows tool execution when approved', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'myTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('myTool', () => {
        toolExecuted = true
        return 'executed'
      })

      const agent = new Agent({
        model,
        tools: [tool],
        interventions: [new HumanInTheLoop({ ask: async () => 'yes' })],
        printer: false,
      })

      const result = await agent.invoke('Run tool')
      expect(result.stopReason).toBe('endTurn')
      expect(toolExecuted).toBe(true)
    })

    it('denies tool execution when rejected', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'myTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Understood' })

      let toolExecuted = false
      const tool = createMockTool('myTool', () => {
        toolExecuted = true
        return 'executed'
      })

      const agent = new Agent({
        model,
        tools: [tool],
        interventions: [new HumanInTheLoop({ ask: async () => 'no' })],
        printer: false,
      })

      const result = await agent.invoke('Run tool')
      expect(result.stopReason).toBe('endTurn')
      expect(toolExecuted).toBe(false)
    })
  })

  describe('allowedTools config', () => {
    it('does not prompt for tools in allowedTools', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'readFile', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('readFile', () => {
        toolExecuted = true
        return 'content'
      })

      const agent = new Agent({
        model,
        tools: [tool],
        interventions: [new HumanInTheLoop({ allowedTools: ['readFile'], ask: async () => 'no' })],
        printer: false,
      })

      const result = await agent.invoke('Read it')
      expect(result.stopReason).toBe('endTurn')
      expect(toolExecuted).toBe(true)
    })

    it('prompts for tools not in allowedTools', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'deleteFile', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('deleteFile', () => {
        toolExecuted = true
        return 'deleted'
      })

      const agent = new Agent({
        model,
        tools: [tool],
        interventions: [new HumanInTheLoop({ allowedTools: ['readFile'], ask: async () => 'no' })],
        printer: false,
      })

      await agent.invoke('Delete it')
      expect(toolExecuted).toBe(false)
    })

    it('allows all tools except negated ones with "!" prefix', async () => {
      const model = new MockMessageModel()
        .addTurn([
          { type: 'toolUseBlock', name: 'readFile', toolUseId: 'tool-1', input: {} },
          { type: 'toolUseBlock', name: 'deleteFile', toolUseId: 'tool-2', input: {} },
        ])
        .addTurn({ type: 'textBlock', text: 'Done' })

      const execLog: string[] = []
      const readTool = createMockTool('readFile', () => {
        execLog.push('read')
        return 'content'
      })
      const deleteTool = createMockTool('deleteFile', () => {
        execLog.push('delete')
        return 'deleted'
      })

      const agent = new Agent({
        model,
        tools: [readTool, deleteTool],
        interventions: [new HumanInTheLoop({ allowedTools: ['*', '!deleteFile'], ask: async () => 'no' })],
        printer: false,
      })

      await agent.invoke('Do both')

      expect(execLog).toContain('read')
      expect(execLog).not.toContain('delete')
    })

    it('allows all tools with wildcard "*"', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'dangerousTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('dangerousTool', () => {
        toolExecuted = true
        return 'ran'
      })

      const agent = new Agent({
        model,
        tools: [tool],
        interventions: [new HumanInTheLoop({ allowedTools: ['*'], ask: async () => 'no' })],
        printer: false,
      })

      const result = await agent.invoke('Do it')
      expect(result.stopReason).toBe('endTurn')
      expect(toolExecuted).toBe(true)
    })
  })

  describe('ask callback', () => {
    it('passes tool name and input in the prompt', async () => {
      const prompts: string[] = []

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'sendEmail', toolUseId: 'tool-1', input: { to: 'bob@example.com' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('sendEmail', () => 'sent')

      const agent = new Agent({
        model,
        tools: [tool],
        interventions: [
          new HumanInTheLoop({
            ask: async (prompt) => {
              prompts.push(prompt)
              return 'yes'
            },
          }),
        ],
        printer: false,
      })

      await agent.invoke('Send email')

      expect(prompts[0]).toContain('sendEmail')
      expect(prompts[0]).toContain('bob@example.com')
    })

    it('supports custom evaluate function', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'myTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('myTool', () => {
        toolExecuted = true
        return 'executed'
      })

      const agent = new Agent({
        model,
        tools: [tool],
        interventions: [
          new HumanInTheLoop({
            ask: async () => 'magic-word',
            evaluate: (response) => response === 'magic-word',
          }),
        ],
        printer: false,
      })

      const result = await agent.invoke('Go')
      expect(result.stopReason).toBe('endTurn')
      expect(toolExecuted).toBe(true)
    })
  })

  describe('trust mode (enableTrust: true)', () => {
    it('trusts a tool for the session when response is "t"', async () => {
      let askCount = 0

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'myTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'toolUseBlock', name: 'myTool', toolUseId: 'tool-2', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('myTool', () => 'executed')

      const agent = new Agent({
        model,
        tools: [tool],
        interventions: [
          new HumanInTheLoop({
            enableTrust: true,
            ask: async () => {
              askCount++
              return 't'
            },
          }),
        ],
        printer: false,
      })

      await agent.invoke('Run tool twice')

      expect(askCount).toBe(1)
    })

    it('does not trust when enableTrust is false even with "t" response', async () => {
      let askCount = 0

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'myTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'toolUseBlock', name: 'myTool', toolUseId: 'tool-2', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('myTool', () => 'executed')

      const agent = new Agent({
        model,
        tools: [tool],
        interventions: [
          new HumanInTheLoop({
            enableTrust: false,
            ask: async () => {
              askCount++
              return 't'
            },
          }),
        ],
        printer: false,
      })

      await agent.invoke('Run tool twice')

      // 't' is not recognized as approval when trust is disabled, so tool is denied both times
      // but ask is still called both times (no trust memory)
      expect(askCount).toBe(2)
    })

    it('"t" response also approves the current tool call', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'myTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('myTool', () => {
        toolExecuted = true
        return 'executed'
      })

      const agent = new Agent({
        model,
        tools: [tool],
        interventions: [new HumanInTheLoop({ enableTrust: true, ask: async () => 't' })],
        printer: false,
      })

      const result = await agent.invoke('Run tool')
      expect(result.stopReason).toBe('endTurn')
      expect(toolExecuted).toBe(true)
    })

    it.each(['trust', 'T', 'TRUST'])('trusts when response is "%s"', async (trustResponse) => {
      let askCount = 0

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'myTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'toolUseBlock', name: 'myTool', toolUseId: 'tool-2', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('myTool', () => 'executed')

      const agent = new Agent({
        model,
        tools: [tool],
        interventions: [
          new HumanInTheLoop({
            enableTrust: true,
            ask: async () => {
              askCount++
              return trustResponse
            },
          }),
        ],
        printer: false,
      })

      await agent.invoke('Run tool twice')
      expect(askCount).toBe(1)
    })

    it('supports custom evaluateTrust function', async () => {
      let askCount = 0

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'myTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'toolUseBlock', name: 'myTool', toolUseId: 'tool-2', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('myTool', () => 'executed')

      const agent = new Agent({
        model,
        tools: [tool],
        interventions: [
          new HumanInTheLoop({
            enableTrust: true,
            evaluateTrust: (r) => r === 'approve-and-remember',
            ask: async () => {
              askCount++
              return 'approve-and-remember'
            },
          }),
        ],
        printer: false,
      })

      await agent.invoke('Run tool twice')
      expect(askCount).toBe(1)
    })

    it('negated tools cannot be trusted even with "t" response', async () => {
      let askCount = 0
      let toolExecuted = false

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'dangerTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'toolUseBlock', name: 'dangerTool', toolUseId: 'tool-2', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('dangerTool', () => {
        toolExecuted = true
        return 'ran'
      })

      const agent = new Agent({
        model,
        tools: [tool],
        interventions: [
          new HumanInTheLoop({
            allowedTools: ['*', '!dangerTool'],
            enableTrust: true,
            ask: async () => {
              askCount++
              return 't'
            },
          }),
        ],
        printer: false,
      })

      await agent.invoke('Run danger twice')
      expect(askCount).toBe(2)
      expect(toolExecuted).toBe(false)
    })
  })

  describe('classifier mode', () => {
    it('classifier: true uses built-in LLM risk classifier', async () => {
      const classifierModel = new MockMessageModel().addTurn({
        type: 'toolUseBlock',
        name: 'strands_structured_output',
        toolUseId: 'inner-1',
        input: { requiresApproval: true, reason: 'destructive operation' },
      })

      const agentModel = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'deleteFile', toolUseId: 'tool-1', input: { path: '/data' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('deleteFile', () => {
        toolExecuted = true
        return 'deleted'
      })

      const agent = new Agent({
        model: agentModel,
        tools: [tool],
        interventions: [
          new HumanInTheLoop({
            classifier: { model: classifierModel },
          }),
        ],
        printer: false,
      })

      const result = await agent.invoke('Delete the file')

      expect(result.stopReason).toBe('interrupt')
      expect(toolExecuted).toBe(false)
    })

    it('classifier: true allows tool when LLM says no approval needed', async () => {
      const classifierModel = new MockMessageModel().addTurn({
        type: 'toolUseBlock',
        name: 'strands_structured_output',
        toolUseId: 'inner-1',
        input: { requiresApproval: false, reason: 'read-only operation' },
      })

      const agentModel = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'readFile', toolUseId: 'tool-1', input: { path: '/tmp/x' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('readFile', () => {
        toolExecuted = true
        return 'content'
      })

      const agent = new Agent({
        model: agentModel,
        tools: [tool],
        interventions: [
          new HumanInTheLoop({
            classifier: { model: classifierModel },
          }),
        ],
        printer: false,
      })

      const result = await agent.invoke('Read the file')

      expect(result.stopReason).toBe('endTurn')
      expect(toolExecuted).toBe(true)
    })

    it('allowedTools bypasses classifier', async () => {
      const classifierModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'unused' })
      const classifierSpy = vi.spyOn(classifierModel, 'stream')

      const agentModel = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'readFile', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('readFile', () => {
        toolExecuted = true
        return 'content'
      })

      const agent = new Agent({
        model: agentModel,
        tools: [tool],
        interventions: [
          new HumanInTheLoop({
            allowedTools: ['readFile'],
            classifier: { model: classifierModel },
          }),
        ],
        printer: false,
      })

      const result = await agent.invoke('Read')

      expect(result.stopReason).toBe('endTurn')
      expect(toolExecuted).toBe(true)
      expect(classifierSpy).not.toHaveBeenCalled()
    })

    it('custom classifier function works', async () => {
      const agentModel = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'deploy', toolUseId: 'tool-1', input: { env: 'prod' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('deploy', () => {
        toolExecuted = true
        return 'deployed'
      })

      const agent = new Agent({
        model: agentModel,
        tools: [tool],
        interventions: [
          new HumanInTheLoop({
            classifier: async (event: BeforeToolCallEvent) => ({
              requiresHumanInTheLoop: event.toolUse.name === 'deploy',
              reason: 'deployment requires approval',
            }),
          }),
        ],
        printer: false,
      })

      const result = await agent.invoke('Deploy')

      expect(result.stopReason).toBe('interrupt')
      expect(toolExecuted).toBe(false)
    })

    it('includes classifier reason in prompt', async () => {
      const prompts: string[] = []

      const agentModel = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'sendEmail', toolUseId: 'tool-1', input: { to: 'all@co.com' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('sendEmail', () => 'sent')

      const agent = new Agent({
        model: agentModel,
        tools: [tool],
        interventions: [
          new HumanInTheLoop({
            classifier: async () => ({ requiresHumanInTheLoop: true, reason: 'external communication' }),
            ask: async (prompt) => {
              prompts.push(prompt)
              return 'no'
            },
          }),
        ],
        printer: false,
      })

      await agent.invoke('Send email')

      expect(prompts[0]).toContain('external communication')
      expect(prompts[0]).toContain('sendEmail')
    })

    describe('request limits', () => {
      it('adds the classifier usage to the request total and runs it past a spent limit', async () => {
        const classifierModel = new MockMessageModel().addTurn(
          {
            type: 'toolUseBlock',
            name: 'strands_structured_output',
            toolUseId: 'inner-1',
            input: { requiresApproval: false, reason: 'read-only operation' },
          },
          { usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } }
        )
        const humanInTheLoop = new HumanInTheLoop({ classifier: { model: classifierModel } })
        const agent = new Agent({ model: new MockMessageModel(), printer: false })
        const parentInvocation = createInvocation({ turns: 1 })
        parentInvocation.turns = 5
        const event = new BeforeToolCallEvent({
          agent,
          toolUse: { name: 'readFile', toolUseId: 'tool-1', input: { path: '/tmp/x' } },
          tool: undefined,
          invocationState: {},
          invocation: parentInvocation,
        })

        const action = await humanInTheLoop.beforeToolCall(event)

        expect(action).toEqual({ type: 'proceed' })
        expect(parentInvocation.usage).toEqual({ inputTokens: 12, outputTokens: 3, totalTokens: 15 })
        expect(parentInvocation.turns).toBe(5)
      })
    })
  })
})

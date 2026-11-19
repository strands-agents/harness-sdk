import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../agent.js'
import { AfterInvocationEvent, AfterToolsEvent, BeforeToolCallEvent } from '../../hooks/index.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { ToolStreamEvent } from '../../tools/tool.js'
import type { Tool } from '../../tools/tool.js'
import { InterruptResponseContent } from '../../types/interrupt.js'
import { TextBlock, ToolResultBlock } from '../../types/messages.js'

function createStreamingTool(name: string, onRun: () => void): Tool {
  return {
    name,
    description: `Streaming tool ${name}`,
    toolSpec: { name, description: `Streaming tool ${name}`, inputSchema: { type: 'object', properties: {} } },
    async *stream(context) {
      onRun()
      yield new ToolStreamEvent({ data: 'progress' })
      return new ToolResultBlock({
        toolUseId: context.toolUse.toolUseId,
        status: 'success',
        content: [new TextBlock('ok')],
      })
    },
  }
}

function interruptStateOf(agent: Agent): { interrupts: Record<string, unknown> } {
  return (agent as unknown as { _interruptState: { interrupts: Record<string, unknown> } })._interruptState
}

function createToolLoopModel(toolTurns: number): MockMessageModel {
  const model = new MockMessageModel()
  for (let i = 1; i <= toolTurns; i++) {
    model.addTurn({ type: 'toolUseBlock', name: 'work', toolUseId: `tool-${i}`, input: {} })
  }
  return model.addTurn({ type: 'textBlock', text: 'done' })
}

// guards against the agent loop continuing after the consumer stops iterating stream() (#6091)
describe('Agent.stream early exit', () => {
  describe('when the consumer breaks while a tool is running', () => {
    it.each(['beforeToolCallEvent', 'toolStreamUpdateEvent', 'toolResultEvent'])(
      'stops the agent loop after a break at %s',
      async (breakAt) => {
        const model = createToolLoopModel(3)
        const toolRun = vi.fn()
        const afterTools = vi.fn()
        let cancelledInAfterInvocation: boolean | undefined
        const agent = new Agent({ model, printer: false, tools: [createStreamingTool('work', toolRun)] })
        agent.addHook(AfterToolsEvent, afterTools)
        agent.addHook(AfterInvocationEvent, (event) => {
          cancelledInAfterInvocation = event.agent.cancelSignal.aborted
        })

        for await (const event of agent.stream('go')) {
          if (event.type === breakAt) break
        }

        expect(model.callCount).toBe(1)
        expect(toolRun.mock.calls.length).toBeLessThanOrEqual(1)
        expect(afterTools).toHaveBeenCalledOnce()
        expect(cancelledInAfterInvocation).toBe(true)
        expect(agent.isInvoking).toBe(false)
        expect(agent.cancelSignal.aborted).toBe(false)
        expect(agent.messages).toStrictEqual([
          expect.objectContaining({ role: 'user' }),
          expect.objectContaining({ role: 'assistant', content: [new TextBlock('Cancelled by user')] }),
        ])
      }
    )

    it('leaves the agent reusable', async () => {
      const model = createToolLoopModel(1)
      const agent = new Agent({ model, printer: false, tools: [createStreamingTool('work', vi.fn())] })

      for await (const event of agent.stream('go')) {
        if (event.type === 'toolStreamUpdateEvent') break
      }
      const result = await agent.invoke('again')

      expect(result.stopReason).toBe('endTurn')
      expect(model.callCount).toBe(2)
    })

    it('aborts the cancel signal seen by an in-flight concurrent tool before waiting for it', async () => {
      const model = new MockMessageModel()
        .addTurn([
          { type: 'toolUseBlock', name: 'fast', toolUseId: 'fast-1', input: {} },
          { type: 'toolUseBlock', name: 'waiting', toolUseId: 'waiting-1', input: {} },
        ])
        .addTurn({ type: 'textBlock', text: 'done' })
      let waitingSawAbort = false
      const waiting: Tool = {
        name: 'waiting',
        description: 'Waits for cancellation',
        toolSpec: {
          name: 'waiting',
          description: 'Waits for cancellation',
          inputSchema: { type: 'object', properties: {} },
        },
        // eslint-disable-next-line require-yield
        async *stream(context) {
          await new Promise<void>((resolve) => {
            context.cancelSignal.addEventListener('abort', () => resolve(), { once: true })
          })
          waitingSawAbort = context.cancelSignal.aborted
          return new ToolResultBlock({
            toolUseId: context.toolUse.toolUseId,
            status: 'success',
            content: [new TextBlock('cancelled')],
          })
        },
      }
      const agent = new Agent({
        model,
        printer: false,
        toolExecutor: 'concurrent',
        tools: [createStreamingTool('fast', vi.fn()), waiting],
      })

      for await (const event of agent.stream('go')) {
        if (event.type === 'toolStreamUpdateEvent') break
      }

      expect(waitingSawAbort).toBe(true)
      expect(model.callCount).toBe(1)
      expect(agent.isInvoking).toBe(false)
    })
  })

  describe('when the consumer breaks outside tool execution', () => {
    it('closes the open user turn so the agent can be invoked again', async () => {
      const model = createToolLoopModel(1)
      const agent = new Agent({ model, printer: false, tools: [createStreamingTool('work', vi.fn())] })

      for await (const event of agent.stream('go')) {
        if (event.type === 'beforeToolsEvent') break
      }

      expect(model.callCount).toBe(1)
      expect(agent.messages.map((message) => message.role)).toStrictEqual(['user', 'assistant'])
    })
  })

  describe('when the consumer breaks at an interrupt', () => {
    function createApprovalAgent(toolTurns: number, interruptOnly?: string) {
      const model = createToolLoopModel(toolTurns)
      const toolRun = vi.fn()
      const agent = new Agent({ model, printer: false, tools: [createStreamingTool('work', toolRun)] })
      agent.addHook(BeforeToolCallEvent, (event) => {
        if (interruptOnly !== undefined && event.toolUse.toolUseId !== interruptOnly) return
        const approval = event.interrupt<string>({ name: 'approve', reason: 'Run the tool?' })
        if (approval !== 'yes') event.cancel = 'not approved'
      })
      return { model, toolRun, agent }
    }

    it('keeps the interrupted run resumable without a cancellation message', async () => {
      const { model, toolRun, agent } = createApprovalAgent(1)

      let interruptId: string | undefined
      for await (const event of agent.stream('go')) {
        if (event.type === 'interruptEvent') {
          interruptId = event.interrupt.id
          break
        }
      }
      const historyAtBreak = agent.messages.map((message) => message.role)
      const result = await agent.invoke([new InterruptResponseContent({ interruptId: interruptId!, response: 'yes' })])

      expect(historyAtBreak).toStrictEqual(['user'])
      expect(result.stopReason).toBe('endTurn')
      expect(toolRun).toHaveBeenCalledOnce()
      expect(model.callCount).toBe(2)
      expect(agent.messages.map((message) => message.role)).toStrictEqual(['user', 'assistant', 'user', 'assistant'])
    })

    it('stops the loop when the consumer breaks while a resumed tool is running', async () => {
      const { model, toolRun, agent } = createApprovalAgent(3, 'tool-1')
      const first = await agent.invoke('go')

      for await (const event of agent.stream([
        new InterruptResponseContent({ interruptId: first.interrupts![0]!.id, response: 'yes' }),
      ])) {
        if (event.type === 'toolResultEvent') break
      }

      expect(model.callCount).toBe(1)
      expect(toolRun).toHaveBeenCalledOnce()
    })

    it('keeps the run resumable when the consumer breaks before a resumed tool starts', async () => {
      const { model, toolRun, agent } = createApprovalAgent(2, 'tool-1')
      const first = await agent.invoke('go')
      const response = new InterruptResponseContent({ interruptId: first.interrupts![0]!.id, response: 'yes' })

      for await (const event of agent.stream([response])) {
        if (event.type === 'beforeToolCallEvent') break
      }
      const historyAtBreak = agent.messages.map((message) => message.role)
      const result = await agent.invoke([response])

      expect(historyAtBreak).toStrictEqual(['user'])
      expect(model.callCount).toBe(3)
      expect(toolRun).toHaveBeenCalledTimes(2)
      expect(result.stopReason).toBe('endTurn')
      expect(agent.messages.map((message) => message.role)).toStrictEqual([
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
        'assistant',
      ])
    })

    it('applies the same history rule to an explicit cancel() during a resumed run', async () => {
      const { agent } = createApprovalAgent(2, 'tool-1')
      const first = await agent.invoke('go')
      const response = new InterruptResponseContent({ interruptId: first.interrupts![0]!.id, response: 'yes' })

      for await (const event of agent.stream([response])) {
        if (event.type === 'beforeToolCallEvent') {
          agent.cancel()
          break
        }
      }
      const historyAtCancel = agent.messages.map((message) => message.role)
      await agent.invoke([response])

      expect(historyAtCancel).toStrictEqual(['user'])
      expect(agent.messages.map((message) => message.role)).toStrictEqual([
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
        'assistant',
      ])
    })

    it('rejects new input after a break in a resumed run until the interrupt is answered', async () => {
      const { agent } = createApprovalAgent(2, 'tool-1')
      const first = await agent.invoke('go')
      const response = new InterruptResponseContent({ interruptId: first.interrupts![0]!.id, response: 'yes' })

      for await (const event of agent.stream([response])) {
        if (event.type === 'beforeToolCallEvent') break
      }

      await expect(agent.invoke('hello')).rejects.toThrow(TypeError)
      await expect(agent.invoke([response])).resolves.toMatchObject({ stopReason: 'endTurn' })
    })
  })

  describe('when the consumer breaks at an interrupt raised by a batch of tools', () => {
    it('keeps every interrupt of the batch answerable', async () => {
      const model = new MockMessageModel()
        .addTurn([
          { type: 'toolUseBlock', name: 'work', toolUseId: 'tool-a', input: {} },
          { type: 'toolUseBlock', name: 'work', toolUseId: 'tool-b', input: {} },
        ])
        .addTurn({ type: 'textBlock', text: 'done' })
      const toolRun = vi.fn()
      const agent = new Agent({
        model,
        printer: false,
        toolExecutor: 'concurrent',
        tools: [createStreamingTool('work', toolRun)],
      })
      agent.addHook(BeforeToolCallEvent, (event) => {
        event.interrupt({ name: `approve-${event.toolUse.toolUseId}`, reason: 'Run the tool?' })
      })

      const interruptIds: string[] = []
      for await (const event of agent.stream('go')) {
        if (event.type === 'interruptEvent') {
          interruptIds.push(event.interrupt.id)
          break
        }
      }
      const pending = Object.keys(interruptStateOf(agent).interrupts)
      const result = await agent.invoke(
        pending.map((interruptId) => new InterruptResponseContent({ interruptId, response: 'yes' }))
      )

      expect(interruptIds).toHaveLength(1)
      expect(pending).toHaveLength(2)
      expect(result.stopReason).toBe('endTurn')
      expect(toolRun).toHaveBeenCalledTimes(2)
      expect(agent.messages.map((message) => message.role)).toStrictEqual(['user', 'assistant', 'user', 'assistant'])
    })
  })

  describe('when the consumer breaks at an interrupt raised inside an agent-as-tool', () => {
    it('keeps the orchestrator resumable without a cancellation message', async () => {
      const subModel = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'confirm', toolUseId: 'inner-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'sub done' })
      const confirm = createMockTool('confirm', (context) => {
        context.interrupt({ name: 'confirm', reason: 'Please confirm' })
        return 'ok'
      })
      const sub = new Agent({ id: 'sub', name: 'sub', model: subModel, tools: [confirm], printer: false })
      const orchModel = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'sub', toolUseId: 'outer-1', input: { input: 'go' } })
        .addTurn({ type: 'textBlock', text: 'orchestrator done' })
      const orchestrator = new Agent({ id: 'orch', model: orchModel, tools: [sub.asTool()], printer: false })

      let interruptId: string | undefined
      for await (const event of orchestrator.stream('go')) {
        if (event.type === 'interruptEvent') {
          interruptId = event.interrupt.id
          break
        }
      }
      const result = await orchestrator.invoke([
        new InterruptResponseContent({ interruptId: interruptId!, response: 'yes' }),
      ])

      expect(result.stopReason).toBe('endTurn')
      expect(orchModel.callCount).toBe(2)
      expect(orchestrator.messages.map((message) => message.role)).toStrictEqual([
        'user',
        'assistant',
        'user',
        'assistant',
      ])
      expect(orchestrator.isInvoking).toBe(false)
      expect(sub.isInvoking).toBe(false)
    })
  })

  describe('when the consumer breaks in a run resumed from a checkpoint', () => {
    it('stops the loop without another model call', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'work', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'toolUseBlock', name: 'work', toolUseId: 'tool-2', input: {} })
        .addTurn({ type: 'textBlock', text: 'done' })
      const agent = new Agent({
        model,
        printer: false,
        checkpointing: true,
        tools: [createStreamingTool('work', vi.fn())],
      })
      const paused = await agent.invoke('go')

      for await (const event of agent.stream({ checkpointResume: { checkpoint: paused.checkpoint!.toJSON() } })) {
        if (event.type === 'beforeToolCallEvent') break
      }

      expect(paused.stopReason).toBe('checkpoint')
      expect(model.callCount).toBe(2)
      expect(agent.isInvoking).toBe(false)
    })
  })

  describe('when the consumer does not break', () => {
    it('runs every cycle without cancelling', async () => {
      const model = createToolLoopModel(3)
      const toolRun = vi.fn()
      const agent = new Agent({ model, printer: false, tools: [createStreamingTool('work', toolRun)] })

      const result = await agent.invoke('go')

      expect(result.stopReason).toBe('endTurn')
      expect(model.callCount).toBe(4)
      expect(toolRun).toHaveBeenCalledTimes(3)
      expect(agent.cancelSignal.aborted).toBe(false)
    })
  })
})

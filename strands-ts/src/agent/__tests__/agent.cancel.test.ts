import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../agent.js'
import { AfterInvocationEvent, AfterModelCallEvent, BeforeModelCallEvent } from '../../hooks/index.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { TextBlock, ToolResultBlock } from '../../types/messages.js'
import { tool } from '../../tools/tool-factory.js'
import { z } from 'zod'

describe('Agent Cancellation', () => {
  describe('cancel() when idle', () => {
    it('is a no-op and cancelSignal is not aborted', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model })

      expect(agent.cancelSignal.aborted).toBe(false)
      agent.cancel() // Should not throw
      expect(agent.cancelSignal.aborted).toBe(false)
      expect(agent.cancelSignal.aborted).toBe(false)
    })
  })

  describe('cancel at top of loop (checkpoint A)', () => {
    it('cancels immediately with already-aborted signal', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const controller = new AbortController()
      controller.abort()

      const result = await agent.invoke('Hi', { cancelSignal: controller.signal })

      expect(result.stopReason).toBe('cancelled')
      expect(result.lastMessage.content[0]).toEqual(new TextBlock('Cancelled by user'))
      expect(agent.messages).toEqual([])
    })

    it('cancels at top of second cycle when tool calls cancel()', async () => {
      const executedTools: string[] = []

      let agent: Agent
      const tool = createMockTool('cancelTool', () => {
        executedTools.push('cancelTool')
        agent.cancel()
        return new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'success',
          content: [new TextBlock('Done')],
        })
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'cancelTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Should not reach' })

      agent = new Agent({ model, tools: [tool], printer: false })
      const result = await agent.invoke('Go')

      expect(result.stopReason).toBe('cancelled')
      expect(executedTools).toEqual(['cancelTool'])
      // messages: user, assistant(toolUse), user(toolResult), assistant(synthetic cancel)
      expect(agent.messages).toHaveLength(4)
      expect(agent.messages[3]!.content[0]).toEqual(new TextBlock('Cancelled by user'))
    })
  })

  describe('cancel during model streaming (checkpoint B)', () => {
    it('cancels when signal is aborted before model processes events', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      agent.addHook(BeforeModelCallEvent, () => {
        agent.cancel()
      })

      const result = await agent.invoke('Hi')

      expect(result.stopReason).toBe('cancelled')
      expect(result.lastMessage.content[0]).toEqual(new TextBlock('Cancelled by user'))
    })
  })

  describe('cancel before tool execution (checkpoint C)', () => {
    it('creates error results for all pending tools without executing them', async () => {
      let toolExecuted = false
      const tool = createMockTool('myTool', () => {
        toolExecuted = true
        return new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'success',
          content: [new TextBlock('Success')],
        })
      })

      const model = new MockMessageModel().addTurn({
        type: 'toolUseBlock',
        name: 'myTool',
        toolUseId: 'tool-1',
        input: {},
      })

      const agent = new Agent({ model, tools: [tool], printer: false })
      agent.addHook(AfterModelCallEvent, (event) => {
        if (event.stopData?.stopReason === 'toolUse') {
          agent.cancel()
        }
      })

      const result = await agent.invoke('Do it')

      expect(result.stopReason).toBe('cancelled')
      expect(toolExecuted).toBe(false)

      // Messages: user, assistant(toolUse), user(cancelled toolResult)
      expect(agent.messages).toHaveLength(3)
      const toolResultMsg = agent.messages[2]!
      expect(toolResultMsg.content[0]).toEqual(
        new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'error',
          content: [new TextBlock('Tool execution cancelled')],
        })
      )
    })

    it('creates error results for multiple pending tools', async () => {
      const tool1 = createMockTool('tool1', () => {
        return new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('R1')] })
      })
      const tool2 = createMockTool('tool2', () => {
        return new ToolResultBlock({ toolUseId: 't2', status: 'success', content: [new TextBlock('R2')] })
      })

      const model = new MockMessageModel().addTurn([
        { type: 'toolUseBlock', name: 'tool1', toolUseId: 't1', input: {} },
        { type: 'toolUseBlock', name: 'tool2', toolUseId: 't2', input: {} },
      ])

      const agent = new Agent({ model, tools: [tool1, tool2], printer: false })
      agent.addHook(AfterModelCallEvent, (event) => {
        if (event.stopData?.stopReason === 'toolUse') {
          agent.cancel()
        }
      })

      const result = await agent.invoke('Do both')

      expect(result.stopReason).toBe('cancelled')

      const toolResultMsg = agent.messages[2]!
      expect(toolResultMsg.content).toHaveLength(2)
      expect(toolResultMsg.content[0]).toEqual(
        new ToolResultBlock({ toolUseId: 't1', status: 'error', content: [new TextBlock('Tool execution cancelled')] })
      )
      expect(toolResultMsg.content[1]).toEqual(
        new ToolResultBlock({ toolUseId: 't2', status: 'error', content: [new TextBlock('Tool execution cancelled')] })
      )
    })
  })

  describe('cancel between sequential tool executions', () => {
    it('skips remaining tools after first tool calls cancel()', async () => {
      const executedTools: string[] = []

      let agent: Agent
      const tool1 = createMockTool('firstTool', () => {
        executedTools.push('firstTool')
        agent.cancel()
        return new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('Done')] })
      })
      const tool2 = createMockTool('secondTool', () => {
        executedTools.push('secondTool')
        return new ToolResultBlock({ toolUseId: 't2', status: 'success', content: [new TextBlock('Done')] })
      })

      const model = new MockMessageModel()
        .addTurn([
          { type: 'toolUseBlock', name: 'firstTool', toolUseId: 't1', input: {} },
          { type: 'toolUseBlock', name: 'secondTool', toolUseId: 't2', input: {} },
        ])
        .addTurn({ type: 'textBlock', text: 'Should not reach' })

      agent = new Agent({ model, tools: [tool1, tool2], toolExecutor: 'sequential', printer: false })
      const result = await agent.invoke('Go')

      expect(result.stopReason).toBe('cancelled')
      expect(executedTools).toEqual(['firstTool'])

      // First tool succeeded, second was cancelled
      // messages: user, assistant(toolUse), user(toolResults), assistant(synthetic cancel)
      expect(agent.messages).toHaveLength(4)
      const toolResultMsg = agent.messages[2]!
      expect(toolResultMsg.content[0]).toEqual(
        new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('Done')] })
      )
      expect(toolResultMsg.content[1]).toEqual(
        new ToolResultBlock({ toolUseId: 't2', status: 'error', content: [new TextBlock('Tool execution cancelled')] })
      )
    })
  })

  describe('InvokeOptions.cancelSignal', () => {
    it('cancels via external AbortSignal', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const controller = new AbortController()
      agent.addHook(BeforeModelCallEvent, () => {
        controller.abort()
      })

      const result = await agent.invoke('Hi', { cancelSignal: controller.signal })

      expect(result.stopReason).toBe('cancelled')
    })

    it('aborts the in-flight model stream and returns cancelled', async () => {
      const model = new MockMessageModel()
      let modelSignal: AbortSignal | undefined
      let resolveTransportPending!: () => void
      const transportPending = new Promise<void>((resolve) => {
        resolveTransportPending = resolve
      })
      vi.spyOn(model, 'stream').mockImplementation(async function* (_messages, options) {
        const signal = options?.cancelSignal
        modelSignal = signal

        yield { type: 'modelMessageStartEvent', role: 'assistant' }
        resolveTransportPending()
        if (!signal) {
          yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
          return
        }

        await new Promise<void>((_resolve, reject) => {
          const rejectWithAbort = (): void => {
            const error = new Error('transport aborted')
            error.name = 'AbortError'
            reject(error)
          }

          if (signal.aborted) {
            rejectWithAbort()
          } else {
            signal.addEventListener('abort', rejectWithAbort, { once: true })
          }
        })
      })
      const agent = new Agent({ model, printer: false })
      const controller = new AbortController()

      const invocation = agent.invoke('Hi', { cancelSignal: controller.signal })

      await transportPending
      expect(modelSignal).toBeDefined()
      expect(modelSignal).not.toBe(controller.signal)
      expect(modelSignal?.aborted).toBe(false)

      controller.abort()
      const result = await invocation

      expect(result.stopReason).toBe('cancelled')
      expect(modelSignal?.aborted).toBe(true)
    })
  })

  describe('agent reuse after cancel', () => {
    it('allows a second invocation after cancellation', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'First' })
        .addTurn({ type: 'textBlock', text: 'Second' })

      const agent = new Agent({ model, printer: false })

      let hookCallCount = 0
      agent.addHook(BeforeModelCallEvent, () => {
        hookCallCount++
        if (hookCallCount === 1) {
          agent.cancel()
        }
      })

      // First invocation: cancelled
      const result1 = await agent.invoke('Hello')
      expect(result1.stopReason).toBe('cancelled')

      // Second invocation: succeeds normally
      const result2 = await agent.invoke('Hello again')
      expect(result2.stopReason).toBe('endTurn')
      expect(result2.lastMessage.content[0]).toEqual(new TextBlock('Second'))
    })
  })

  describe('cancel via stream break (for-await + break)', () => {
    it('appends assistant message when stream is broken out of after cancel()', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'A long story...' })
      const agent = new Agent({ model, printer: false })

      for await (const event of agent.stream('Write a story')) {
        if (event.type === 'modelStreamUpdateEvent') {
          agent.cancel()
          break
        }
      }

      const lastMessage = agent.messages[agent.messages.length - 1]!
      expect(lastMessage.role).toBe('assistant')
      expect(lastMessage.content[0]).toEqual(new TextBlock('Cancelled by user'))
    })

    it('allows reuse after cancellation via stream break', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'A long story...' })
        .addTurn({ type: 'textBlock', text: 'pineapple' })

      const agent = new Agent({ model, printer: false })

      // First invocation: cancel during streaming via break
      for await (const event of agent.stream('Write a story')) {
        if (event.type === 'modelStreamUpdateEvent') {
          agent.cancel()
          break
        }
      }

      // Second invocation: should succeed normally
      const result = await agent.invoke('Say the word "pineapple"')
      expect(result.stopReason).toBe('endTurn')
      expect(result.lastMessage.content[0]).toEqual(new TextBlock('pineapple'))
    })
  })

  describe('AfterInvocationEvent', () => {
    it('still fires when invocation is cancelled', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      let afterInvocationFired = false
      agent.addHook(AfterInvocationEvent, () => {
        afterInvocationFired = true
      })

      agent.addHook(BeforeModelCallEvent, () => {
        agent.cancel()
      })

      await agent.invoke('Hi')
      expect(afterInvocationFired).toBe(true)
    })
  })

  describe('messages state invariants', () => {
    it('has no orphaned toolUse blocks after cancel during streaming', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      agent.addHook(BeforeModelCallEvent, () => {
        agent.cancel()
      })

      await agent.invoke('Hi')

      // Every assistant message with toolUse blocks must be followed by a user message with matching toolResults
      for (let i = 0; i < agent.messages.length; i++) {
        const msg = agent.messages[i]!
        if (msg.role === 'assistant') {
          const toolUseBlocks = msg.content.filter((b) => b.type === 'toolUseBlock')
          if (toolUseBlocks.length > 0) {
            const nextMsg = agent.messages[i + 1]
            expect(nextMsg).toBeDefined()
            expect(nextMsg!.role).toBe('user')
            const toolResultBlocks = nextMsg!.content.filter((b) => b.type === 'toolResultBlock')
            expect(toolResultBlocks).toHaveLength(toolUseBlocks.length)
          }
        }
      }
    })

    it('has no orphaned toolUse blocks after cancel before tools', async () => {
      const tool = createMockTool('myTool', () => {
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('Done')] })
      })

      const model = new MockMessageModel().addTurn({
        type: 'toolUseBlock',
        name: 'myTool',
        toolUseId: 'tool-1',
        input: {},
      })

      const agent = new Agent({ model, tools: [tool], printer: false })
      agent.addHook(AfterModelCallEvent, (event) => {
        if (event.stopData?.stopReason === 'toolUse') {
          agent.cancel()
        }
      })

      await agent.invoke('Do it')

      // Verify every toolUse has a matching toolResult
      for (let i = 0; i < agent.messages.length; i++) {
        const msg = agent.messages[i]!
        if (msg.role === 'assistant') {
          const toolUseBlocks = msg.content.filter((b) => b.type === 'toolUseBlock')
          if (toolUseBlocks.length > 0) {
            const nextMsg = agent.messages[i + 1]
            expect(nextMsg).toBeDefined()
            expect(nextMsg!.role).toBe('user')
            const toolResultBlocks = nextMsg!.content.filter((b) => b.type === 'toolResultBlock')
            expect(toolResultBlocks).toHaveLength(toolUseBlocks.length)
          }
        }
      }
    })
  })

  describe('tool-level cancellation cooperation', () => {
    it('passes agent.cancelSignal to foreground tools', async () => {
      let signalSeen: AbortSignal | undefined
      let agentSignalSeen: AbortSignal | undefined

      const signalTool = tool({
        name: 'signalTool',
        description: 'Tool that reads the cancellation signal',
        callback: (_input, context) => {
          signalSeen = context?.cancelSignal
          agentSignalSeen = context?.agent.cancelSignal
          return 'done'
        },
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'signalTool', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, tools: [signalTool], printer: false })
      await agent.invoke('Go')

      expect(signalSeen).toBeInstanceOf(AbortSignal)
      expect(signalSeen!.aborted).toBe(false)
      expect(signalSeen).toBe(agentSignalSeen)
    })

    it('signal is aborted when tool checks it after cancel()', async () => {
      let signalAborted: boolean | undefined

      let agent: Agent
      const checkTool = tool({
        name: 'checkTool',
        description: 'Tool that cancels then checks the signal',
        callback: (_input, context) => {
          agent.cancel()
          signalAborted = context?.cancelSignal.aborted
          return 'done'
        },
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'checkTool', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Should not reach' })

      agent = new Agent({ model, tools: [checkTool], printer: false })
      const result = await agent.invoke('Go')

      expect(signalAborted).toBe(true)
      expect(result.stopReason).toBe('cancelled')
    })
  })
})

describe('cancel during background-task settlement', () => {
  it('returns the completed result instead of resurrecting the invocation for delivery', async () => {
    const gate = (name: string) => {
      let signalStarted!: () => void
      const started = new Promise<void>((resolve) => (signalStarted = resolve))
      let release!: () => void
      const released = new Promise<void>((resolve) => (release = resolve))
      const gateTool = tool({
        name,
        description: `Gated tool ${name}`,
        inputSchema: z.object({}),
        callback: async (_input, context) => {
          signalStarted()
          await new Promise<void>((resolve) => {
            void released.then(resolve)
            context?.cancelSignal.addEventListener('abort', () => resolve(), { once: true })
          })
          return `${name} done`
        },
      })
      return { tool: gateTool, started, release }
    }
    const until = async (condition: () => boolean, label: string): Promise<void> => {
      for (let i = 0; i < 2000 && !condition(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      if (!condition()) throw new Error(`timed out waiting for: ${label}`)
    }
    const tasks = (agent: Agent) =>
      agent.appState.get('strands.backgroundTasks') as unknown as { status: string }[] | undefined

    const fast = gate('fast_work')
    const slow = gate('slow_work')
    const model = new MockMessageModel()
      .addTurn([
        { type: 'toolUseBlock', name: 'fast_work', toolUseId: 'fast-use', input: {} },
        { type: 'toolUseBlock', name: 'slow_work', toolUseId: 'slow-use', input: {} },
      ])
      .addTurn({ type: 'textBlock', text: 'first done' })
      .addTurn({ type: 'textBlock', text: 'next done' })
    const agent = new Agent({
      model,
      tools: [fast.tool, slow.tool],
      backgroundTasks: { always: [fast.tool, slow.tool] },
      printer: false,
    })

    // The invocation completes its final model pass, then blocks in the settlement
    // wait with one settled task (prepared delivery) and one still running.
    const first = agent.invoke('first')
    await fast.started
    await slow.started
    await until(
      () => agent.messages.some((m) => m.content.some((b) => b instanceof TextBlock && b.text === 'first done')),
      'first final turn'
    )
    fast.release()
    await until(() => (tasks(agent) ?? []).some((task) => task.status === 'completed'), 'fast task settled')
    expect(model.callCount).toBe(2)

    // cancel() must end the invocation: the prepared delivery continuation must not
    // wipe the abort and run further model passes.
    agent.cancel()
    const result = await first
    expect(result.stopReason).toBe('endTurn')
    expect(result.lastMessage.content[0]).toEqual(new TextBlock('first done'))
    expect(model.callCount).toBe(2)

    // Nothing is lost: the abandoned delivery is re-delivered in the next invocation.
    slow.release()
    await until(() => (tasks(agent) ?? []).every((task) => task.status === 'completed'), 'slow task settled')
    const next = await agent.invoke('next')
    expect(next.lastMessage.content[0]).toEqual(new TextBlock('next done'))
    expect(model.callCount).toBe(3)
    const deliveredTools = agent.messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'toolUseBlock' && b.name === 'strands_background_task_result')
      .map((b) => ((b as unknown as { input: { toolName: string } }).input ?? {}).toolName)
    expect(deliveredTools.sort()).toEqual(['fast_work', 'slow_work'])
    expect(tasks(agent)).toBeUndefined()
  })
})

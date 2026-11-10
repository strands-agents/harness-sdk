import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { collectGenerator } from '../../__fixtures__/model-test-helpers.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { ExecuteToolStage, AgentStreamStage } from '../stages.js'
import { TextBlock, ToolResultBlock } from '../../types/messages.js'
import { InterruptResponseContent } from '../../types/interrupt.js'
import { AfterInvocationEvent, InterruptEvent } from '../../hooks/events.js'

describe('Middleware interrupts', () => {
  describe('ExecuteToolStage', () => {
    it('middleware can raise an interrupt (agent stops with stopReason interrupt)', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'dangerousTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Should not reach' })

      const tool = createMockTool('dangerousTool', () => 'executed')
      const agent = new Agent({ model, tools: [tool], printer: false })

      agent.addMiddleware(ExecuteToolStage, async function* (context, next) {
        context.interrupt({ name: 'approve_tool', reason: 'Confirm execution?' })
        return yield* next(context)
      })

      const result = await agent.invoke('Do the dangerous thing')

      expect(result.stopReason).toBe('interrupt')
      expect(result.interrupts).toEqual([
        expect.objectContaining({ name: 'approve_tool', reason: 'Confirm execution?', source: 'middleware' }),
      ])
    })

    it('middleware gets response on resume and continues execution', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'dangerousTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('dangerousTool', () => {
        toolExecuted = true
        return 'executed'
      })

      const agent = new Agent({ model, tools: [tool], printer: false })

      agent.addMiddleware(ExecuteToolStage, async function* (context, next) {
        const { response: approval } = context.interrupt<string>({ name: 'approve_tool', reason: 'Confirm?' })
        if (approval !== 'yes') {
          return {
            result: new ToolResultBlock({
              toolUseId: context.toolUse.toolUseId,
              status: 'error',
              content: [new TextBlock('Denied by user')],
            }),
          }
        }
        return yield* next(context)
      })

      // First invocation: interrupt fires
      const interruptResult = await agent.invoke('Do it')
      expect(interruptResult.stopReason).toBe('interrupt')
      expect(toolExecuted).toBe(false)

      // Resume with approval
      const finalResult = await agent.invoke([
        new InterruptResponseContent({
          interruptId: interruptResult.interrupts![0]!.id,
          response: 'yes',
        }),
      ])

      expect(finalResult.stopReason).toBe('endTurn')
      expect(toolExecuted).toBe(true)
    })

    it('uses interrupt state restored after executor construction', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'dangerousTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('dangerousTool', () => {
        toolExecuted = true
        return 'executed'
      })
      const agent = new Agent({ model, tools: [tool], printer: false })

      agent.addMiddleware(ExecuteToolStage, async function* (context, next) {
        context.interrupt({ name: 'approve_tool', reason: 'Confirm?' })
        return yield* next(context)
      })

      const snapshot = agent.takeSnapshot({ include: ['interrupts'] })
      agent.loadSnapshot(snapshot)

      const interruptResult = await agent.invoke('Do it')
      const finalResult = await agent.invoke([
        new InterruptResponseContent({
          interruptId: interruptResult.interrupts![0]!.id,
          response: 'yes',
        }),
      ])

      expect({
        interruptStopReason: interruptResult.stopReason,
        finalStopReason: finalResult.stopReason,
        toolExecuted,
      }).toEqual({
        interruptStopReason: 'interrupt',
        finalStopReason: 'endTurn',
        toolExecuted: true,
      })
    })

    it('interrupt ID includes toolUseId for disambiguation', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'myTool', toolUseId: 'unique-tool-id', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('myTool', () => 'ok')
      const agent = new Agent({ model, tools: [tool], printer: false })

      agent.addMiddleware(ExecuteToolStage, async function* (context, next) {
        context.interrupt({ name: 'check' })
        return yield* next(context)
      })

      const result = await agent.invoke('Test')

      expect(result.interrupts![0]!.id).toContain('unique-tool-id')
      expect(result.interrupts![0]!.id).toContain('check')
    })

    it('preemptive response skips the interrupt (no halt)', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'myTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let toolExecuted = false
      const tool = createMockTool('myTool', () => {
        toolExecuted = true
        return 'ok'
      })

      const agent = new Agent({ model, tools: [tool], printer: false })

      agent.addMiddleware(ExecuteToolStage, async function* (context, next) {
        // Preemptive response: returns immediately without halting
        const { response: approval } = context.interrupt<string>({ name: 'check', response: 'pre-approved' })
        expect(approval).toBe('pre-approved')
        return yield* next(context)
      })

      const result = await agent.invoke('Test')

      expect(result.stopReason).toBe('endTurn')
      expect(toolExecuted).toBe(true)
    })

    it('yields InterruptEvent on the stream for ExecuteToolStage interrupts', async () => {
      // ExecuteToolStage interrupts propagate through the agent loop and hit
      // _stream's catch, which correctly yields InterruptEvent. This test
      // serves as a baseline showing the expected behavior that AgentStreamStage
      // interrupts should also follow.
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'myTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('myTool', () => 'ok')
      const agent = new Agent({ model, tools: [tool], printer: false })

      agent.addMiddleware(ExecuteToolStage, async function* (context, next) {
        context.interrupt({ name: 'tool_gate', reason: 'confirm tool?' })
        return yield* next(context)
      })

      const events: InterruptEvent[] = []
      for await (const event of agent.stream('Test')) {
        if (event instanceof InterruptEvent) events.push(event)
      }

      expect(events).toHaveLength(1)
      expect(events[0]!.interrupt).toMatchObject({ name: 'tool_gate' })
    })

    it('context spread preserves interrupt function', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'myTool', toolUseId: 'tool-1', input: { x: 1 } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('myTool', () => 'ok')
      const agent = new Agent({ model, tools: [tool], printer: false })

      agent.addMiddleware(ExecuteToolStage, async function* (context, next) {
        // Spread context to modify toolUse, interrupt should still work
        const modified = { ...context, toolUse: { ...context.toolUse, input: { x: 2 } } }
        modified.interrupt({ name: 'after_spread' })
        return yield* next(modified)
      })

      const result = await agent.invoke('Test')

      expect(result.stopReason).toBe('interrupt')
      expect(result.interrupts![0]!.name).toBe('after_spread')
    })
  })

  describe('AgentStreamStage', () => {
    it('middleware can raise an interrupt (agent stops with stopReason interrupt)', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      // eslint-disable-next-line require-yield
      agent.addMiddleware(AgentStreamStage, async function* (context) {
        context.interrupt({ name: 'confirm_stream', reason: 'Are you sure?' })
        // unreachable — interrupt() throws
        return undefined as never
      })

      const { result } = await collectGenerator(agent.stream('Test'))

      expect(result.stopReason).toBe('interrupt')
      expect(result.interrupts).toEqual([expect.objectContaining({ name: 'confirm_stream', reason: 'Are you sure?' })])
      // lastMessage should match _createInterruptResult behavior (fallback when no messages exist)
      expect(result.lastMessage.content).toEqual([new TextBlock('Interrupted')])
    })

    it('interrupt lastMessage uses last existing message when messages exist', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'First response' })
        .addTurn({ type: 'textBlock', text: 'Should not reach' })

      const agent = new Agent({ model, printer: false })

      // First invocation succeeds — populates messages
      await agent.invoke('Hello')

      // Now add middleware that interrupts on the next call
      // eslint-disable-next-line require-yield
      agent.addMiddleware(AgentStreamStage, async function* (context) {
        context.interrupt({ name: 'gate' })
        return undefined as never
      })

      const { result } = await collectGenerator(agent.stream('Second call'))

      expect(result.stopReason).toBe('interrupt')
      // lastMessage should be the last message from the prior invocation
      expect(result.lastMessage.content[0]).toEqual(new TextBlock('First response'))
    })

    it('middleware gets response on resume and continues', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      agent.addMiddleware(AgentStreamStage, async function* (context, next) {
        const { response: approval } = context.interrupt<string>({ name: 'gate', reason: 'Proceed?' })
        if (approval !== 'go') {
          return { result: { stopReason: 'endTurn' } } as never
        }
        return yield* next(context)
      })

      // First: interrupt
      const { result: interruptResult } = await collectGenerator(agent.stream('Test'))
      expect(interruptResult.stopReason).toBe('interrupt')

      // Resume
      const { result: finalResult } = await collectGenerator(
        agent.stream([
          new InterruptResponseContent({
            interruptId: interruptResult.interrupts![0]!.id,
            response: 'go',
          }),
        ])
      )

      expect(finalResult.stopReason).toBe('endTurn')
    })

    it('clears interrupt state after resuming to a non-tool completion so the agent is reusable', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'Resumed' })
        .addTurn({ type: 'textBlock', text: 'Fresh' })

      let interrupted = false
      const agent = new Agent({ model, printer: false })
      agent.addMiddleware(AgentStreamStage, async function* (context, next) {
        if (!interrupted) {
          interrupted = true
          context.interrupt({ name: 'gate' })
        }
        return yield* next(context)
      })

      const { result: interruptResult } = await collectGenerator(agent.stream('Test'))
      expect(interruptResult.stopReason).toBe('interrupt')

      // Resume to a plain end-of-turn (no tool cycle to clear interrupt state).
      const { result: resumedResult } = await collectGenerator(
        agent.stream([
          new InterruptResponseContent({ interruptId: interruptResult.interrupts![0]!.id, response: 'go' }),
        ])
      )
      expect(resumedResult.stopReason).toBe('endTurn')

      // A subsequent fresh invocation must not be rejected as "still interrupted".
      const freshResult = await agent.invoke('Fresh call')
      expect(freshResult.stopReason).toBe('endTurn')
    })

    it('re-reads the resumed response after next() even when a tool ran in the pass', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'calc', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'done' })
      const tool = createMockTool('calc', () => 'ok')
      const agent = new Agent({ model, tools: [tool], printer: false })

      const reads: Array<[string, unknown]> = []
      agent.addMiddleware(AgentStreamStage, async function* (context, next) {
        const pre = context.interrupt<string>({ name: 'gate' })
        reads.push(['pre', pre.response])
        const result = yield* next(context)
        const post = context.interrupt<string>({ name: 'gate' })
        reads.push(['post', post.response])
        return result
      })

      const { result: interruptResult } = await collectGenerator(agent.stream('go'))
      expect(interruptResult.stopReason).toBe('interrupt')

      const { result: finalResult } = await collectGenerator(
        agent.stream([
          new InterruptResponseContent({ interruptId: interruptResult.interrupts![0]!.id, response: 'go' }),
        ])
      )

      expect(finalResult.stopReason).toBe('endTurn')
      expect(reads).toEqual([
        ['pre', 'go'],
        ['post', 'go'],
      ])
    })

    it('interrupt ID uses agentStream namespace', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      // eslint-disable-next-line require-yield
      agent.addMiddleware(AgentStreamStage, async function* (context) {
        context.interrupt({ name: 'my_gate' })
        return undefined as never
      })

      const { result } = await collectGenerator(agent.stream('Test'))

      expect(result.interrupts![0]!.id).toContain('agentStream')
      expect(result.interrupts![0]!.id).toContain('my_gate')
    })

    it('yields InterruptEvent on the stream for AgentStreamStage interrupts', async () => {
      // Issue: tool/hook interrupts yield InterruptEvent on the stream, but
      // AgentStreamStage middleware interrupts do not — stream consumers that
      // listen for InterruptEvent will silently miss middleware-raised interrupts.
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      // eslint-disable-next-line require-yield
      agent.addMiddleware(AgentStreamStage, async function* (context) {
        context.interrupt({ name: 'stream_gate', reason: 'confirm?' })
        return undefined as never
      })

      const events: InterruptEvent[] = []
      for await (const event of agent.stream('Test')) {
        if (event instanceof InterruptEvent) events.push(event)
      }

      // Expect at least one InterruptEvent, matching what tool/hook interrupts produce
      expect(events).toHaveLength(1)
      expect(events[0]!.interrupt).toMatchObject({ name: 'stream_gate' })
    })
  })

  // Limitation: AgentStreamStage middleware cannot easily resume tool-level interrupts today.
  // Interrupt resolution (_interruptState.resume()) runs in stream()'s outer loop, outside
  // middleware. A future enhancement could add a resume mechanism to AgentStreamResult or
  // AgentStreamContext so middleware can signal "re-run with these interrupt responses."
  describe('resume via AfterInvocationEvent hook', () => {
    it('AfterInvocationEvent hook can resume a tool-level interrupt in middleware', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'myTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done after resume' })

      let toolExecCount = 0
      const tool = createMockTool('myTool', () => {
        toolExecCount++
        return 'ok'
      })
      const agent = new Agent({ model, tools: [tool], printer: false })

      agent.addMiddleware(ExecuteToolStage, async function* (context, next) {
        const { response: approval } = context.interrupt<string>({ name: 'gate' })
        if (approval !== 'approved') {
          return {
            result: new ToolResultBlock({
              toolUseId: context.toolUse.toolUseId,
              status: 'error',
              content: [new TextBlock('Denied')],
            }),
          }
        }
        return yield* next(context)
      })

      agent.addHook(AfterInvocationEvent, (event: AfterInvocationEvent) => {
        const unanswered = (event.agent as Agent)._interruptState.getUnansweredInterrupts()
        if (unanswered.length > 0) {
          event.resume = [new InterruptResponseContent({ interruptId: unanswered[0]!.id, response: 'approved' })]
        }
      })

      const result = await agent.invoke('Do it')

      expect(result.stopReason).toBe('endTurn')
      expect(toolExecCount).toBe(1)
    })
  })
})

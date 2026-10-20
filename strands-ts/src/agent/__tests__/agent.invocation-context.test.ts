import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../agent.js'
import {
  createAuxiliaryInvocationContext,
  type InvocationContext,
  InvocationContextImpl,
  unwrapInvocationContext,
} from '../invocation-context.js'
import { AfterInvocationEvent, BeforeInvocationEvent, BeforeModelCallEvent } from '../../hooks/events.js'
import { tool } from '../../tools/tool-factory.js'
import type { ToolContext } from '../../tools/tool.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { Message, TextBlock } from '../../types/messages.js'
import { anyTrackingId } from '../../__fixtures__/message-helpers.js'

describe('Agent request-wide limits', () => {
  it('leaves the parent limit intact and the child uncounted when a hand-written tool forwards invocationState', async () => {
    const sub = new Agent({
      model: new MockMessageModel().addTurn(
        { type: 'textBlock', text: 'sub done' },
        { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      ),
      printer: false,
    })

    let subRuns = 0
    const relay = tool({
      name: 'relay',
      description: 'runs the sub-agent',
      callback: async (_input: unknown, context: ToolContext) => {
        const subResult = await sub.invoke('go', { invocationState: context.invocationState })
        expect(subResult.stopReason).toBe('endTurn')
        subRuns += 1
        return 'ok'
      },
    })

    const parentModel = new MockMessageModel()
      .addTurn([{ type: 'toolUseBlock', name: 'relay', toolUseId: 'tu-1', input: {} }], {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      })
      .addTurn([{ type: 'toolUseBlock', name: 'relay', toolUseId: 'tu-2', input: {} }], {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      })
      .addTurn([{ type: 'toolUseBlock', name: 'relay', toolUseId: 'tu-3', input: {} }], {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      })
    const parent = new Agent({ model: parentModel, tools: [relay], printer: false })

    const result = await parent.invoke('start', { limits: { turns: 2 } })

    expect(result.stopReason).toBe('limitTurns')
    expect(parentModel.callCount).toBe(2)
    expect(subRuns).toBe(2)
  })

  it('produces a well-formed result when an inherited limit is already exhausted on entry', async () => {
    const agent = new Agent({
      model: new MockMessageModel().addTurn(
        { type: 'textBlock', text: 'should not run' },
        { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      ),
      messages: [
        new Message({ role: 'user', content: [new TextBlock('earlier question')] }),
        new Message({ role: 'assistant', content: [new TextBlock('earlier answer')] }),
      ],
      printer: false,
    })

    const inherited = new InvocationContextImpl({ turns: 1 })
    inherited.usage.turnsTaken = 5
    const result = await agent.invoke('go', { invocationContext: inherited })

    expect(result.stopReason).toBe('limitTurns')
    expect(result.lastMessage).toEqual(new Message({ role: 'assistant', content: [], trackingId: anyTrackingId }))
    expect(result.toString()).toBe('')
  })

  it('rejects invalid limits before any invocation hook runs', async () => {
    const agent = new Agent({ model: new MockMessageModel(), printer: false })
    const beforeInvocation = vi.fn()
    agent.addHook(BeforeInvocationEvent, beforeInvocation)

    await expect(agent.invoke('go', { limits: { turns: 0 } })).rejects.toThrow(TypeError)
    expect(beforeInvocation).not.toHaveBeenCalled()
  })

  it('does not throw when the invocationState bag is frozen', async () => {
    const agent = new Agent({
      model: new MockMessageModel().addTurn(
        { type: 'textBlock', text: 'done' },
        { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      ),
      printer: false,
    })

    const result = await agent.invoke('hi', { invocationState: Object.freeze({}) })

    expect(result.stopReason).toBe('endTurn')
  })

  it("reports the whole request's usage on the result, while metrics cover this agent only", async () => {
    const inner = new Agent({
      model: new MockMessageModel().addTurn(
        { type: 'textBlock', text: 'inner done' },
        { usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 } }
      ),
      name: 'inner',
      description: 'inner agent',
      printer: false,
    })
    const outer = new Agent({
      model: new MockMessageModel()
        .addTurn([{ type: 'toolUseBlock', name: 'inner', toolUseId: 'tu-1', input: { input: 'hi' } }], {
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        })
        .addTurn(
          { type: 'textBlock', text: 'outer done' },
          { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
        ),
      tools: [inner.asTool()],
      printer: false,
    })

    const result = await outer.invoke('go')

    expect({ requestUsage: result.invocationContext?.usage, agentUsage: result.metrics?.accumulatedUsage }).toEqual({
      requestUsage: { turnsTaken: 3, inputTokens: 7, outputTokens: 10, totalTokens: 17 },
      agentUsage: expect.objectContaining({ inputTokens: 2, outputTokens: 3, totalTokens: 5 }),
    })
  })

  it("continues a previous call's limits and usage when passed its invocation context", async () => {
    const model = new MockMessageModel()
      .addTurn({ type: 'textBlock', text: 'first' }, { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })
      .addTurn({ type: 'textBlock', text: 'second' }, { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })
      .addTurn({ type: 'textBlock', text: 'never reached' })
    const agent = new Agent({ model, printer: false })

    const first = await agent.invoke('one', { limits: { turns: 2 } })
    const second = await agent.invoke('two', { invocationContext: first.invocationContext! })
    const third = await agent.invoke('three', { invocationContext: second.invocationContext! })

    expect({
      stopReasons: [first.stopReason, second.stopReason, third.stopReason],
      sameContext: second.invocationContext === first.invocationContext,
      usage: third.invocationContext?.usage,
      modelCalls: model.callCount,
    }).toEqual({
      stopReasons: ['endTurn', 'endTurn', 'limitTurns'],
      sameContext: true,
      usage: { turnsTaken: 2, inputTokens: 2, outputTokens: 2, totalTokens: 4 },
      modelCalls: 2,
    })
  })

  it("counts only a nested invoke's own tokens against its own token limits", async () => {
    const agent = new Agent({
      model: new MockMessageModel().addTurn(
        { type: 'textBlock', text: 'done' },
        { usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } }
      ),
      printer: false,
    })
    const enclosing = new InvocationContextImpl()
    enclosing.recordUsage({ inputTokens: 4000, outputTokens: 4000, totalTokens: 8000 })

    const result = await agent.invoke('go', { invocationContext: enclosing, limits: { totalTokens: 5000 } })

    expect({
      stopReason: result.stopReason,
      ownUsage: result.invocationContext?.usage,
      requestUsage: enclosing.usage,
    }).toEqual({
      stopReason: 'endTurn',
      ownUsage: { turnsTaken: 1, inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      requestUsage: { turnsTaken: 1, inputTokens: 4010, outputTokens: 4010, totalTokens: 8020 },
    })
  })

  it("stops a nested invoke on the request's limit even when its own limit is looser", async () => {
    const loopTool = tool({ name: 'loop', description: 'loops', callback: () => 'again' })
    const model = new MockMessageModel()
      .addTurn([{ type: 'toolUseBlock', name: 'loop', toolUseId: 'tu-1', input: {} }])
      .addTurn([{ type: 'toolUseBlock', name: 'loop', toolUseId: 'tu-2', input: {} }])
    const agent = new Agent({ model, tools: [loopTool], printer: false })
    const request = new InvocationContextImpl({ turns: 2 })
    request.usage.turnsTaken = 1

    const result = await agent.invoke('go', { invocationContext: request, limits: { turns: 5 } })

    expect({
      stopReason: result.stopReason,
      modelCalls: model.callCount,
      requestTurns: request.usage.turnsTaken,
    }).toEqual({
      stopReason: 'limitTurns',
      modelCalls: 1,
      requestTurns: 2,
    })
  })

  it('stops a nested invoke on its own tighter limit and counts its turns toward the request', async () => {
    const loopTool = tool({ name: 'loop', description: 'loops', callback: () => 'again' })
    const model = new MockMessageModel()
      .addTurn([{ type: 'toolUseBlock', name: 'loop', toolUseId: 'tu-1', input: {} }], {
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      })
      .addTurn({ type: 'textBlock', text: 'never reached' })
    const agent = new Agent({ model, tools: [loopTool], printer: false })
    const enclosing = new InvocationContextImpl({ turns: 10 })

    const result = await agent.invoke('go', { invocationContext: enclosing, limits: { turns: 1 } })

    expect(result.stopReason).toBe('limitTurns')
    expect(model.callCount).toBe(1)
    expect(enclosing.usage).toEqual({ turnsTaken: 1, inputTokens: 1, outputTokens: 2, totalTokens: 3 })
  })

  it('folds an auxiliary call into the request total without limiting it', async () => {
    const parentInvocationContext = new InvocationContextImpl({ turns: 1 })
    parentInvocationContext.recordUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 3 })
    parentInvocationContext.usage.turnsTaken = 5

    const aux = new Agent({
      model: new MockMessageModel().addTurn(
        { type: 'textBlock', text: 'aux done' },
        { usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 } }
      ),
      printer: false,
    })

    const result = await aux.invoke('go', {
      invocationContext: createAuxiliaryInvocationContext(parentInvocationContext)!,
    })

    expect(result.stopReason).toBe('endTurn')
    expect(parentInvocationContext.usage).toEqual({ turnsTaken: 5, inputTokens: 5, outputTokens: 7, totalTokens: 12 })
  })

  it('joins the request when a hand-written tool forwards context.invocationContext', async () => {
    const sub = new Agent({
      model: new MockMessageModel().addTurn(
        { type: 'textBlock', text: 'sub done' },
        { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      ),
      printer: false,
    })

    const relay = tool({
      name: 'relay',
      description: 'runs the sub-agent',
      callback: async (_input: unknown, context: ToolContext) => {
        const subResult = await sub.invoke('go', {
          ...(context.invocationContext && { invocationContext: context.invocationContext }),
        })
        return subResult.stopReason
      },
    })

    const parentModel = new MockMessageModel()
      .addTurn([{ type: 'toolUseBlock', name: 'relay', toolUseId: 'tu-1', input: {} }])
      .addTurn([{ type: 'toolUseBlock', name: 'relay', toolUseId: 'tu-2', input: {} }])
    const parent = new Agent({ model: parentModel, tools: [relay], printer: false })

    const result = await parent.invoke('start', { limits: { turns: 2 } })

    expect(result.stopReason).toBe('limitTurns')
    expect(parentModel.callCount).toBe(1)
  })

  it('attaches one request handle to the events and tool context it hands out', async () => {
    let probeContext: ToolContext | undefined
    const probe = tool({
      name: 'probe',
      description: 'captures its tool context',
      callback: (_input: unknown, context: ToolContext) => {
        probeContext = context
        return 'ok'
      },
    })
    const agent = new Agent({
      model: new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'probe', toolUseId: 'tu-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'done' }),
      tools: [probe],
      printer: false,
    })
    const modelCallEvents: BeforeModelCallEvent[] = []
    agent.addHook(BeforeModelCallEvent, (event) => {
      modelCallEvents.push(event)
    })

    await agent.invoke('go')

    const invocationContext = modelCallEvents[0]?.invocationContext
    expect(invocationContext).toBeInstanceOf(InvocationContextImpl)
    expect(modelCallEvents[1]?.invocationContext).toBe(invocationContext)
    expect(probeContext?.invocationContext).toBe(invocationContext)
  })

  it('rejects an invocation context the SDK did not create', async () => {
    const agent = new Agent({
      model: new MockMessageModel().addTurn({ type: 'textBlock', text: 'done' }),
      printer: false,
    })

    await expect(agent.invoke('hi', { invocationContext: {} as InvocationContext })).rejects.toThrow(
      'invocationContext was not created by the SDK'
    )
  })

  it('starts fresh request state on each root invoke of a reused agent', async () => {
    const agent = new Agent({
      model: new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'first' })
        .addTurn({ type: 'textBlock', text: 'second' }),
      printer: false,
    })
    const modelCallEvents: BeforeModelCallEvent[] = []
    agent.addHook(BeforeModelCallEvent, (event) => {
      modelCallEvents.push(event)
    })

    await agent.invoke('one')
    await agent.invoke('two')

    const firstInvocationContext = modelCallEvents[0]?.invocationContext
    const secondInvocationContext = modelCallEvents[1]?.invocationContext
    expect(firstInvocationContext).toBeDefined()
    expect(secondInvocationContext).toBeDefined()
    expect(secondInvocationContext).not.toBe(firstInvocationContext)
    expect(unwrapInvocationContext(secondInvocationContext)?.usage.turnsTaken).toBe(1)
  })

  it('ends on a limit stop even when a hook asks to resume', async () => {
    const loopTool = tool({ name: 'loop', description: 'loops', callback: () => 'again' })
    const model = new MockMessageModel().addTurn([{ type: 'toolUseBlock', name: 'loop', toolUseId: 'tu-1', input: {} }])
    const agent = new Agent({ model, tools: [loopTool], printer: false })
    let passes = 0
    let modelCalls = 0
    agent.addHook(BeforeInvocationEvent, () => {
      passes += 1
    })
    agent.addHook(BeforeModelCallEvent, () => {
      modelCalls += 1
    })
    // Bounded so a regression fails on the pass count instead of looping forever.
    agent.addHook(AfterInvocationEvent, (event) => {
      if (passes < 5) event.resume = 'try again'
    })

    const result = await agent.invoke('go', { limits: { turns: 1 } })

    expect(result.stopReason).toBe('limitTurns')
    expect(passes).toBe(1)
    expect(modelCalls).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import { Agent } from '../agent.js'
import {
  createInvocation,
  createAuxiliaryInvocation,
  InternalInvocation,
  toInternal,
  type Invocation,
} from '../invocation.js'
import { AfterInvocationEvent, BeforeInvocationEvent, BeforeModelCallEvent } from '../../hooks/events.js'
import { tool } from '../../tools/tool-factory.js'
import type { ToolContext } from '../../tools/tool.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'

describe('Agent request-wide limits', () => {
  it('leaves the parent limit intact and the child uncounted when a hand-written tool forwards invocationState', async () => {
    // Joining is opt-in through InvokeOptions.invocation, not the invocationState
    // bag. A sub-agent run on the forwarded bag alone executes standalone: the
    // parent's limit counts only the parent's own turns, and the child is never gated.
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
        // The child runs standalone, unaffected by the parent's limit.
        expect(subResult.stopReason).toBe('endTurn')
        subRuns += 1
        return 'ok'
      },
    })

    // Parent would loop indefinitely (every turn requests the tool) absent a limit.
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

    // The limit trips on the parent's own second turn; the child ran to completion
    // on both turns because its work never counted against the limit.
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
      printer: false,
    })

    // Inherit an enclosing request whose turn limit is already spent, so the loop
    // trips before its first message is appended.
    const inherited = createInvocation({ turns: 1 })
    inherited.turns = 5
    const result = await agent.invoke('go', { invocation: inherited })

    expect(result.stopReason).toBe('limitTurns')
    expect(() => result.toString()).not.toThrow()
    expect(result.toString()).toBe('')
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

    expect({ requestUsage: result.requestUsage, agentUsage: result.metrics?.accumulatedUsage }).toEqual({
      requestUsage: { inputTokens: 7, outputTokens: 10, totalTokens: 17 },
      agentUsage: expect.objectContaining({ inputTokens: 2, outputTokens: 3, totalTokens: 5 }),
    })
  })

  it('throws when limits are set on a nested invoke whose request already has limits', async () => {
    const agent = new Agent({
      model: new MockMessageModel().addTurn({ type: 'textBlock', text: 'done' }),
      printer: false,
    })

    await expect(
      agent.invoke('hi', { invocation: createInvocation({ turns: 3 }), limits: { turns: 1 } })
    ).rejects.toThrow(
      new TypeError('limits cannot be set on a nested invoke whose enclosing request already has limits')
    )
  })

  it('applies a nested invoke its own limits when the request it joins has none', async () => {
    const loopTool = tool({ name: 'loop', description: 'loops', callback: () => 'again' })
    const model = new MockMessageModel()
      .addTurn([{ type: 'toolUseBlock', name: 'loop', toolUseId: 'tu-1', input: {} }], {
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      })
      .addTurn({ type: 'textBlock', text: 'never reached' })
    const agent = new Agent({ model, tools: [loopTool], printer: false })
    const enclosing = createInvocation()

    const result = await agent.invoke('go', { invocation: enclosing, limits: { turns: 1 } })

    expect(result.stopReason).toBe('limitTurns')
    expect(model.callCount).toBe(1)
    expect({ usage: enclosing.usage, turns: enclosing.turns }).toEqual({
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      turns: 0,
    })
  })

  it('folds an auxiliary call into the request total without limiting it', async () => {
    // An enclosing request whose turn limit is already spent.
    const parentInvocation = new InternalInvocation({ turns: 1 }, { inputTokens: 1, outputTokens: 2, totalTokens: 3 })
    parentInvocation.turns = 5

    const aux = new Agent({
      model: new MockMessageModel().addTurn(
        { type: 'textBlock', text: 'aux done' },
        { usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 } }
      ),
      printer: false,
    })

    const result = await aux.invoke('go', {
      invocation: createAuxiliaryInvocation(parentInvocation)!,
    })

    // The auxiliary agent runs to completion despite the spent limit...
    expect(result.stopReason).toBe('endTurn')
    // ...and its tokens fold into the shared request total.
    expect(parentInvocation.usage).toEqual({ inputTokens: 5, outputTokens: 7, totalTokens: 12 })
  })

  it('joins the request when a hand-written tool forwards context.invocation', async () => {
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
        const subResult = await sub.invoke('go', { ...(context.invocation && { invocation: context.invocation }) })
        return subResult.stopReason
      },
    })

    const parentModel = new MockMessageModel()
      .addTurn([{ type: 'toolUseBlock', name: 'relay', toolUseId: 'tu-1', input: {} }])
      .addTurn([{ type: 'toolUseBlock', name: 'relay', toolUseId: 'tu-2', input: {} }])
    const parent = new Agent({ model: parentModel, tools: [relay], printer: false })

    const result = await parent.invoke('start', { limits: { turns: 2 } })

    // Parent turn 1 plus the child's turn spend the limit before the parent's second turn.
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

    const invocation = modelCallEvents[0]?.invocation
    expect(invocation).toBeInstanceOf(InternalInvocation)
    expect(modelCallEvents[1]?.invocation).toBe(invocation)
    expect(probeContext?.invocation).toBe(invocation)
  })

  it('rejects an invocation handle the SDK did not create', async () => {
    const agent = new Agent({
      model: new MockMessageModel().addTurn({ type: 'textBlock', text: 'done' }),
      printer: false,
    })

    await expect(agent.invoke('hi', { invocation: {} as Invocation })).rejects.toThrow(
      'invocation was not created by the SDK'
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

    const firstInvocation = modelCallEvents[0]?.invocation
    const secondInvocation = modelCallEvents[1]?.invocation
    expect(firstInvocation).toBeDefined()
    expect(secondInvocation).toBeDefined()
    expect(secondInvocation).not.toBe(firstInvocation)
    expect(toInternal(secondInvocation)?.turns).toBe(1)
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

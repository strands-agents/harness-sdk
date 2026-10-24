import { describe, expect, it } from 'vitest'
import { Agent } from '../agent.js'
import {
  AfterInvocationEvent,
  AgentResultEvent,
  BeforeInvocationEvent,
  InterruptEvent,
  MessageAddedEvent,
} from '../../hooks/index.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { tool } from '../../tools/tool-factory.js'
import { PendingInvocationCancelledError } from '../../errors.js'
import { TextBlock, ToolResultBlock, type Message } from '../../types/messages.js'
import { continuations } from '../continuation.js'
import type { StreamOptions } from '../../models/model.js'
import type { ModelStreamEvent } from '../../models/streaming.js'
import { InterruptResponseContent } from '../../types/interrupt.js'

function createGate(name = 'gate') {
  let signalStarted!: () => void
  const started = new Promise<void>((resolve) => (signalStarted = resolve))
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  let aborted = false

  const gateTool = tool({
    name,
    description: `Gated tool ${name}`,
    callback: async (_input, context) => {
      signalStarted()
      await new Promise<void>((resolve) => {
        void released.then(resolve)
        context?.cancelSignal.addEventListener(
          'abort',
          () => {
            aborted = true
            resolve()
          },
          { once: true }
        )
      })
      return 'gate done'
    },
  })

  return { tool: gateTool, started, release, wasAborted: () => aborted }
}

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let hop = 0; hop < 2000 && !condition(); hop++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  if (!condition()) throw new Error(`timed out waiting for: ${label}`)
}

function resultText(result: { lastMessage: { content: readonly unknown[] } }): string {
  const block = result.lastMessage.content[0]
  return block instanceof TextBlock ? block.text : ''
}

/** `[role, text-or-marker]` per message, for asserting durable history shape. */
function historyShape(agent: Agent): string[] {
  return agent.messages.map((message) => {
    const parts = message.content.map((block) => {
      if (block instanceof TextBlock) return block.text
      if (block instanceof ToolResultBlock) return '<toolResult>'
      return `<${block.type}>`
    })
    return `${message.role}: ${parts.join(' | ')}`
  })
}

describe("concurrentInvocationMode 'stopPrevious'", () => {
  it('lets the in-flight tool finish, stops the running invocation as superseded, then runs the new call', async () => {
    const gate = createGate()
    const model = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
      .addTurn({ type: 'textBlock', text: 'B' })
    const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'stopPrevious' })
    let before = 0
    let after = 0
    agent.addHook(BeforeInvocationEvent, () => void before++)
    agent.addHook(AfterInvocationEvent, () => void after++)

    const first = agent.invoke('a')
    await gate.started
    const second = agent.invoke('b')
    await until(() => agent.pendingInvocations.length === 1, 'second queued')

    // The running invocation is not cancelled: its tool keeps running until released.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(gate.wasAborted()).toBe(false)
    expect(model.callCount).toBe(1)

    gate.release()
    const firstResult = await first
    expect(firstResult.stopReason).toBe('superseded')
    expect(resultText(firstResult)).toBe('Superseded by a new request')

    const secondResult = await second
    expect(secondResult.stopReason).toBe('endTurn')
    expect(resultText(secondResult)).toBe('B')
    expect(model.callCount).toBe(2)
    // Two full invocations, each with its own hook pair.
    expect(before).toBe(2)
    expect(after).toBe(2)

    // The tool result landed and the open user turn was closed before the new input.
    expect(historyShape(agent)).toEqual([
      'user: a',
      'assistant: <toolUseBlock>',
      'user: <toolResult>',
      'assistant: Superseded by a new request',
      'user: b',
      'assistant: B',
    ])
  })

  it('works as a per-call ifBusy override on a throw-mode agent', async () => {
    const gate = createGate()
    const model = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
      .addTurn({ type: 'textBlock', text: 'B' })
    const agent = new Agent({ model, tools: [gate.tool], printer: false })

    const first = agent.invoke('a')
    await gate.started
    const second = agent.invoke('b', { ifBusy: 'stopPrevious' })
    gate.release()

    expect((await first).stopReason).toBe('superseded')
    expect(resultText(await second)).toBe('B')
  })

  it('a stop requested in the handoff window applies to the successor, not the finished predecessor', async () => {
    const gate = createGate()
    const model = new MockMessageModel()
      .addTurn({ type: 'textBlock', text: 'A' })
      .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
      .addTurn({ type: 'textBlock', text: 'C' })
      .addTurn({ type: 'textBlock', text: 'B' })
    const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'stopPrevious' })

    let third: Promise<unknown> | undefined
    agent.addHook(AfterInvocationEvent, () => {
      // Fires while the first invocation still holds the turn with 'b' queued behind it.
      third ??= agent.invoke('c')
    })

    const first = agent.invoke('a')
    const second = agent.invoke('b', { ifBusy: 'queue' })
    expect((await first).stopReason).toBe('endTurn')
    // 'c' displaced nothing ('b' is a plain queue entry) and went to the front, so it
    // runs before 'b'; the stop request it carried was cleared with the handoff.
    gate.release()
    const thirdResult = (await third) as { stopReason: string }
    expect(thirdResult.stopReason).toBe('endTurn')
    expect(gate.wasAborted()).toBe(false)
    expect((await second).stopReason).toBe('endTurn')
    expect(model.callCount).toBe(4)
  })

  it('latest wins under rapid overlap: queued stopPrevious predecessors are displaced', async () => {
    const gate = createGate()
    const model = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
      .addTurn({ type: 'textBlock', text: 'D' })
    const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'stopPrevious' })

    const first = agent.invoke('a')
    await gate.started
    const second = agent.invoke('b')
    const third = agent.invoke('c')
    const fourth = agent.invoke('d')
    gate.release()

    expect((await first).stopReason).toBe('superseded')
    await expect(second).rejects.toThrow(PendingInvocationCancelledError)
    await expect(third).rejects.toThrow(PendingInvocationCancelledError)
    expect(resultText(await fourth)).toBe('D')
    expect(model.callCount).toBe(2)
  })

  it('a later cancelPrevious displaces a queued stopPrevious and hard-cancels the running invocation', async () => {
    const gate = createGate()
    const model = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
      .addTurn({ type: 'textBlock', text: 'C' })
    const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'stopPrevious' })

    const first = agent.invoke('a')
    await gate.started
    const second = agent.invoke('b')
    const third = agent.invoke('c', { ifBusy: 'cancelPrevious' })

    expect((await first).stopReason).toBe('cancelled')
    expect(gate.wasAborted()).toBe(true)
    await expect(second).rejects.toThrow(PendingInvocationCancelledError)
    expect(resultText(await third)).toBe('C')
  })

  it('does not stop the running invocation when the stopping caller already gave up', async () => {
    const gate = createGate()
    const model = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
      .addTurn({ type: 'textBlock', text: 'A' })
    const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'stopPrevious' })

    const first = agent.invoke('a')
    await gate.started
    const controller = new AbortController()
    controller.abort()
    const second = agent.invoke('b', { cancelSignal: controller.signal })
    await expect(second).rejects.toThrow(PendingInvocationCancelledError)

    gate.release()
    const firstResult = await first
    expect(firstResult.stopReason).toBe('endTurn')
    expect(resultText(firstResult)).toBe('A')
  })

  it('a stop arriving during AfterInvocation returns the completed result instead of running a continuation pass', async () => {
    const model = new MockMessageModel()
      .addTurn({ type: 'textBlock', text: 'A' })
      .addTurn({ type: 'textBlock', text: 'B' })
    const agent = new Agent({ model, printer: false, concurrentInvocationMode: 'stopPrevious' })

    let second: Promise<unknown> | undefined
    let abandoned = 0
    agent.addHook(AfterInvocationEvent, (event) => {
      if (second) return
      continuations.addInput(event, { args: 'continue please', onAbandoned: () => void abandoned++ })
      second = agent.invoke('b')
    })

    const firstResult = await agent.invoke('a')
    expect(firstResult.stopReason).toBe('endTurn')
    expect(resultText(firstResult)).toBe('A')
    expect(abandoned).toBe(1)
    expect(resultText((await second) as { lastMessage: { content: readonly unknown[] } })).toBe('B')
    expect(model.callCount).toBe(2)
  })

  it('a stopping caller that withdraws after queueing takes its stop request with it', async () => {
    const gate = createGate()
    const model = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
      .addTurn({ type: 'textBlock', text: 'A' })
    const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'stopPrevious' })

    const first = agent.invoke('a')
    await gate.started
    const controller = new AbortController()
    const second = agent.invoke('b', { cancelSignal: controller.signal })
    await until(() => agent.pendingInvocations.length === 1, 'second queued')
    controller.abort()
    await expect(second).rejects.toThrow(PendingInvocationCancelledError)

    gate.release()
    const firstResult = await first
    expect(firstResult.stopReason).toBe('endTurn')
    expect(resultText(firstResult)).toBe('A')
    expect(model.callCount).toBe(2)
  })

  it('a hook that sets resume while a stop is pending gets the completed result back, not a resumed pass', async () => {
    const model = new MockMessageModel()
      .addTurn({ type: 'textBlock', text: 'A' })
      .addTurn({ type: 'textBlock', text: 'B' })
    const agent = new Agent({ model, printer: false, concurrentInvocationMode: 'stopPrevious' })

    let second: Promise<unknown> | undefined
    let afterPasses = 0
    agent.addHook(AfterInvocationEvent, (event) => {
      afterPasses++
      second ??= agent.invoke('b')
      // Mirrors a plugin that resumes while its condition holds — here, while a caller waits.
      if (agent.pendingInvocations.length > 0) event.resume = []
    })

    const firstResult = await agent.invoke('a')
    // The pass completed before the stop arrived, so its real result is returned; the resume
    // is not started, and the waiting caller takes the turn.
    expect(firstResult.stopReason).toBe('endTurn')
    expect(resultText(firstResult)).toBe('A')
    expect(afterPasses).toBe(1)
    expect(model.callCount).toBe(1)
    expect(resultText((await second) as { lastMessage: { content: readonly unknown[] } })).toBe('B')
    expect(historyShape(agent)).toEqual(['user: a', 'assistant: A', 'user: b', 'assistant: B'])
  })

  it('lets an in-flight model call finish before stopping', async () => {
    let releaseModel!: () => void
    const modelReleased = new Promise<void>((resolve) => (releaseModel = resolve))
    let signalModelStarted!: () => void
    const modelStarted = new Promise<void>((resolve) => (signalModelStarted = resolve))
    class GatedModel extends MockMessageModel {
      override async *stream(messages: Message[], options?: StreamOptions): AsyncGenerator<ModelStreamEvent> {
        if (this.callCount === 0) {
          signalModelStarted()
          await modelReleased
        }
        yield* super.stream(messages, options)
      }
    }
    const fast = tool({ name: 'fast', description: 'Returns immediately', callback: () => 'ok' })
    const model = new GatedModel()
      .addTurn({ type: 'toolUseBlock', name: 'fast', toolUseId: 't1', input: {} })
      .addTurn({ type: 'textBlock', text: 'B' })
    const agent = new Agent({ model, tools: [fast], printer: false, concurrentInvocationMode: 'stopPrevious' })

    const first = agent.invoke('a')
    await modelStarted
    const second = agent.invoke('b')
    await until(() => agent.pendingInvocations.length === 1, 'second queued')
    releaseModel()

    expect((await first).stopReason).toBe('superseded')
    expect(resultText(await second)).toBe('B')
    // The gated model call completed and its tool ran before the stop was observed.
    expect(historyShape(agent)).toEqual([
      'user: a',
      'assistant: <toolUseBlock>',
      'user: <toolResult>',
      'assistant: Superseded by a new request',
      'user: b',
      'assistant: B',
    ])
  })

  it('a superseded stream() consumer sees the synthetic message, AfterInvocation, and AgentResult events', async () => {
    const gate = createGate()
    const model = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
      .addTurn({ type: 'textBlock', text: 'B' })
    const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'stopPrevious' })

    const events: unknown[] = []
    const consume = (async () => {
      const iterator = agent.stream('a')
      let step = await iterator.next()
      while (!step.done) {
        events.push(step.value)
        step = await iterator.next()
      }
      return step.value
    })()
    await gate.started
    const second = agent.invoke('b')
    gate.release()

    const firstResult = await consume
    expect(firstResult.stopReason).toBe('superseded')
    const supersededMessage = events.find(
      (event) =>
        event instanceof MessageAddedEvent &&
        resultText({ lastMessage: event.message }) === 'Superseded by a new request'
    )
    expect(supersededMessage).toBeDefined()
    expect(events.some((event) => event instanceof AfterInvocationEvent)).toBe(true)
    expect(events.some((event) => event instanceof AgentResultEvent)).toBe(true)
    expect(resultText(await second)).toBe('B')
  })

  it('lets an interrupt resume run its pending tool before stopping, so the interrupt is not left pending', async () => {
    const model = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'confirm', toolUseId: 't1', input: {} })
      .addTurn({ type: 'textBlock', text: 'B' })
    const confirm = tool({
      name: 'confirm',
      description: 'Asks for confirmation',
      callback: (_input, context) => `got ${String(context!.interrupt({ name: 'confirm', reason: 'ok?' }))}`,
    })
    const agent = new Agent({ model, tools: [confirm], printer: false, concurrentInvocationMode: 'stopPrevious' })

    const interrupted = await agent.invoke('a')
    expect(interrupted.stopReason).toBe('interrupt')

    // The stop lands before the resume's first loop pass, i.e. before the pending tool runs.
    let second: Promise<unknown> | undefined
    agent.addHook(BeforeInvocationEvent, () => {
      second ??= agent.invoke('b')
    })
    const resumed = await agent.invoke([
      new InterruptResponseContent({ interruptId: interrupted.interrupts![0]!.id, response: 'yes' }),
    ])

    expect(resumed.stopReason).toBe('superseded')
    expect(agent._interruptState.activated).toBe(false)
    expect(resultText((await second) as { lastMessage: { content: readonly unknown[] } })).toBe('B')
    expect(historyShape(agent)).toEqual([
      'user: a',
      'assistant: <toolUseBlock>',
      'user: <toolResult>',
      'assistant: Superseded by a new request',
      'user: b',
      'assistant: B',
    ])
  })

  it('a stopPrevious caller parked behind an interrupt runs after the resume, which stops once its pending tool ran', async () => {
    const model = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'confirm', toolUseId: 't1', input: {} })
      .addTurn({ type: 'textBlock', text: 'B' })
    const confirm = tool({
      name: 'confirm',
      description: 'Asks for confirmation',
      callback: (_input, context) => `got ${String(context!.interrupt({ name: 'confirm', reason: 'ok?' }))}`,
    })
    const agent = new Agent({ model, tools: [confirm], printer: false, concurrentInvocationMode: 'stopPrevious' })

    const interrupted = await agent.invoke('a')
    expect(interrupted.stopReason).toBe('interrupt')
    const second = agent.invoke('b')
    await until(() => agent.pendingInvocations.length === 1, 'second parked')
    // The parked caller is not handed the turn while the interrupt awaits its answer.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(agent.isInvoking).toBe(false)

    const resumed = await agent.invoke([
      new InterruptResponseContent({ interruptId: interrupted.interrupts![0]!.id, response: 'yes' }),
    ])

    expect(resumed.stopReason).toBe('superseded')
    expect(resultText(await second)).toBe('B')
    expect(historyShape(agent)).toEqual([
      'user: a',
      'assistant: <toolUseBlock>',
      'user: <toolResult>',
      'assistant: Superseded by a new request',
      'user: b',
      'assistant: B',
    ])
  })

  it('a queued interrupt response is not a latest-wins caller: it neither displaces nor stops the newer user message', async () => {
    const gate = createGate()
    const confirm = tool({
      name: 'confirm',
      description: 'Asks for confirmation',
      callback: (_input, context) => `got ${String(context!.interrupt({ name: 'confirm', reason: 'ok?' }))}`,
    })
    const model = new MockMessageModel()
      .addTurn([
        { type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} },
        { type: 'toolUseBlock', name: 'confirm', toolUseId: 't2', input: {} },
      ])
      .addTurn({ type: 'textBlock', text: 'B' })
    const agent = new Agent({
      model,
      tools: [gate.tool, confirm],
      printer: false,
      concurrentInvocationMode: 'stopPrevious',
    })
    // The host auto-approves from the InterruptEvent, i.e. while A still holds the turn and
    // after the user's 'b' is already queued.
    let answer: Promise<unknown> | undefined
    agent.addHook(InterruptEvent, (event) => {
      answer ??= agent.invoke([new InterruptResponseContent({ interruptId: event.interrupt.id, response: 'yes' })])
    })

    const first = agent.invoke('a')
    await gate.started
    const second = agent.invoke('b')
    await until(() => agent.pendingInvocations.length === 1, 'b queued')
    gate.release()

    expect((await first).stopReason).toBe('interrupt')
    // The resume was handed the turn at once; 'b' is still waiting, not displaced.
    expect(agent.pendingInvocations.map((pending) => pending.mode)).toEqual(['stopPrevious'])
    // The resume runs first (it is the only call that may run while the interrupt is open),
    // settles the interrupt by running the pending tool batch, then yields to the newer 'b'
    // instead of evicting it — without a model call of its own.
    const resumed = (await answer) as { stopReason: string; lastMessage: { content: readonly unknown[] } }
    expect(resumed.stopReason).toBe('superseded')
    expect(resultText(await second)).toBe('B')
    expect(model.callCount).toBe(2)
    expect(historyShape(agent).slice(-2)).toEqual(['user: b', 'assistant: B'])
    expect(historyShape(agent)).toContain('user: <toolResult> | <toolResult>')
  })

  it('abandoning an interrupt via loadSnapshot releases the parked callers', async () => {
    const model = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'confirm', toolUseId: 't1', input: {} })
      .addTurn({ type: 'textBlock', text: 'B' })
    const confirm = tool({
      name: 'confirm',
      description: 'Asks for confirmation',
      callback: (_input, context) => `got ${String(context!.interrupt({ name: 'confirm', reason: 'ok?' }))}`,
    })
    const agent = new Agent({ model, tools: [confirm], printer: false, concurrentInvocationMode: 'queue' })

    const clean = agent.takeSnapshot({ preset: 'session' })
    await agent.invoke('a')
    const second = agent.invoke('b')
    await until(() => agent.pendingInvocations.length === 1, 'second parked')

    agent.loadSnapshot(clean)

    expect(resultText(await second)).toBe('B')
    expect(historyShape(agent)).toEqual(['user: b', 'assistant: B'])
  })
})

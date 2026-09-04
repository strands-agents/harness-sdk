import { describe, expect, it } from 'vitest'
import { Agent } from '../agent.js'
import { AfterInvocationEvent, BeforeInvocationEvent } from '../../hooks/index.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { tool } from '../../tools/tool-factory.js'
import { ConcurrentInvocationError, PendingInvocationCancelledError } from '../../errors.js'
import { TextBlock } from '../../types/messages.js'

/**
 * A tool whose callback suspends until `release()` is called, so tests can hold an
 * invocation open deterministically. `started` resolves once the agent is inside the
 * callback (the invocation is committed and holds the lock). The callback also
 * resolves on `cancelSignal` abort so `agent.cancel()` can end the invocation.
 */
function createGate(name = 'gate') {
  let signalStarted!: () => void
  const started = new Promise<void>((resolve) => (signalStarted = resolve))
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))

  const gateTool = tool({
    name,
    description: `Gated tool ${name}`,
    callback: async (_input, context) => {
      signalStarted()
      await new Promise<void>((resolve) => {
        void released.then(resolve)
        context?.cancelSignal.addEventListener('abort', () => resolve(), { once: true })
      })
      return 'gate done'
    },
  })

  return { tool: gateTool, started, release }
}

/** Waits for a same-loop condition with a bounded number of macrotask hops. */
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 2000 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  if (!condition()) throw new Error(`timed out waiting for: ${label}`)
}

/** The text of a result's last message. */
function resultText(result: { lastMessage: { content: readonly unknown[] } }): string {
  const block = result.lastMessage.content[0]
  return block instanceof TextBlock ? block.text : ''
}

describe('concurrentInvocationMode', () => {
  describe('configuration', () => {
    it('rejects an unsupported mode string', () => {
      expect(() => new Agent({ concurrentInvocationMode: 'reject' as never })).toThrow(
        /Unsupported concurrentInvocationMode/
      )
    })

    it('rejects the deleted object form', () => {
      expect(() => new Agent({ concurrentInvocationMode: { mode: 'enqueue' } as never })).toThrow(
        /Unsupported concurrentInvocationMode/
      )
    })

    it('rejects an unsupported per-call ifBusy value instead of silently queueing', async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'A' })
      const agent = new Agent({ model, tools: [gate.tool], printer: false })

      const first = agent.invoke('a')
      await gate.started
      // A typo'd ifBusy must fail loudly, not silently override 'throw' with enqueue semantics.
      await expect(agent.invoke('b', { ifBusy: 'enque' as never })).rejects.toThrow(/Unsupported ifBusy/)
      expect(agent.pendingInvocations).toHaveLength(0)

      gate.release()
      await first
    })

    it('rejects an unsupported ifBusy value even when the agent is idle (fail fast)', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'A' })
      const agent = new Agent({ model, printer: false })
      await expect(agent.invoke('a', { ifBusy: 'reject' as never })).rejects.toThrow(/Unsupported ifBusy/)
    })

    it('exposes the resolved mode and defaults to throw', () => {
      expect(new Agent({ model: new MockMessageModel() }).concurrentInvocationMode).toBe('throw')
      expect(
        new Agent({ model: new MockMessageModel(), concurrentInvocationMode: 'enqueue' }).concurrentInvocationMode
      ).toBe('enqueue')
      expect(
        new Agent({ model: new MockMessageModel(), concurrentInvocationMode: 'cancelPrevious' })
          .concurrentInvocationMode
      ).toBe('cancelPrevious')
    })
  })

  describe("'cancelPrevious' as the agent-level mode", () => {
    it('a plain concurrent invoke cancels the running invocation and runs next', async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'B' })
      const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'cancelPrevious' })

      const first = agent.invoke('a')
      await gate.started
      const second = agent.invoke('b') // no per-call ifBusy: the agent mode applies

      expect((await first).stopReason).toBe('cancelled')
      const resultB = await second
      expect(resultB.stopReason).toBe('endTurn')
      expect(resultText(resultB)).toBe('B')
    })

    it("per-call ifBusy: 'enqueue' opts a single call back into waiting", async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'A' })
        .addTurn({ type: 'textBlock', text: 'B' })
      const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'cancelPrevious' })

      const first = agent.invoke('a')
      await gate.started
      const second = agent.invoke('b', { ifBusy: 'enqueue' })
      await until(() => agent.pendingInvocations.length === 1, 'b queued')

      gate.release()
      // The first invocation was NOT cancelled; both run to completion in order.
      expect((await first).stopReason).toBe('endTurn')
      expect(resultText(await second)).toBe('B')
    })

    it('latest wins under rapid overlap: intermediates are displaced, only the newest runs', async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'D' })
      const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'cancelPrevious' })

      const first = agent.invoke('a')
      await gate.started
      const second = agent.invoke('b')
      const third = agent.invoke('c')
      const fourth = agent.invoke('d')

      expect((await first).stopReason).toBe('cancelled')
      await expect(second).rejects.toThrow(PendingInvocationCancelledError)
      await expect(third).rejects.toThrow(PendingInvocationCancelledError)
      const resultD = await fourth
      expect(resultD.stopReason).toBe('endTurn')
      expect(resultText(resultD)).toBe('D')
      // Exactly two invocations ran model passes: the cancelled first and the newest.
      expect(agent.pendingInvocations).toHaveLength(0)
    })

    it("displacement spares callers queued with ifBusy: 'enqueue'", async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'C' })
        .addTurn({ type: 'textBlock', text: 'B' })
      const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'cancelPrevious' })

      const first = agent.invoke('a')
      await gate.started
      const waiter = agent.invoke('b', { ifBusy: 'enqueue' })
      await until(() => agent.pendingInvocations.length === 1, 'b queued')
      const urgent = agent.invoke('c')

      expect((await first).stopReason).toBe('cancelled')
      expect(resultText(await urgent)).toBe('C')
      expect(resultText(await waiter)).toBe('B')
    })
  })

  describe("'throw' (default) behavior", () => {
    it('still rejects a concurrent call with ConcurrentInvocationError', async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'A' })
      const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'throw' })

      const first = agent.invoke('a')
      await gate.started
      await expect(agent.invoke('b')).rejects.toThrow(ConcurrentInvocationError)

      gate.release()
      await first
    })

    it("per-call ifBusy: 'enqueue' queues on a 'throw'-mode agent", async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'A' })
        .addTurn({ type: 'textBlock', text: 'B' })
      const agent = new Agent({ model, tools: [gate.tool], printer: false })

      const first = agent.invoke('a')
      await gate.started
      const second = agent.invoke('b', { ifBusy: 'enqueue' })
      await until(() => agent.pendingInvocations.length === 1, 'b to enter the queue')

      gate.release()
      expect(resultText(await first)).toBe('A')
      expect(resultText(await second)).toBe('B')
    })
  })

  describe("'enqueue' behavior", () => {
    it('runs a second call after the first, each with its own result', async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'A' })
        .addTurn({ type: 'textBlock', text: 'B' })
      const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'enqueue' })

      const first = agent.invoke('review the PR')
      await gate.started
      const second = agent.invoke('also check the docs')
      await until(() => agent.pendingInvocations.length === 1, 'second call to enter the queue')

      gate.release()
      const [resultA, resultB] = await Promise.all([first, second])
      expect(resultA.stopReason).toBe('endTurn')
      expect(resultB.stopReason).toBe('endTurn')
      expect(resultText(resultA)).toBe('A')
      expect(resultText(resultB)).toBe('B')
      expect(agent.pendingInvocations).toHaveLength(0)
      expect(agent.isInvoking).toBe(false)
    })

    it('serves queued calls FIFO', async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'A' })
        .addTurn({ type: 'textBlock', text: 'B' })
        .addTurn({ type: 'textBlock', text: 'C' })
      const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'enqueue' })

      const first = agent.invoke('a')
      await gate.started
      const second = agent.invoke('b')
      await until(() => agent.pendingInvocations.length === 1, 'b queued')
      const third = agent.invoke('c')
      await until(() => agent.pendingInvocations.length === 2, 'c queued')

      gate.release()
      expect(resultText(await second)).toBe('B')
      expect(resultText(await third)).toBe('C')
      expect(resultText(await first)).toBe('A')
    })

    it('surfaces queued calls on pendingInvocations with id and preview', async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'A' })
        .addTurn({ type: 'textBlock', text: 'B' })
      const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'enqueue' })

      const first = agent.invoke('a')
      await gate.started
      const second = agent.invoke('stop — wrong repo')
      await until(() => agent.pendingInvocations.length === 1, 'queue entry visible')

      const [pending] = agent.pendingInvocations
      expect(pending).toMatchObject({ preview: 'stop — wrong repo' })
      expect(pending!.id).toMatch(/^pending-/)
      expect(pending!.submittedAt).toBeInstanceOf(Date)

      gate.release()
      await Promise.all([first, second])
    })

    it('fires a full BeforeInvocation/AfterInvocation pair per queued call', async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'A' })
        .addTurn({ type: 'textBlock', text: 'B' })
      const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'enqueue' })
      // Record the ordered event sequence keyed by invocation identity.
      const invocations: object[] = []
      const sequence: string[] = []
      const invocationIndex = (state: object): number => {
        let index = invocations.indexOf(state)
        if (index === -1) index = invocations.push(state) - 1
        return index
      }
      agent.addHook(BeforeInvocationEvent, (event) => {
        sequence.push(`before:${invocationIndex(event.invocationState)}`)
      })
      agent.addHook(AfterInvocationEvent, (event) => {
        sequence.push(`after:${invocationIndex(event.invocationState)}`)
      })

      const first = agent.invoke('a')
      await gate.started
      const second = agent.invoke('b')
      await until(() => agent.pendingInvocations.length === 1, 'b queued')

      gate.release()
      await Promise.all([first, second])
      expect(sequence).toEqual(['before:0', 'after:0', 'before:1', 'after:1'])
    })

    it('keeps isInvoking true across the turn handoff (no observable idle window)', async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'A' })
        .addTurn({ type: 'textBlock', text: 'B' })
      const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'enqueue' })

      const first = agent.invoke('a')
      await gate.started
      const second = agent.invoke('b')
      await until(() => agent.pendingInvocations.length === 1, 'b queued')

      gate.release()
      await first
      // The turn was handed to b, not dropped: right after a resolves, the agent is
      // still busy (b owns the turn even though its loop may not have started yet).
      expect(agent.isInvoking).toBe(true)
      expect(resultText(await second)).toBe('B')
      expect(agent.isInvoking).toBe(false)
    })

    it("per-call ifBusy: 'throw' opts back into fail-fast on an 'enqueue' agent", async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'A' })
      const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'enqueue' })

      const first = agent.invoke('a')
      await gate.started
      await expect(agent.invoke('b', { ifBusy: 'throw' })).rejects.toThrow(ConcurrentInvocationError)

      gate.release()
      await first
    })

    it('cancelPending removes a queued call without disturbing the others', async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'A' })
        .addTurn({ type: 'textBlock', text: 'C' })
      const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'enqueue' })

      const first = agent.invoke('a')
      await gate.started
      const second = agent.invoke('b')
      await until(() => agent.pendingInvocations.length === 1, 'b queued')
      const third = agent.invoke('c')
      await until(() => agent.pendingInvocations.length === 2, 'c queued')

      const bId = agent.pendingInvocations[0]!.id
      expect(agent.cancelPending(bId)).toBe(true)
      await expect(second).rejects.toThrow(PendingInvocationCancelledError)
      expect(agent.pendingInvocations).toHaveLength(1)
      expect(agent.cancelPending('pending-99')).toBe(false)

      gate.release()
      expect(resultText(await first)).toBe('A')
      expect(resultText(await third)).toBe('C')
    })

    it("a queued caller's cancelSignal abort removes it from the queue", async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'A' })
      const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'enqueue' })

      const first = agent.invoke('a')
      await gate.started
      const controller = new AbortController()
      const second = agent.invoke('b', { cancelSignal: controller.signal })
      await until(() => agent.pendingInvocations.length === 1, 'b queued')

      controller.abort()
      await expect(second).rejects.toThrow(PendingInvocationCancelledError)
      expect(agent.pendingInvocations).toHaveLength(0)

      gate.release()
      expect((await first).stopReason).toBe('endTurn')
    })

    it('hands the lock to the next queued call when an invocation errors', async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn(new Error('model exploded'))
        .addTurn({ type: 'textBlock', text: 'B' })
      const agent = new Agent({
        model,
        tools: [gate.tool],
        printer: false,
        retryStrategy: null,
        concurrentInvocationMode: 'enqueue',
      })

      const first = agent.invoke('a')
      await gate.started
      const second = agent.invoke('b')
      await until(() => agent.pendingInvocations.length === 1, 'b queued')

      gate.release()
      await expect(first).rejects.toThrow('model exploded')
      expect(resultText(await second)).toBe('B')
    })

    it('hands the lock to the next queued call when the consumer abandons the stream', async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'A' })
        .addTurn({ type: 'textBlock', text: 'B' })
      const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'enqueue' })

      const stream = agent.stream('a')
      // Drive the stream until the gate tool is executing; the in-flight next() then
      // stays suspended on the blocked tool.
      let gateOpened = false
      void gate.started.then(() => {
        gateOpened = true
      })
      while (!gateOpened) {
        await Promise.race([stream.next(), gate.started])
      }
      const second = agent.invoke('b')
      await until(() => agent.pendingInvocations.length === 1, 'b queued')

      // Abandon the stream; the queued return() completes once the tool unblocks.
      const abandoned = stream.return(undefined as never)
      gate.release()
      await abandoned

      expect(resultText(await second)).toBe('B')
    })

    it('does not enqueue an unconsumed stream (lazy generator)', async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'A' })
      const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'enqueue' })

      const first = agent.invoke('a')
      await gate.started
      void agent.stream('never consumed')
      await until(() => true, 'noop')
      expect(agent.pendingInvocations).toHaveLength(0)

      gate.release()
      await first
    })

    it('runs a call submitted at the last hook of the finishing invocation (no drain race)', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'A' })
        .addTurn({ type: 'textBlock', text: 'LATE' })
      const agent = new Agent({ model, printer: false, concurrentInvocationMode: 'enqueue' })

      let late: Promise<{ lastMessage: { content: readonly unknown[] } }> | undefined
      agent.addHook(AfterInvocationEvent, () => {
        late ??= agent.invoke('submitted at the boundary')
      })

      await agent.invoke('a')
      expect(late).toBeDefined()
      expect(resultText(await late!)).toBe('LATE')
    })

    it('cancel() ends only the running invocation; queued calls still run with a fresh signal', async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'B' })
      const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'enqueue' })

      const first = agent.invoke('a')
      await gate.started
      const second = agent.invoke('b')
      await until(() => agent.pendingInvocations.length === 1, 'b queued')

      agent.cancel()
      const resultA = await first
      expect(resultA.stopReason).toBe('cancelled')

      const resultB = await second
      expect(resultB.stopReason).toBe('endTurn')
      expect(resultText(resultB)).toBe('B')
    })
  })

  describe("ifBusy: 'cancelPrevious'", () => {
    it('cancels the running invocation and runs the new call as a fresh invocation', async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'C' })
      const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'enqueue' })

      const first = agent.invoke('a')
      await gate.started
      const interrupter = agent.invoke('supersede', { ifBusy: 'cancelPrevious' })

      const resultA = await first
      expect(resultA.stopReason).toBe('cancelled')

      const resultC = await interrupter
      expect(resultC.stopReason).toBe('endTurn')
      expect(resultText(resultC)).toBe('C')
    })

    it('jumps ahead of already-queued invocations', async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'C' })
        .addTurn({ type: 'textBlock', text: 'B' })
      const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'enqueue' })

      const first = agent.invoke('a')
      await gate.started
      const second = agent.invoke('b')
      await until(() => agent.pendingInvocations.length === 1, 'b queued')
      const interrupter = agent.invoke('c', { ifBusy: 'cancelPrevious' })
      await until(() => agent.pendingInvocations.length === 2, 'c queued at front')

      expect(agent.pendingInvocations[0]!.preview).toBe('c')

      expect((await first).stopReason).toBe('cancelled')
      expect(resultText(await interrupter)).toBe('C')
      expect(resultText(await second)).toBe('B')
    })

    it('runs immediately when the agent is idle', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'solo' })
      const agent = new Agent({ model, printer: false })

      const result = await agent.invoke('a', { ifBusy: 'cancelPrevious' })
      expect(result.stopReason).toBe('endTurn')
      expect(resultText(result)).toBe('solo')
    })

    it('interrupts the successor when submitted in the handoff window (predecessor just resolved)', async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'A' })
        .addTurn({ type: 'textBlock', text: 'C' })
      const agent = new Agent({ model, tools: [gate.tool], printer: false, concurrentInvocationMode: 'enqueue' })

      const first = agent.invoke('a')
      await gate.started
      const second = agent.invoke('b')
      await until(() => agent.pendingInvocations.length === 1, 'b queued')
      gate.release()

      // Submitting from the predecessor's .then() lands in the handoff window: b owns
      // the turn but its loop has not started, so the abort must target b's controller.
      const third = first.then(() => agent.invoke('c', { ifBusy: 'cancelPrevious' }))

      const secondResult = await second
      expect(secondResult.stopReason).toBe('cancelled')
      const thirdResult = await third
      expect(thirdResult.stopReason).toBe('endTurn')
      expect(resultText(thirdResult)).toBe('C')
    })

    it('does not cancel the running invocation when the interrupting caller already gave up', async () => {
      const gate = createGate()
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'gate', toolUseId: 't1', input: {} })
        .addTurn({ type: 'textBlock', text: 'A' })
      const agent = new Agent({ model, tools: [gate.tool], printer: false })

      const first = agent.invoke('a')
      await gate.started

      // A pre-aborted caller never enters the queue and must not cancel the running invocation.
      const controller = new AbortController()
      controller.abort()
      await expect(agent.invoke('x', { ifBusy: 'cancelPrevious', cancelSignal: controller.signal })).rejects.toThrow(
        PendingInvocationCancelledError
      )

      gate.release()
      const firstResult = await first
      expect(firstResult.stopReason).toBe('endTurn')
      expect(resultText(firstResult)).toBe('A')
    })
  })
})

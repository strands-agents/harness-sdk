import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { AfterInvocationEvent } from '../../hooks/events.js'
import { ExecuteToolStage } from '../../middleware/index.js'
import { tool } from '../../tools/tool-factory.js'
import { InterruptResponseContent } from '../../types/interrupt.js'
import { TextBlock, ToolUseBlock } from '../../types/messages.js'
import { Agent } from '../agent.js'

import type { BackgroundTask } from '../../background-tasks/types.js'

const BACKGROUND_TASKS_STATE_KEY = 'strands.backgroundTasks'

/**
 * A tool whose callback suspends until `release()` is called. `started` resolves once
 * the callback is entered. The callback also resolves on `cancelSignal` abort so
 * cancellation can end it.
 */
function createGate(name: string) {
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

/** Index of the first message whose content matches the predicate, or -1. */
function messageIndex(agent: Agent, predicate: (content: readonly unknown[]) => boolean): number {
  return agent.messages.findIndex((message) => predicate(message.content))
}

function hasText(content: readonly unknown[], text: string): boolean {
  return content.some((block) => block instanceof TextBlock && block.text === text)
}

function hasBackgroundDelivery(content: readonly unknown[]): boolean {
  return content.some(
    (block) =>
      typeof block === 'object' &&
      block !== null &&
      'name' in block &&
      (block as { name?: string }).name === 'strands_background_task_result'
  )
}

function persistedTasks(agent: Agent): BackgroundTask[] | undefined {
  return agent.appState.get(BACKGROUND_TASKS_STATE_KEY) as unknown as BackgroundTask[] | undefined
}

/** The input of the first delivered background-task synthetic tool use, if any. */
function deliveryInput(agent: Agent): Record<string, unknown> | undefined {
  for (const message of agent.messages) {
    for (const block of message.content) {
      if (block instanceof ToolUseBlock && block.name === 'strands_background_task_result') {
        return block.input as Record<string, unknown>
      }
    }
  }
  return undefined
}

describe('concurrentInvocationMode enqueue × backgroundTasks', () => {
  it('hands the turn to a queued caller instead of waiting for background-task settlement', async () => {
    const work = createGate('work')
    const model = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'work', toolUseId: 'work-use', input: {} })
      .addTurn({ type: 'textBlock', text: 'first done' })
      .addTurn({ type: 'textBlock', text: 'second done' })
      .addTurn({ type: 'textBlock', text: 'delivered' })
    const agent = new Agent({
      model,
      tools: [work.tool],
      backgroundTasks: { always: [work.tool] },
      concurrentInvocationMode: 'enqueue',
      printer: false,
    })

    const first = agent.invoke('first')
    await work.started
    // Queue the second caller while the first invocation is still running.
    const second = agent.invoke('second')
    await until(() => agent.pendingInvocations.length === 1, 'second invocation queued')

    // The first invocation resolves WITHOUT the task settling: with a caller queued,
    // AfterInvocation skips both the settlement wait and the delivery continuation.
    const firstResult = await first
    expect(resultText(firstResult)).toBe('first done')

    // The queued invocation's model pass runs while the task is still working.
    await until(() => model.callCount === 3, 'queued invocation model pass')
    expect(persistedTasks(agent)?.map((task) => task.status)).toEqual(['working'])

    // The queued invocation IS the last message: its AfterInvocation waits for
    // settlement and absorbs the delivery continuation.
    work.release()
    const secondResult = await second
    expect(resultText(secondResult)).toBe('delivered')
    expect(agent.pendingInvocations).toHaveLength(0)

    // Durable history: the queued caller's input precedes the delivery.
    const deliveryIndex = messageIndex(agent, hasBackgroundDelivery)
    const secondInputIndex = messageIndex(agent, (content) => hasText(content, 'second'))
    expect(deliveryIndex).toBeGreaterThan(secondInputIndex)
    // The task is fully consumed — nothing left to re-deliver.
    expect(persistedTasks(agent)).toBeUndefined()
  })

  it('ends an in-progress settlement wait as soon as a caller enqueues', async () => {
    const work = createGate('work')
    const model = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'work', toolUseId: 'work-use', input: {} })
      .addTurn({ type: 'textBlock', text: 'first done' })
      .addTurn({ type: 'textBlock', text: 'second done' })
      .addTurn({ type: 'textBlock', text: 'delivered' })
    const agent = new Agent({
      model,
      tools: [work.tool],
      backgroundTasks: { always: [work.tool] },
      concurrentInvocationMode: 'enqueue',
      printer: false,
    })

    const first = agent.invoke('first')
    await work.started
    // The first invocation is past its final model turn and blocked in
    // AfterInvocation awaiting background-task settlement, still holding the turn.
    await until(() => agent.messages.some((message) => hasText(message.content, 'first done')), 'first final turn')
    expect(model.callCount).toBe(2)

    // Enqueueing a caller breaks the wait: the first invocation resolves without
    // the task ever settling (this would time out if the wait held the turn).
    const second = agent.invoke('second')
    const firstResult = await first
    expect(resultText(firstResult)).toBe('first done')
    expect(persistedTasks(agent)?.map((task) => task.status)).toEqual(['working'])

    work.release()
    const secondResult = await second
    expect(resultText(secondResult)).toBe('delivered')
    const deliveryIndex = messageIndex(agent, hasBackgroundDelivery)
    const secondInputIndex = messageIndex(agent, (content) => hasText(content, 'second'))
    expect(deliveryIndex).toBeGreaterThan(secondInputIndex)
    expect(persistedTasks(agent)).toBeUndefined()
  })

  it('delivers a task that outlives its dispatching invocation inside the queued invocation', async () => {
    const work = createGate('work')
    const firstGate = createGate('first_gate')
    const secondGate = createGate('second_gate')
    const model = new MockMessageModel()
      .addTurn([
        { type: 'toolUseBlock', name: 'work', toolUseId: 'work-use', input: {} },
        { type: 'toolUseBlock', name: 'first_gate', toolUseId: 'first-gate-use', input: {} },
      ])
      .addTurn({ type: 'textBlock', text: 'first done' })
      .addTurn({ type: 'toolUseBlock', name: 'second_gate', toolUseId: 'second-gate-use', input: {} })
      .addTurn({ type: 'textBlock', text: 'second done' })
    const agent = new Agent({
      model,
      tools: [work.tool, firstGate.tool, secondGate.tool],
      backgroundTasks: { always: [work.tool], never: [firstGate.tool, secondGate.tool], waitForCompletion: false },
      concurrentInvocationMode: 'enqueue',
      printer: false,
    })

    const first = agent.invoke('first')
    await firstGate.started
    const second = agent.invoke('second')
    expect(agent.pendingInvocations).toHaveLength(1)

    // First invocation ends with the background task still working (waitForCompletion: false).
    firstGate.release()
    const firstResult = await first
    expect(resultText(firstResult)).toBe('first done')
    expect(persistedTasks(agent)?.map((task) => task.status)).toEqual(['working'])

    // The queued invocation now holds the turn; the task settles while it runs.
    await secondGate.started
    work.release()
    await until(() => persistedTasks(agent)?.[0]?.status === 'completed', 'background task settled')
    secondGate.release()

    // The queued invocation absorbs the delivery: the settled task dispatched by
    // invocation one is injected at the queued invocation's next model call.
    const secondResult = await second
    expect(resultText(secondResult)).toBe('second done')
    const deliveryIndex = messageIndex(agent, hasBackgroundDelivery)
    const secondInputIndex = messageIndex(agent, (content) => hasText(content, 'second'))
    expect(deliveryIndex).toBeGreaterThan(secondInputIndex)
    // Cross-invocation delivery carries provenance: the model must not fold the old
    // task's result into its answer to the new caller.
    expect(deliveryInput(agent)).toEqual({ toolName: 'work', startedBy: 'an earlier request in this conversation' })
    expect(persistedTasks(agent)).toBeUndefined()
  })

  it('does not mark a same-invocation delivery as started by an earlier request', async () => {
    const work = createGate('work')
    const model = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'work', toolUseId: 'work-use', input: {} })
      .addTurn({ type: 'textBlock', text: 'first done' })
      .addTurn({ type: 'textBlock', text: 'delivered' })
    const agent = new Agent({
      model,
      tools: [work.tool],
      backgroundTasks: { always: [work.tool] },
      printer: false,
    })

    const first = agent.invoke('first')
    await work.started
    // Let the invocation reach its final model pass first, so the task settles
    // during the end-of-invocation settlement wait and is delivered by the same
    // invocation's delivery continuation.
    await until(() => agent.messages.some((message) => hasText(message.content, 'first done')), 'first final turn')
    work.release()
    const result = await first
    expect(resultText(result)).toBe('delivered')
    expect(deliveryInput(agent)).toEqual({ toolName: 'work' })
  })

  it('rejects a queued caller loudly when a background task interrupt ends the running invocation', async () => {
    const approval = tool({
      name: 'approval',
      description: 'Wait for approval.',
      inputSchema: z.object({}),
      callback: () => 'approved',
    })
    const holdGate = createGate('hold_gate')
    const model = new MockMessageModel()
      .addTurn([
        { type: 'toolUseBlock', name: 'approval', toolUseId: 'approval-use', input: {} },
        { type: 'toolUseBlock', name: 'hold_gate', toolUseId: 'hold-gate-use', input: {} },
      ])
      .addTurn({ type: 'textBlock', text: 'resumed' })
      .addTurn({ type: 'textBlock', text: 'delivered' })
    const agent = new Agent({
      model,
      tools: [approval, holdGate.tool],
      backgroundTasks: { always: [approval], never: [holdGate.tool] },
      concurrentInvocationMode: 'enqueue',
      printer: false,
    })
    agent.addMiddleware(ExecuteToolStage, async function* (context, next) {
      if (context.toolUse.name === 'approval') {
        context.interrupt<string>({ name: 'approve', reason: 'Approve work?' })
      }
      return yield* next(context)
    })

    // The foreground gate holds the first invocation open while the background
    // approval task interrupts (input_required) and the second caller queues up.
    const first = agent.invoke('first')
    await holdGate.started
    const second = agent.invoke('second')
    expect(agent.pendingInvocations).toHaveLength(1)
    holdGate.release()

    const firstResult = await first
    expect(firstResult.stopReason).toBe('interrupt')

    // The queued caller cannot answer someone else's interrupt: it fails loudly rather
    // than silently absorbing or corrupting the interrupted state.
    await expect(second).rejects.toThrow(/interrupted state/)

    // The interrupt remains resumable after the queued caller's rejection.
    const resumed = await agent.invoke([
      new InterruptResponseContent({
        interruptId: firstResult.interrupts![0]!.id,
        response: 'yes',
      }),
    ])
    expect(resumed.stopReason).toBe('endTurn')
    expect(messageIndex(agent, hasBackgroundDelivery)).toBeGreaterThan(-1)
    expect(persistedTasks(agent)).toBeUndefined()
  })

  it('hands the turn to an ifBusy interrupt caller blocked behind background-task settlement', async () => {
    const fast = createGate('fast_work')
    const slow = createGate('slow_work')
    const model = new MockMessageModel()
      .addTurn([
        { type: 'toolUseBlock', name: 'fast_work', toolUseId: 'fast-use', input: {} },
        { type: 'toolUseBlock', name: 'slow_work', toolUseId: 'slow-use', input: {} },
      ])
      .addTurn({ type: 'textBlock', text: 'first done' })
      .addTurn({ type: 'textBlock', text: 'urgent done' })
      .addTurn({ type: 'textBlock', text: 'slow delivered' })
    const agent = new Agent({
      model,
      tools: [fast.tool, slow.tool],
      backgroundTasks: { always: [fast.tool, slow.tool] },
      concurrentInvocationMode: 'enqueue',
      printer: false,
    })

    // First invocation finishes its model passes, then blocks in the settlement
    // wait: the fast task has settled (its delivery continuation is prepared)
    // while the slow task keeps running.
    const first = agent.invoke('first')
    await fast.started
    await slow.started
    await until(() => agent.messages.some((message) => hasText(message.content, 'first done')), 'first final turn')
    fast.release()
    await until(() => (persistedTasks(agent) ?? []).some((task) => task.status === 'completed'), 'fast task settled')
    expect(model.callCount).toBe(2)

    // The prepared delivery continuation must not resurrect the cancelled invocation.
    const urgent = agent.invoke('urgent', { ifBusy: 'cancelPrevious' })
    const firstResult = await first
    expect(firstResult.stopReason).toBe('endTurn')
    expect(resultText(firstResult)).toBe('first done')

    // The interrupter runs next; the abandoned fast-task delivery lands inside
    // ITS model pass instead of a resurrected pass of the cancelled invocation.
    await until(() => model.callCount === 3, 'urgent model pass')
    expect(agent.pendingInvocations).toHaveLength(0)
    const deliveryIndex = messageIndex(agent, hasBackgroundDelivery)
    const urgentInputIndex = messageIndex(agent, (content) => hasText(content, 'urgent'))
    expect(deliveryIndex).toBeGreaterThan(urgentInputIndex)

    // The interrupter still honors waitForCompletion for the outstanding slow task.
    slow.release()
    const urgentResult = await urgent
    expect(resultText(urgentResult)).toBe('slow delivered')
    expect(persistedTasks(agent)).toBeUndefined()
  })

  it('surfaces a background-task interrupt even when the invocation was cancelled (resume is not gated)', async () => {
    const approval = tool({
      name: 'approval',
      description: 'Wait for approval.',
      inputSchema: z.object({}),
      callback: () => 'approved',
    })
    const holdGate = createGate('hold_gate')
    const model = new MockMessageModel()
      .addTurn([
        { type: 'toolUseBlock', name: 'approval', toolUseId: 'approval-use', input: {} },
        { type: 'toolUseBlock', name: 'hold_gate', toolUseId: 'hold-gate-use', input: {} },
      ])
      .addTurn({ type: 'textBlock', text: 'resumed' })
      .addTurn({ type: 'textBlock', text: 'delivered' })
    const agent = new Agent({
      model,
      tools: [approval, holdGate.tool],
      backgroundTasks: { always: [approval], never: [holdGate.tool] },
      printer: false,
    })
    agent.addMiddleware(ExecuteToolStage, async function* (context, next) {
      if (context.toolUse.name === 'approval') {
        context.interrupt<string>({ name: 'approve', reason: 'Approve work?' })
      }
      return yield* next(context)
    })

    const first = agent.invoke('first')
    await holdGate.started
    await until(() => (persistedTasks(agent) ?? []).some((task) => task.status === 'input_required'), 'input_required')

    // Cancel the running invocation. The pending input_required interrupt must still
    // surface: the resume path is deliberately not gated on cancellation.
    agent.cancel()
    const firstResult = await first
    expect(firstResult.stopReason).toBe('interrupt')
    expect(firstResult.interrupts).toHaveLength(1)
    // The resume pass raised before any model call: no pass beyond the first ran.
    expect(model.callCount).toBe(1)

    // The interrupt remains resumable.
    const resumed = await agent.invoke([
      new InterruptResponseContent({
        interruptId: firstResult.interrupts![0]!.id,
        response: 'yes',
      }),
    ])
    expect(resumed.stopReason).toBe('endTurn')
    expect(messageIndex(agent, hasBackgroundDelivery)).toBeGreaterThan(-1)
    expect(persistedTasks(agent)).toBeUndefined()
  })
  it('marks a cross-invocation delivery even when both invocations share one options object', async () => {
    const work = createGate('work')
    const firstGate = createGate('first_gate')
    const secondGate = createGate('second_gate')
    const model = new MockMessageModel()
      .addTurn([
        { type: 'toolUseBlock', name: 'work', toolUseId: 'work-use', input: {} },
        { type: 'toolUseBlock', name: 'first_gate', toolUseId: 'first-gate-use', input: {} },
      ])
      .addTurn({ type: 'textBlock', text: 'first done' })
      .addTurn({ type: 'toolUseBlock', name: 'second_gate', toolUseId: 'second-gate-use', input: {} })
      .addTurn({ type: 'textBlock', text: 'second done' })
    const agent = new Agent({
      model,
      tools: [work.tool, firstGate.tool, secondGate.tool],
      backgroundTasks: { always: [work.tool], never: [firstGate.tool, secondGate.tool], waitForCompletion: false },
      concurrentInvocationMode: 'enqueue',
      printer: false,
    })

    // One options object reused across invocations (as AgentAsTool does): provenance
    // must be keyed on the invocation, not this object's identity.
    const sharedOptions = { invocationState: {} }

    const first = agent.invoke('first', sharedOptions)
    await firstGate.started
    const second = agent.invoke('second', sharedOptions)
    expect(agent.pendingInvocations).toHaveLength(1)

    firstGate.release()
    const firstResult = await first
    expect(resultText(firstResult)).toBe('first done')
    expect(persistedTasks(agent)?.map((task) => task.status)).toEqual(['working'])

    await secondGate.started
    work.release()
    await until(() => persistedTasks(agent)?.[0]?.status === 'completed', 'background task settled')
    secondGate.release()

    const secondResult = await second
    expect(resultText(secondResult)).toBe('second done')
    // The delivery is genuinely cross-invocation, so it must carry provenance
    // even though both invocations shared one invocationState reference.
    expect(deliveryInput(agent)).toEqual({ toolName: 'work', startedBy: 'an earlier request in this conversation' })
    expect(persistedTasks(agent)).toBeUndefined()
  })

  it('does not mark a delivery in the resume of an interrupted invocation as an earlier request', async () => {
    const approval = tool({
      name: 'approval',
      description: 'Wait for approval.',
      inputSchema: z.object({}),
      callback: () => 'approved',
    })
    const holdGate = createGate('hold_gate')
    const model = new MockMessageModel()
      .addTurn([
        { type: 'toolUseBlock', name: 'approval', toolUseId: 'approval-use', input: {} },
        { type: 'toolUseBlock', name: 'hold_gate', toolUseId: 'hold-gate-use', input: {} },
      ])
      .addTurn({ type: 'textBlock', text: 'resumed' })
      .addTurn({ type: 'textBlock', text: 'delivered' })
    const agent = new Agent({
      model,
      tools: [approval, holdGate.tool],
      backgroundTasks: { always: [approval], never: [holdGate.tool] },
      printer: false,
    })
    agent.addMiddleware(ExecuteToolStage, async function* (context, next) {
      if (context.toolUse.name === 'approval') {
        context.interrupt<string>({ name: 'approve', reason: 'Approve work?' })
      }
      return yield* next(context)
    })

    const first = agent.invoke('first')
    await holdGate.started
    await until(() => (persistedTasks(agent) ?? []).some((task) => task.status === 'input_required'), 'input_required')
    holdGate.release()
    const firstResult = await first
    expect(firstResult.stopReason).toBe('interrupt')

    // The resume continues the request that dispatched the task, so its delivery
    // carries no provenance marker.
    const resumed = await agent.invoke([
      new InterruptResponseContent({
        interruptId: firstResult.interrupts![0]!.id,
        response: 'yes',
      }),
    ])
    expect(resumed.stopReason).toBe('endTurn')
    expect(deliveryInput(agent)).toEqual({ toolName: 'approval' })
    expect(persistedTasks(agent)).toBeUndefined()
  })

  it('surfaces an interrupt raised during the settlement wait even when a hook cancels after resume is set', async () => {
    const approval = tool({
      name: 'approval',
      description: 'Wait for approval.',
      inputSchema: z.object({}),
      callback: () => 'approved',
    })
    let releaseApproval!: () => void
    const approvalGate = new Promise<void>((resolve) => (releaseApproval = resolve))
    const model = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'approval', toolUseId: 'approval-use', input: {} })
      .addTurn({ type: 'textBlock', text: 'first done' })
      .addTurn({ type: 'textBlock', text: 'resumed' })
      .addTurn({ type: 'textBlock', text: 'delivered' })
    const agent = new Agent({
      model,
      tools: [approval],
      backgroundTasks: { always: [approval] },
      printer: false,
    })
    agent.addMiddleware(ExecuteToolStage, async function* (context, next) {
      if (context.toolUse.name === 'approval') {
        await approvalGate
        context.interrupt<string>({ name: 'approve', reason: 'Approve work?' })
      }
      return yield* next(context)
    })
    // AfterInvocation callbacks run in reverse registration order, so this cleanup
    // hook cancels AFTER the background-tasks plugin has set `event.resume` — the
    // scenario that distinguishes not gating `resume` on cancellation from gating it.
    agent.addHook(AfterInvocationEvent, (event) => {
      if (event.resume !== undefined) agent.cancel()
    })

    const first = agent.invoke('first')
    // Let the invocation finish its final model pass, then let the task interrupt
    // land during the end-of-invocation settlement wait.
    await until(() => agent.messages.some((message) => hasText(message.content, 'first done')), 'first final turn')
    releaseApproval()

    const firstResult = await first
    expect(firstResult.stopReason).toBe('interrupt')
    expect(firstResult.interrupts).toHaveLength(1)
    // The resume pass raised the interrupt before any model call.
    expect(model.callCount).toBe(2)

    // The interrupt remains resumable, and the resumed delivery belongs to the
    // same logical request (no provenance marker).
    const resumed = await agent.invoke([
      new InterruptResponseContent({
        interruptId: firstResult.interrupts![0]!.id,
        response: 'yes',
      }),
    ])
    expect(resumed.stopReason).toBe('endTurn')
    expect(deliveryInput(agent)).toEqual({ toolName: 'approval' })
    expect(persistedTasks(agent)).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { Interrupt, InterruptError } from '../../../interrupt.js'
import { tool } from '../../../tools/tool-factory.js'
import type { Tool, ToolContext } from '../../../tools/tool.js'
import { BackgroundTaskTimeoutError } from '../../errors.js'
import { InProcessTaskManager } from '../manager.js'

function createFixture(
  callback: (
    input: { value: string },
    context?: ToolContext
  ) => AsyncGenerator<unknown, string, never> | string | Promise<string>
): { readonly manager: InProcessTaskManager; readonly work: Tool } {
  const work = tool({
    name: 'work',
    description: 'Perform controlled test work.',
    inputSchema: z.object({ value: z.string() }),
    callback,
  })
  const manager = new InProcessTaskManager(createMockAgent(), async (selectedTool, context) => {
    const stream = selectedTool.stream(context)
    let next = await stream.next()
    while (!next.done) next = await stream.next()
    return next.value
  })
  return { manager, work }
}

function submit(
  manager: InProcessTaskManager,
  work: Tool,
  value: string,
  toolUseId = `tool-use-${value}`,
  passId = `pass-${value}`
) {
  return manager.submit({ name: 'work', toolUseId, input: { value } }, {}, passId, work)
}

describe('InProcessTaskManager', () => {
  it('executes the selected tool with transient invocation state', async () => {
    const invocationState: ToolContext['invocationState'] = {
      requestId: 'request-1',
      callback: (): string => 'not serializable',
    }
    const { manager, work } = createFixture(async function* ({ value }, context) {
      expect(context?.invocationState).toBe(invocationState)
      expect(context?.toolUse.name).toBe('hook-alias')
      yield 'progress'
      return value.toUpperCase()
    })

    const admitted = await manager.submit(
      { name: 'hook-alias', toolUseId: 'tool-use-1', input: { value: 'hello' } },
      invocationState,
      'pass-1',
      work
    )

    await manager.waitForIdle()
    const completed = {
      taskId: admitted.taskId,
      toolUseId: 'tool-use-1',
      toolName: 'hook-alias',
      status: 'completed',
      createdAt: expect.any(String),
      lastUpdatedAt: expect.any(String),
      result: { content: [{ text: 'HELLO' }] },
    }
    expect(await manager.get(admitted.taskId)).toEqual(completed)
    expect(await manager.list()).toEqual([completed])
    await manager.remove([admitted.taskId])
    await expect(manager.get(admitted.taskId)).resolves.toBeUndefined()
  })

  it('deduplicates repeated submissions within one pass', async () => {
    let executionCount = 0
    const { manager, work } = createFixture(({ value }) => {
      executionCount += 1
      return value
    })

    const first = await submit(manager, work, 'same', 'tool-use-1', 'pass-1')
    const duplicate = await submit(manager, work, 'same', 'tool-use-1', 'pass-1')
    const laterPass = await submit(manager, work, 'same', 'tool-use-1', 'pass-2')

    expect(duplicate.taskId).toBe(first.taskId)
    expect(laterPass.taskId).not.toBe(first.taskId)
    await manager.waitForIdle()
    expect(executionCount).toBe(2)
  })

  it('projects tool errors', async () => {
    const { manager, work } = createFixture(() => {
      throw new Error('tool failed')
    })
    const failed = await submit(manager, work, 'failed')

    await expect(manager.wait(failed.taskId)).resolves.toEqual({
      ...failed,
      status: 'failed',
      lastUpdatedAt: expect.any(String),
      result: { content: [{ text: 'Error: tool failed' }] },
      error: { type: 'toolError', message: 'tool failed' },
    })
  })

  it('cancels tool execution', async () => {
    let started!: () => void
    const toolStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let cancelSignal: AbortSignal | undefined
    const { manager, work } = createFixture(async (_input, context) => {
      cancelSignal = context!.cancelSignal
      started()
      await new Promise<void>((resolve) => cancelSignal!.addEventListener('abort', () => resolve(), { once: true }))
      return 'late'
    })
    const admitted = await submit(manager, work, 'cancel')
    await toolStarted
    const waiting = manager.wait(admitted.taskId)

    const cancelled = {
      ...admitted,
      status: 'cancelled',
      lastUpdatedAt: expect.any(String),
    }
    await expect(manager.cancel(admitted.taskId)).resolves.toEqual(cancelled)
    await expect(waiting).resolves.toEqual(cancelled)
    expect(cancelSignal).toMatchObject({ aborted: true, reason: 'Cancellation requested' })
    await manager.waitForIdle()
  })

  it('rejects an invalid wait timeout', async () => {
    const { manager } = createFixture(({ value }) => value)

    await expect(manager.waitForIdle({ timeout: 0 })).rejects.toThrow(TypeError)
  })

  it('throws BackgroundTaskTimeoutError when the wait exceeds the timeout', async () => {
    const { manager, work } = createFixture(
      (_input, context) =>
        new Promise<string>((resolve) => {
          context!.cancelSignal.addEventListener('abort', () => resolve('cancelled'), { once: true })
        })
    )
    const admitted = await submit(manager, work, 'slow')

    await expect(manager.waitForIdle({ timeout: 10 })).rejects.toBeInstanceOf(BackgroundTaskTimeoutError)

    await manager.cancel(admitted.taskId)
    await manager.waitForIdle()
  })

  it('requests input and resumes tool interrupts', async () => {
    const { manager, work } = createFixture(({ value }, context) => {
      if (value === 'complete') return 'complete'
      const response = context!.interrupt<string>({ name: 'approve_work', reason: 'Approve work?' })
      return `approved:${response}`
    })
    const completed = await submit(manager, work, 'complete')
    await manager.wait(completed.taskId)
    const admitted = await submit(manager, work, 'interrupt', 'tool-use-1')
    const inputRequired = await manager.wait(admitted.taskId)
    expect(inputRequired).toEqual({
      ...admitted,
      status: 'input_required',
      lastUpdatedAt: expect.any(String),
      interrupts: [
        {
          id: expect.any(String),
          name: 'approve_work',
          reason: 'Approve work?',
          source: 'tool',
        },
      ],
    })
    const interrupt = inputRequired.interrupts?.[0]
    if (!interrupt) throw new Error('Expected task interrupt')

    await expect(manager.remove([completed.taskId, admitted.taskId])).rejects.toThrow(
      `Background task '${admitted.taskId}' cannot be removed before reaching a terminal status`
    )
    await expect(manager.get(completed.taskId)).resolves.toBeDefined()

    await expect(manager.resume(admitted.taskId, [{ interruptId: interrupt.id, response: 'yes' }])).resolves.toEqual({
      ...admitted,
      status: 'queued',
      lastUpdatedAt: expect.any(String),
    })
    await expect(manager.wait(admitted.taskId)).resolves.toEqual({
      ...admitted,
      status: 'completed',
      lastUpdatedAt: expect.any(String),
      result: { content: [{ text: 'approved:yes' }] },
    })
  })

  it('fails tasks interrupted outside their tool context', async () => {
    const { manager, work } = createFixture(() => {
      throw new InterruptError(
        new Interrupt({
          id: 'hook:beforeToolCall:tool-use-1:approve_hook',
          name: 'approve_hook',
          source: 'hook',
        })
      )
    })
    const admitted = await submit(manager, work, 'hook-interrupt', 'tool-use-1')

    await expect(manager.wait(admitted.taskId)).resolves.toEqual({
      ...admitted,
      status: 'failed',
      lastUpdatedAt: expect.any(String),
      error: { type: 'executionError', message: 'Interrupt raised: approve_hook' },
    })
  })
})

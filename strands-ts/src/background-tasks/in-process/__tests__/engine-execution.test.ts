import { describe, expect, it, vi } from 'vitest'
import { createAdmission, createEngine, createResult, deferred, expectTask } from './engine-test-helpers.js'
import type { InProcessTaskExecutionOutcome, InProcessTaskRecord } from '../types.js'

describe('InProcessTaskEngine', () => {
  describe('admission and updates', () => {
    it('prevents task update callbacks from mutating engine-owned state', async () => {
      const statuses: InProcessTaskRecord['status'][] = []
      const engine = createEngine(
        async ({ toolName }) => ({ status: 'completed', result: createResult(toolName.toUpperCase()) }),
        {
          onTaskUpdated: (task) => {
            statuses.push(task.status)
            if (task.status === 'working') task.status = 'cancelled'
            if (task.status === 'completed') throw new Error('notification failed')
          },
        }
      )
      const admitted = engine.submit(createAdmission('hello'))

      admitted.status = 'cancelled'
      await engine.waitForIdle()
      const completed = engine.get(admitted.taskId)!
      expectTask(completed, admitted, { status: 'completed', result: createResult('HELLO') })
      expect(engine.list()).toEqual([completed])
      expect(statuses).toEqual(['queued', 'working', 'completed'])

      completed.status = 'cancelled'
      engine.list()[0]!.status = 'failed'
      expectTask(engine.get(admitted.taskId), admitted, {
        status: 'completed',
        result: createResult('HELLO'),
      })

      engine.remove(admitted.taskId)
      expect(engine.list()).toEqual([])
    })
  })

  describe('execution', () => {
    it('bounds execution concurrency', async () => {
      const releases = [
        deferred<InProcessTaskExecutionOutcome>(),
        deferred<InProcessTaskExecutionOutcome>(),
        deferred<InProcessTaskExecutionOutcome>(),
      ]
      const started = [deferred<void>(), deferred<void>(), deferred<void>()]
      const engine = createEngine(
        async ({ toolName }) => {
          const index = Number(toolName)
          started[index]!.resolve()
          return releases[index]!.promise
        },
        { maxConcurrency: 2 }
      )
      const tasks = ['0', '1', '2'].map((value) => engine.submit(createAdmission(value)))
      await Promise.all(started.slice(0, 2).map(({ promise }) => promise))
      expectTask(engine.get(tasks[2]!.taskId), tasks[2]!, { status: 'queued' })

      releases[0]!.resolve({ status: 'completed', result: createResult('0') })
      await started[2]!.promise
      releases[1]!.resolve({ status: 'completed', result: createResult('1') })
      releases[2]!.resolve({ status: 'completed', result: createResult('2') })
      await engine.waitForIdle()
    })

    it('records classified failures', async () => {
      const thrownEngine = createEngine(async () => {
        throw new TypeError('Execution exploded')
      })
      const thrown = thrownEngine.submit(createAdmission('throw'))
      await thrownEngine.waitForIdle()
      expectTask(thrownEngine.get(thrown.taskId), thrown, {
        status: 'failed',
        failure: { type: 'executionError', message: 'Execution exploded' },
      })

      const opaqueEngine = createEngine(() => Promise.reject(Object.create(null)))
      const opaque = opaqueEngine.submit(createAdmission('opaque'))
      await opaqueEngine.waitForIdle()
      expectTask(opaqueEngine.get(opaque.taskId), opaque, {
        status: 'failed',
        failure: { type: 'executionError', message: 'Background task execution failed' },
      })

      const returnedEngine = createEngine(async () => ({
        status: 'failed',
        failure: { type: 'toolError', message: 'Tool failed' },
        result: createResult('tool detail'),
      }))
      const returned = returnedEngine.submit(createAdmission('return'))
      await returnedEngine.waitForIdle()
      expectTask(returnedEngine.get(returned.taskId), returned, {
        status: 'failed',
        failure: { type: 'toolError', message: 'Tool failed' },
        result: createResult('tool detail'),
      })
    })

    it('does not release capacity until a timed-out execution settles', async () => {
      const release = deferred<InProcessTaskExecutionOutcome>()
      const timedOut = deferred<void>()
      let hungSignal: AbortSignal | undefined
      const engine = createEngine(
        async ({ toolName, cancelSignal }) => {
          if (toolName === 'hang') {
            hungSignal = cancelSignal
            cancelSignal.addEventListener('abort', () => timedOut.resolve(), { once: true })
            return release.promise
          }
          return { status: 'completed', result: createResult('next') }
        },
        { maxConcurrency: 1, timeout: 10 }
      )
      const hung = engine.submit(createAdmission('hang'))
      const next = engine.submit(createAdmission('next'))
      await timedOut.promise
      try {
        expect(hungSignal?.aborted).toBe(true)
        expectTask(engine.get(next.taskId), next, { status: 'queued' })
      } finally {
        release.resolve({ status: 'completed', result: createResult('late') })
      }
      await engine.waitForIdle()
      expectTask(engine.get(next.taskId), next, {
        status: 'completed',
        result: createResult('next'),
      })
      expectTask(engine.get(hung.taskId), hung, {
        status: 'failed',
        failure: { type: 'timeout', message: 'Timed out after 10ms' },
      })
    })

    it('allows Infinity to disable execution timeouts', async () => {
      const finish = deferred<InProcessTaskExecutionOutcome>()
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      const engine = createEngine(async () => finish.promise, { timeout: Infinity })
      const task = engine.submit(createAdmission('work'))
      expect(timeoutSpy).not.toHaveBeenCalled()
      finish.resolve({ status: 'completed', result: createResult('done') })
      await engine.waitForIdle()
      expectTask(engine.get(task.taskId), task, { status: 'completed', result: createResult('done') })
      timeoutSpy.mockRestore()
    })
  })
})

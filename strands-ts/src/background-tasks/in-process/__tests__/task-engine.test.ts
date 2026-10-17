import { describe, expect, it } from 'vitest'
import { TaskEngine, TaskNotFoundError } from '../task-engine.js'

describe('TaskEngine', () => {
  it('preserves consumer-owned input and result', async () => {
    const input = { value: 'work' }
    const result = new AbortController()
    const engine = new TaskEngine({
      maxConcurrency: 1,
      timeout: 1_000,
      execute: async (context) => {
        expect(context.input).toBe(input)
        return { status: 'completed' as const, result }
      },
      onTaskUpdated: () => undefined,
    })

    const admitted = engine.submit(input)
    expect(admitted.input).toBe(input)
    await engine.waitForIdle()

    const completed = engine.get(admitted.taskId)!
    expect(completed.result).toBe(result)
    completed.status = 'cancelled'
    expect(engine.get(admitted.taskId)?.status).toBe('completed')
  })

  it('reports missing tasks without background tool types', () => {
    const engine = new TaskEngine<string, string>({
      maxConcurrency: 1,
      timeout: 1_000,
      execute: async ({ input }) => ({ status: 'completed', result: input }),
      onTaskUpdated: () => undefined,
    })

    expect(() => engine.cancel('missing', { reason: 'stop' })).toThrow(TaskNotFoundError)
  })
})

import { describe, it, expect, vi, afterEach } from 'vitest'
import { sleep, makeSleep, DEFAULT_MAX_DURATION } from '../index.js'
import type { ToolContext } from '../../../index.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'

/**
 * Build a fresh ToolContext, optionally using an AbortController's signal
 * for cancellation testing.
 */
function createContext(controller?: AbortController): ToolContext {
  const agent = createMockAgent()
  return {
    toolUse: { name: 'sleep', toolUseId: 'test-id', input: {} },
    agent,
    invocationState: {},
    cancelSignal: controller?.signal ?? agent.cancelSignal,
    interrupt: () => {
      throw new Error('interrupt not available in mock context')
    },
  }
}

describe('sleep tool', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('input validation', () => {
    it('rejects negative durations', async () => {
      await expect(sleep.invoke({ duration: -0.1 }, createContext())).rejects.toThrow(/non-negative/)
    })

    it('rejects NaN durations', async () => {
      await expect(sleep.invoke({ duration: Number.NaN }, createContext())).rejects.toThrow()
    })

    it('rejects positive infinity', async () => {
      await expect(sleep.invoke({ duration: Number.POSITIVE_INFINITY }, createContext())).rejects.toThrow()
    })

    it('rejects negative infinity', async () => {
      await expect(sleep.invoke({ duration: Number.NEGATIVE_INFINITY }, createContext())).rejects.toThrow()
    })

    it('rejects non-numeric input via schema', async () => {
      await expect(sleep.invoke({ duration: 'one' as unknown as number }, createContext())).rejects.toThrow()
    })

    it('rejects boolean input via schema', async () => {
      await expect(sleep.invoke({ duration: true as unknown as number }, createContext())).rejects.toThrow()
      await expect(sleep.invoke({ duration: false as unknown as number }, createContext())).rejects.toThrow()
    })

    it('rejects duration above default maximum', async () => {
      await expect(sleep.invoke({ duration: DEFAULT_MAX_DURATION + 1 }, createContext())).rejects.toThrow(
        /exceeds maximum/
      )
    })

    it('rejects duration above configured maximum', async () => {
      const capped = makeSleep({ maxDuration: 0.5 })
      await expect(capped.invoke({ duration: 0.6 }, createContext())).rejects.toThrow(/exceeds maximum/)
    })
  })

  describe('factory validation', () => {
    it('rejects zero maxDuration', () => {
      expect(() => makeSleep({ maxDuration: 0 })).toThrow(/positive/)
    })

    it('rejects negative maxDuration', () => {
      expect(() => makeSleep({ maxDuration: -1 })).toThrow(/positive/)
    })

    it('rejects NaN maxDuration', () => {
      expect(() => makeSleep({ maxDuration: Number.NaN })).toThrow(/positive/)
    })

    it('rejects Infinity maxDuration', () => {
      expect(() => makeSleep({ maxDuration: Number.POSITIVE_INFINITY })).toThrow(/positive/)
    })

    it('rejects non-numeric maxDuration', () => {
      expect(() => makeSleep({ maxDuration: '10' as unknown as number })).toThrow(/positive/)
    })
  })

  describe('cancellation', () => {
    it('aborts immediately when cancelSignal fires mid-sleep', async () => {
      const controller = new AbortController()
      const context = createContext(controller)
      expect(context.cancelSignal).not.toBe(context.agent.cancelSignal)

      const invocation = sleep.invoke({ duration: 5 }, context)
      globalThis.setTimeout(() => controller.abort(), 10)

      const started = Date.now()
      const error = await invocation.catch((cause: unknown) => cause)
      const elapsed = Date.now() - started
      // Cooperative cancel: should return in far less than the requested 5 s.
      expect(elapsed).toBeLessThan(1000)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).name).toBe('AbortError')
    })

    it('rejects synchronously when the signal is already aborted', async () => {
      const controller = new AbortController()
      controller.abort()
      const context = createContext(controller)

      const error = await sleep.invoke({ duration: 1 }, context).catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).name).toBe('AbortError')
    })
  })

  describe('happy path', () => {
    it('returns the expected message after a real short sleep', async () => {
      const started = Date.now()
      const result = await sleep.invoke({ duration: 0.05 }, createContext())
      const elapsed = Date.now() - started
      expect(result).toBe('Slept for 0.05 seconds')
      // Most of the requested duration should have elapsed.
      expect(elapsed).toBeGreaterThanOrEqual(40)
    })

    it('accepts zero duration', async () => {
      const result = await sleep.invoke({ duration: 0 }, createContext())
      expect(result).toBe('Slept for 0 seconds')
    })

    it('works without a context by skipping the cancel wiring', async () => {
      const result = await sleep.invoke({ duration: 0.01 })
      expect(result).toBe('Slept for 0.01 seconds')
    })
  })

  describe('timing (fake timers)', () => {
    // Isolate fake-timer usage so any leakage cannot poison the real-timer tests.
    it('drives setTimeout with the requested duration in ms', async () => {
      vi.useFakeTimers()
      try {
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')

        const promise = sleep.invoke({ duration: 2 }, createContext())
        // Let the promise executor schedule its timer.
        await Promise.resolve()

        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2000)

        await vi.advanceTimersByTimeAsync(2000)
        await expect(promise).resolves.toBe('Slept for 2 seconds')
      } finally {
        vi.useRealTimers()
      }
    })
  })
})

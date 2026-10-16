/**
 * Unit tests for the proactive restart timer.
 *
 * The timer is exercised with an injected fake clock so timing is deterministic and does
 * not depend on wall time or a running provider.
 */

import { describe, expect, it } from 'vitest'
import { RestartTimer, resolveDeadlineMs } from '../restart-timer.js'

/** A promise plus its resolver, standing in for an `asyncio.Event`. */
function gate(): { wait: Promise<void>; set: () => void } {
  let set!: () => void
  const wait = new Promise<void>((resolve) => {
    set = resolve
  })
  return { wait, set }
}

/** Await the timer's in-flight cycle; it is private, as in Python. */
function task(timer: RestartTimer): Promise<void> | undefined {
  return (timer as unknown as { _task: Promise<void> | undefined })._task
}

describe('restart-timer', () => {
  describe('resolveDeadlineMs', () => {
    it('returns undefined when not declared', () => {
      expect(resolveDeadlineMs({})).toBeUndefined()
      expect(resolveDeadlineMs({ autoRestart: true })).toBeUndefined()
    })

    it('returns the declared restartAfterMs', () => {
      expect(resolveDeadlineMs({ restartAfterMs: 540_000 })).toBe(540_000)
    })

    it('returns undefined when not positive', () => {
      expect(resolveDeadlineMs({ restartAfterMs: 0 })).toBeUndefined()
      expect(resolveDeadlineMs({ restartAfterMs: -5 })).toBeUndefined()
    })
  })

  describe('RestartTimer', () => {
    it('fires the warning then the deadline', async () => {
      const warnings: number[] = []
      const deadlines: null[] = []
      const sleeps: number[] = []

      const timer = new RestartTimer(
        async (timeLeftMs) => {
          warnings.push(timeLeftMs)
        },
        async () => {
          deadlines.push(null)
        },
        async (milliseconds) => {
          sleeps.push(milliseconds)
        }
      )

      // deadline 420s, warning 30s before it => sleep 390_000 then 30_000.
      timer.arm(420_000, 30_000)
      await task(timer)

      expect(sleeps).toEqual([390_000, 30_000])
      expect(warnings).toEqual([30_000]) // timeLeftMs at warning === warningLeadMs
      expect(deadlines).toEqual([null])
    })

    it('keeps the deadline countdown running while the warning is blocked', async () => {
      const warningStarted = gate()
      const releaseWarning = gate()
      const deadlineSleepStarted = gate()
      const deadlineElapsed = gate()
      const deadlines: null[] = []
      let sleepCount = 0

      const timer = new RestartTimer(
        async () => {
          warningStarted.set()
          await releaseWarning.wait
        },
        async () => {
          deadlines.push(null)
        },
        async () => {
          sleepCount += 1
          if (sleepCount === 2) {
            deadlineSleepStarted.set()
            await deadlineElapsed.wait
          }
        }
      )
      timer.arm(420_000, 30_000)

      await warningStarted.wait
      await deadlineSleepStarted.wait
      deadlineElapsed.set()
      await Promise.resolve()
      // warning ordering is preserved even after the deadline elapses
      expect(deadlines).toEqual([])

      releaseWarning.set()
      await task(timer)

      expect(deadlines).toEqual([null])
    })

    it('tolerates cancel while idle', () => {
      const timer = new RestartTimer(
        async () => {},
        async () => {}
      )
      expect(() => timer.cancel()).not.toThrow()
    })

    it('cancels the previous cycle when re-armed', async () => {
      const deadlines: null[] = []
      const started = gate()
      const never = new Promise<void>(() => {})

      const timer = new RestartTimer(
        async () => {},
        async () => {
          deadlines.push(null)
        },
        async () => {
          started.set()
          await never
        }
      )

      timer.arm(420_000, 30_000)
      await started.wait
      const firstTask = task(timer)

      timer.arm(420_000, 30_000)

      await Promise.resolve()
      expect(task(timer)).not.toBe(firstTask)
      expect(deadlines).toEqual([])

      timer.cancel()
    })
  })
})

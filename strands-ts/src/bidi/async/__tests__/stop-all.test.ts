/**
 * Unit tests for the bidirectional stop sequence.
 */

import { describe, expect, it, vi } from 'vitest'
import { stopAll } from '../stop-all.js'

describe('stopAll', () => {
  it('runs every stop function', async () => {
    const stop1 = vi.fn(async () => {})
    const stop2 = vi.fn(async () => {})
    const stop3 = vi.fn(async () => {})

    await stopAll(stop1, stop2, stop3)

    expect(stop1).toHaveBeenCalledOnce()
    expect(stop2).toHaveBeenCalledOnce()
    expect(stop3).toHaveBeenCalledOnce()
  })

  it('runs the remaining stops and aggregates every failure', async () => {
    const stop1 = vi.fn(async () => {})
    const stop2 = vi.fn(async () => {
      throw new Error('stop 2 failed')
    })
    const stop3 = vi.fn(async () => {})
    const stop4 = vi.fn(async () => {
      throw new Error('stop 4 failed')
    })

    const error = await stopAll(stop1, stop2, stop3, stop4).then(
      () => undefined,
      (reason: unknown) => reason as Error
    )

    expect(stop1).toHaveBeenCalledOnce()
    expect(stop2).toHaveBeenCalledOnce()
    expect(stop3).toHaveBeenCalledOnce()
    expect(stop4).toHaveBeenCalledOnce()

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain('failed stop sequence')
    expect(error?.message).toContain('stop 2 failed')
    expect(error?.message).toContain('stop 4 failed')
  })
})

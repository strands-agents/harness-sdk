import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createReloader, type ReloaderOptions, type ReloadOutcome } from '../src/dev/reload.js'
import { devStatusLabel, type DevReloadState } from '../src/dev/status.js'

describe('createReloader', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(overrides: Partial<ReloaderOptions> = {}) {
    const states: DevReloadState[] = []
    const reload = vi.fn(async (): Promise<ReloadOutcome> => 'reloaded')
    const reloader = createReloader({
      canReload: () => true,
      reload,
      onStatus: (state) => states.push(state),
      retryMs: 10,
      settleMs: 100,
      ...overrides,
    })
    return { states, reload, reloader }
  }

  it('reloads at once when idle and then shows the watch state again', async () => {
    const { states, reload, reloader } = setup()
    reloader.request()
    await vi.advanceTimersByTimeAsync(0)
    expect(reload).toHaveBeenCalledOnce()
    expect(states).toEqual([{ kind: 'reloading' }, { kind: 'reloaded' }])
    await vi.advanceTimersByTimeAsync(100)
    expect(states.at(-1)).toEqual({ kind: 'watching' })
  })

  it('waits while work runs and reloads once when the work stops', async () => {
    let busy = true
    const { states, reload, reloader } = setup({ canReload: () => !busy })
    reloader.request()
    reloader.request()
    await vi.advanceTimersByTimeAsync(50)
    expect(reload).not.toHaveBeenCalled()
    expect(states).toEqual([{ kind: 'pending' }])
    busy = false
    await vi.advanceTimersByTimeAsync(10)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('runs one more reload for a save during a reload', async () => {
    let finish!: (outcome: ReloadOutcome) => void
    const reload = vi.fn(() => new Promise<ReloadOutcome>((resolve) => (finish = resolve)))
    const { reloader } = setup({ reload })
    reloader.request()
    reloader.request()
    reloader.request()
    expect(reload).toHaveBeenCalledOnce()
    finish('reloaded')
    await vi.advanceTimersByTimeAsync(10)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('tries again after a deferred reload', async () => {
    const reload = vi.fn<() => Promise<ReloadOutcome>>().mockResolvedValueOnce('deferred').mockResolvedValue('reloaded')
    const { states, reloader } = setup({ reload })
    reloader.request()
    await vi.advanceTimersByTimeAsync(10)
    expect(reload).toHaveBeenCalledTimes(2)
    expect(states.at(-1)).toEqual({ kind: 'reloaded' })
  })

  it('reports a failure and reloads again on the next save', async () => {
    const reload = vi
      .fn<() => Promise<ReloadOutcome>>()
      .mockRejectedValueOnce(new Error('SyntaxError: invalid syntax'))
      .mockResolvedValue('reloaded')
    const { states, reloader } = setup({ reload })
    reloader.request()
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toEqual({ kind: 'failed', message: 'SyntaxError: invalid syntax' })
    reloader.request()
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toEqual({ kind: 'reloaded' })
  })

  it('stays quiet after a cancelled reload and after close', async () => {
    const reload = vi.fn(async (): Promise<ReloadOutcome> => 'cancelled')
    const { states, reloader } = setup({ reload })
    reloader.request()
    await vi.advanceTimersByTimeAsync(0)
    expect(states).toEqual([{ kind: 'reloading' }])
    reloader.close()
    reloader.request()
    await vi.advanceTimersByTimeAsync(100)
    expect(reload).toHaveBeenCalledOnce()
  })
})

describe('devStatusLabel', () => {
  it.each<[DevReloadState, string, string]>([
    [{ kind: 'watching' }, '● dev · watching', 'success'],
    [{ kind: 'pending' }, '↻ reload pending', 'warning'],
    [{ kind: 'reloading' }, '↻ reloading', 'warning'],
    [{ kind: 'reloaded' }, '↻ agent.py reloaded · session kept', 'success'],
    [{ kind: 'failed', message: 'bad' }, '✗ reload failed', 'error'],
  ])('labels %o', (reload, text, tone) => {
    expect(devStatusLabel({ entrypoint: 'refund_desk/agent.py', reload })).toEqual({ text, tone })
  })
})

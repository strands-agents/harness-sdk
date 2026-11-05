import { errorMessage } from '../tui/terminal/sanitize.js'
import type { DevReloadState } from './status.js'

export type ReloadOutcome = 'reloaded' | 'deferred' | 'cancelled'

export interface ReloaderOptions {
  readonly canReload: () => boolean
  readonly reload: () => Promise<ReloadOutcome>
  readonly onStatus: (state: DevReloadState) => void
  readonly retryMs?: number
  readonly settleMs?: number
}

export interface Reloader {
  request(): void
  close(): void
}

/** Run one reload at a time, never during active work, and keep every save that arrives meanwhile. */
export function createReloader(options: ReloaderOptions): Reloader {
  const { canReload, reload, retryMs = 250, settleMs = 5_000 } = options
  let pending = false
  let running = false
  let waiting = false
  let closed = false
  let retry: NodeJS.Timeout | undefined
  let settle: NodeJS.Timeout | undefined

  const status = (state: DevReloadState): void => {
    if (!closed) options.onStatus(state)
  }
  const schedule = (): void => {
    clearTimeout(retry)
    retry = setTimeout(attempt, retryMs).unref()
  }
  const settled = (outcome: ReloadOutcome): void => {
    if (closed) return
    if (outcome === 'deferred') {
      pending = true
    } else if (outcome === 'reloaded') {
      status({ kind: 'reloaded' })
      settle = setTimeout(() => status({ kind: 'watching' }), settleMs).unref()
    }
  }
  function attempt(): void {
    retry = undefined
    if (closed || running || !pending) return
    if (!canReload()) {
      if (!waiting) {
        clearTimeout(settle)
        status({ kind: 'pending' })
      }
      waiting = true
      schedule()
      return
    }
    pending = false
    waiting = false
    running = true
    clearTimeout(settle)
    status({ kind: 'reloading' })
    void reload()
      .then(settled, (error: unknown) => status({ kind: 'failed', message: errorMessage(error) }))
      .finally(() => {
        running = false
        if (pending) schedule()
      })
  }

  return {
    request: (): void => {
      if (closed) return
      pending = true
      attempt()
    },
    close: (): void => {
      closed = true
      clearTimeout(retry)
      clearTimeout(settle)
    },
  }
}

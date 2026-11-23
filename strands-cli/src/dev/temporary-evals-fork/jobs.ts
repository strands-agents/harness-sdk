import { open, readdir } from 'node:fs/promises'

import type { DevChatJob, DevChatJobs } from '../../ui/chat/types.js'
import { isRecord } from '../../values.js'

const TAIL_INTERVAL_MS = 1000
const COUNT_INTERVAL_MS = 500
const JOB_BATCH_MS = 200

export interface TemporaryStore<State> {
  subscribe(listener: () => void): () => void
  snapshot(): State
}

export class Store<State> implements TemporaryStore<State> {
  private readonly listeners = new Set<() => void>()

  constructor(private state: State) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly snapshot = (): State => this.state

  protected set(next: State): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }
}

const sameJobs = (left: readonly DevChatJob[], right: readonly DevChatJob[]): boolean =>
  left.length === right.length &&
  left.every(
    (job, index) =>
      job.id === right[index]?.id &&
      job.label === right[index]?.label &&
      job.done === right[index]?.done &&
      job.total === right[index]?.total &&
      job.waiting === right[index]?.waiting
  )

export const temporaryJobsFeed = <State>(
  store: TemporaryStore<State>,
  jobsOf: (state: State) => readonly DevChatJob[]
): DevChatJobs => {
  let state = store.snapshot()
  let jobs = jobsOf(state)
  const snapshot = (): readonly DevChatJob[] => {
    const latest = store.snapshot()
    if (latest === state) return jobs
    state = latest
    const next = jobsOf(latest)
    if (!sameJobs(next, jobs)) jobs = next
    return jobs
  }
  const subscribe = (listener: () => void): (() => void) => {
    let seen = snapshot()
    let timer: NodeJS.Timeout | undefined
    let last = 0
    const unsubscribe = store.subscribe(() => {
      if (snapshot() === seen || timer) return
      timer = setTimeout(
        () => {
          timer = undefined
          last = Date.now()
          seen = snapshot()
          listener()
        },
        Math.max(0, last + JOB_BATCH_MS - Date.now())
      )
      timer.unref()
    })
    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }
  return { subscribe, snapshot }
}

export interface TemporaryTail {
  stop(): Promise<void>
}

export const tailTemporaryLines = (path: string, onLine: (line: string) => void): TemporaryTail => {
  let offset = 0
  let partial = ''
  let reading: Promise<void> = Promise.resolve()
  const read = async (): Promise<void> => {
    let handle
    try {
      handle = await open(path, 'r')
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return
      throw error
    }
    try {
      const { size } = await handle.stat()
      if (size <= offset) return
      const buffer = Buffer.alloc(size - offset)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      offset += bytesRead
      const lines = (partial + buffer.subarray(0, bytesRead).toString('utf8')).split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) onLine(line)
    } finally {
      await handle.close()
    }
  }
  const tick = (): void => {
    reading = reading.then(read).catch(() => undefined)
  }
  const timer = setInterval(tick, TAIL_INTERVAL_MS)
  timer.unref()
  tick()
  return {
    stop: async (): Promise<void> => {
      clearInterval(timer)
      tick()
      await reading
      if (partial.trim()) onLine(partial)
      partial = ''
    },
  }
}

export const watchTemporaryFileCount = (folder: string, onCount: (count: number) => void): (() => void) => {
  let last = -1
  const count = async (): Promise<void> => {
    try {
      const found = (await readdir(folder)).filter((name) => name.endsWith('.json')).length
      if (found !== last) {
        last = found
        onCount(found)
      }
    } catch {
      return
    }
  }
  const timer = setInterval(() => void count(), COUNT_INTERVAL_MS)
  timer.unref()
  void count()
  return () => clearInterval(timer)
}

/** One jobs line for several feeds; the snapshot keeps its identity while no part changes. */
export const mergedJobsFeed = (...feeds: readonly DevChatJobs[]): DevChatJobs => {
  let parts = feeds.map((feed) => feed.snapshot())
  let jobs: readonly DevChatJob[] = parts.flat()
  return {
    snapshot: (): readonly DevChatJob[] => {
      const next = feeds.map((feed) => feed.snapshot())
      if (next.every((part, index) => part === parts[index])) return jobs
      parts = next
      jobs = next.flat()
      return jobs
    },
    subscribe: (listener: () => void): (() => void) => {
      const stops = feeds.map((feed) => feed.subscribe(listener))
      return () => stops.forEach((stop) => stop())
    },
  }
}

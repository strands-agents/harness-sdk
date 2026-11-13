import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  Store,
  tailTemporaryLines,
  temporaryJobsFeed,
  watchTemporaryFileCount,
} from '../../../src/dev/temporary-evals-fork/jobs.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

class Counter extends Store<{ readonly running: readonly string[]; readonly tick: number }> {
  constructor() {
    super({ running: [], tick: 0 })
  }

  start(name: string): void {
    this.set({ ...this.snapshot(), running: [...this.snapshot().running, name] })
  }

  touch(): void {
    this.set({ ...this.snapshot(), tick: this.snapshot().tick + 1 })
  }
}

const feedOf = (store: Counter) =>
  temporaryJobsFeed(store, ({ running }) => running.map((name) => ({ id: name, label: name })))

describe('temporaryJobsFeed', () => {
  it('shouldCallTheListenerOnceWhenJobsChangeInAFastBurst', async () => {
    vi.useFakeTimers()
    const store = new Counter()
    const feed = feedOf(store)
    const listener = vi.fn()
    feed.subscribe(listener)

    store.start('refunds')
    store.start('billing')
    await vi.advanceTimersByTimeAsync(250)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(feed.snapshot().map(({ id }) => id)).toEqual(['refunds', 'billing'])
    vi.useRealTimers()
  })

  it('shouldKeepTheSameSnapshotAndStayQuietWhenNothingAboutTheJobsChanges', async () => {
    vi.useFakeTimers()
    const store = new Counter()
    store.start('refunds')
    const feed = feedOf(store)
    const listener = vi.fn()
    feed.subscribe(listener)
    const before = feed.snapshot()

    store.touch()
    await vi.advanceTimersByTimeAsync(250)

    expect(feed.snapshot()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('shouldStopCallingTheListenerWhenItUnsubscribes', async () => {
    vi.useFakeTimers()
    const store = new Counter()
    const feed = feedOf(store)
    const listener = vi.fn()
    const unsubscribe = feed.subscribe(listener)

    store.start('refunds')
    unsubscribe()
    await vi.advanceTimersByTimeAsync(250)

    expect(listener).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

describe('tailTemporaryLines', () => {
  it('shouldDeliverEachCompleteLineOnceWhenTheFileGrows', async () => {
    const path = join(await temporaryDirectory(), 'study.jsonl')
    const lines: string[] = []
    await writeFile(path, '{"type":"study"}\n{"type":')

    const tail = tailTemporaryLines(path, (line) => lines.push(line))
    await vi.waitFor(() => expect(lines).toEqual(['{"type":"study"}']))
    await appendFile(path, '"run"}\n')
    await vi.waitFor(() => expect(lines).toEqual(['{"type":"study"}', '{"type":"run"}']))
    await tail.stop()

    expect(lines).toEqual(['{"type":"study"}', '{"type":"run"}'])
  })

  it('shouldWaitWithoutFailingWhenTheFileDoesNotExistYet', async () => {
    const path = join(await temporaryDirectory(), 'later', 'study.jsonl')
    const lines: string[] = []

    const tail = tailTemporaryLines(path, (line) => lines.push(line))
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, '{"type":"study"}\n')
    await tail.stop()

    expect(lines).toEqual(['{"type":"study"}'])
  })
})

describe('watchTemporaryFileCount', () => {
  it('shouldReportTheNumberOfFinishedCaseFilesWhenTheFolderFills', async () => {
    const folder = join(await temporaryDirectory(), 'cases')
    const counts: number[] = []

    const stop = watchTemporaryFileCount(folder, (count) => counts.push(count))
    await mkdir(folder)
    await writeFile(join(folder, 'c0.json'), '{}')
    await writeFile(join(folder, 'c1.json'), '{}')
    await vi.waitFor(() => expect(counts.at(-1)).toBe(2))
    stop()

    expect(counts).not.toContain(3)
  })
})

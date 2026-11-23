import { describe, expect, it } from 'vitest'

import { mergedJobsFeed } from '../../../src/dev/temporary-evals-fork/jobs.js'
import type { DevChatJob, DevChatJobs } from '../../../src/ui/chat/types.js'

const feed = (initial: readonly DevChatJob[]) => {
  let jobs = initial
  const listeners = new Set<() => void>()
  const jobsFeed: DevChatJobs = {
    snapshot: () => jobs,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const set = (next: readonly DevChatJob[]): void => {
    jobs = next
    listeners.forEach((listener) => listener())
  }
  return { jobsFeed, set, listeners }
}

describe('mergedJobsFeed', () => {
  it('shouldListTheJobsOfEveryFeedInOrder', () => {
    const generations = feed([{ id: 'gen-1', label: 'refunds' }])
    const evaluations = feed([{ id: '/w/capital.json', label: 'capital', done: 1, total: 4 }])

    const merged = mergedJobsFeed(generations.jobsFeed, evaluations.jobsFeed)

    expect(merged.snapshot().map(({ id }) => id)).toEqual(['gen-1', '/w/capital.json'])
  })

  it('shouldKeepTheSnapshotIdentityUntilAPartChanges', () => {
    const generations = feed([])
    const evaluations = feed([])
    const merged = mergedJobsFeed(generations.jobsFeed, evaluations.jobsFeed)

    const first = merged.snapshot()
    expect(merged.snapshot()).toBe(first)

    evaluations.set([{ id: '/w/capital.json', label: 'capital' }])
    expect(merged.snapshot()).not.toBe(first)
  })

  it('shouldHearEveryFeedAndStopHearingThemAll', () => {
    const generations = feed([])
    const evaluations = feed([])
    const merged = mergedJobsFeed(generations.jobsFeed, evaluations.jobsFeed)
    let heard = 0

    const stop = merged.subscribe(() => {
      heard += 1
    })
    generations.set([{ id: 'gen-1', label: 'refunds' }])
    evaluations.set([{ id: '/w/capital.json', label: 'capital' }])
    stop()

    expect(heard).toBe(2)
    expect(generations.listeners.size + evaluations.listeners.size).toBe(0)
  })
})

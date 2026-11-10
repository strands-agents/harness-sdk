import { describe, it, expect } from 'vitest'
import { deriveEntries, previousTagInStream } from '../../scripts/changelog/derive-entries'

describe('derive-entries', () => {
  // --- deriveEntries -----------------------------------------------------------

  it('derives parsed-line entries from compare commits via commit->PR', async () => {
    const client = {
      compareCommits: async () => ({
        commits: [{ sha: 'a1' }, { sha: 'b2' }],
        truncated: false,
      }),
      commitPulls: async (_repo: any, sha: string) =>
        sha === 'a1'
          ? [{ number: 1799, title: 'feat(model): add service_tier', user: 'pgrayy' }]
          : [{ number: 2087, title: 'fix: enforce user-first message', user: 'lizradway' }],
    }
    const { entries, truncated } = await deriveEntries({
      repo: 'strands-agents/harness-sdk',
      base: 'python/v1.34.1',
      head: 'python/v1.35.0',
      client: client as any,
    })
    expect(truncated).toBe(false)
    expect(entries).toEqual([
      {
        type: 'feat',
        scope: 'model',
        breaking: false,
        title: 'add service_tier',
        author: 'pgrayy',
        pr: 1799,
        prRepo: 'strands-agents/harness-sdk',
      },
      {
        type: 'fix',
        scope: null,
        breaking: false,
        title: 'enforce user-first message',
        author: 'lizradway',
        pr: 2087,
        prRepo: 'strands-agents/harness-sdk',
      },
    ])
  })

  it('dedups a PR that spans multiple commits', async () => {
    const client = {
      compareCommits: async () => ({ commits: [{ sha: 'a1' }, { sha: 'a2' }], truncated: false }),
      commitPulls: async () => [{ number: 500, title: 'feat: x', user: 'a' }], // same PR on both commits
    }
    const { entries } = await deriveEntries({ repo: 'r', base: 'v1', head: 'v2', client: client as any })
    expect(entries.length).toBe(1)
    expect(entries[0].pr).toBe(500)
  })

  it('skips commits with no associated PR (direct push)', async () => {
    const client = {
      compareCommits: async () => ({ commits: [{ sha: 'a1' }, { sha: 'a2' }], truncated: false }),
      commitPulls: async (_r: any, sha: string) => (sha === 'a1' ? [{ number: 7, title: 'fix: y', user: 'b' }] : []),
    }
    const { entries } = await deriveEntries({ repo: 'r', base: 'v1', head: 'v2', client: client as any })
    expect(entries.map((e) => e.pr)).toEqual([7])
  })

  it('no prior tag -> no entries, with a warning', async () => {
    const { entries, warning } = await deriveEntries({ repo: 'r', base: null, head: 'v0.1.0', client: {} as any })
    expect(entries).toEqual([])
    expect(warning).toMatch(/no prior tag/)
  })

  it('truncated compare range yields a warning', async () => {
    const client = {
      compareCommits: async () => ({ commits: [{ sha: 'a1' }], truncated: true }),
      commitPulls: async () => [{ number: 1, title: 'feat: z', user: 'c' }],
    }
    const { truncated, warning } = await deriveEntries({ repo: 'r', base: 'v1', head: 'v2', client: client as any })
    expect(truncated).toBe(true)
    expect(warning).toMatch(/250-commit cap/)
  })

  it('processes every commit in a large (paginated) range -- no downstream cap', async () => {
    // The client paginates compare; deriveEntries must emit an entry for each of
    // the >100 commits it returns (guards against a regression to first-page-only).
    const N = 230
    const commits = Array.from({ length: N }, (_, i) => ({ sha: `s${i}` }))
    const client = {
      compareCommits: async () => ({ commits, truncated: false }),
      commitPulls: async (_r: any, sha: string) => [
        { number: Number(sha.slice(1)) + 1, title: `feat: c${sha}`, user: 'a' },
      ],
    }
    const { entries } = await deriveEntries({ repo: 'r', base: 'v1', head: 'v2', client: client as any })
    expect(entries.length).toBe(N)
  })

  // --- previousTagInStream -----------------------------------------------------

  const harnessTags = (names: string[]) => ({ listTags: async () => names.map((name) => ({ name })) })

  it('finds the immediate predecessor in the python stream', async () => {
    const client = harnessTags([
      'python/v1.36.0',
      'python/v1.35.0',
      'python/v1.34.1',
      'typescript/v1.5.0',
      'python/v1.34.0',
    ])
    const prior = await previousTagInStream('strands-agents/harness-sdk', 'python/v1.35.0', client)
    expect(prior).toBe('python/v1.34.1')
  })

  it('ignores tags from other streams', async () => {
    // typescript tags must not be chosen as the prior for a python release
    const client = harnessTags(['typescript/v1.9.0', 'python/v1.20.0', 'typescript/v1.8.0'])
    const prior = await previousTagInStream('strands-agents/harness-sdk', 'python/v1.21.0', client)
    expect(prior).toBe('python/v1.20.0')
  })

  it('orders numerically, not lexically (v1.9.0 precedes v1.10.0)', async () => {
    const client = harnessTags(['python/v1.10.0', 'python/v1.9.0', 'python/v1.8.0'])
    const prior = await previousTagInStream('strands-agents/harness-sdk', 'python/v1.10.0', client)
    expect(prior).toBe('python/v1.9.0')
  })

  it('returns null for the first release in a stream', async () => {
    const client = harnessTags(['python/v1.0.0', 'typescript/v0.5.0'])
    const prior = await previousTagInStream('strands-agents/harness-sdk', 'python/v1.0.0', client)
    expect(prior).toBe(null)
  })

  it('evals bare-v stream resolves its own predecessor', async () => {
    const client = { listTags: async () => ['v0.2.0', 'v0.1.17', 'v0.1.16'].map((name) => ({ name })) }
    const prior = await previousTagInStream('strands-agents/evals', 'v0.2.0', client)
    expect(prior).toBe('v0.1.17')
  })
})

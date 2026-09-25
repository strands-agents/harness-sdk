import { describe, it, expect } from 'vitest'
import { run } from '../../scripts/changelog/run'
import type { Client } from '../../scripts/changelog/types'

// Entries are now sourced from the compare API (commits between the prior tag
// and this one, each resolved to a PR), not parsed from the release body. The
// fake client below provides listReleases/getRelease plus the compare surface:
// listTags (prior-tag detection), compareCommits, and commitPulls.

const releases = [
  { tag_name: 'python/v1.42.0', published_at: '2026-06-01T00:00:00Z', html_url: 'h1', body: '' },
  { tag_name: 'python/v1.41.0', published_at: '2026-05-21T00:00:00Z', html_url: 'h0', body: '' },
  { tag_name: 'python-wasm/v0.0.1', published_at: '2026-06-02T00:00:00Z', html_url: 'h2', body: '' },
]

function fakeClient(overrides = {}): Client {
  return {
    listReleases: async () => releases,
    getRelease: async (_r: string, tag: string) => releases.find((x) => x.tag_name === tag) || null,
    listTags: async () => releases.map((r) => ({ name: r.tag_name })),
    // One PR (#1) merged between v1.41.0 and v1.42.0.
    compareCommits: async (_r: string, base: string, head: string) =>
      base === 'python/v1.41.0' && head === 'python/v1.42.0'
        ? { commits: [{ sha: 's1' }], truncated: false }
        : { commits: [], truncated: false },
    commitPulls: async (_r: string, sha: string) => (sha === 's1' ? [{ number: 1, title: 'feat: a', user: 'x' }] : []),
    getPr: async () => ({ labels: ['area-model'], merge_commit_sha: 'abc1234', user: 'x', files: ['strands-py/a.py'] }),
    ...overrides,
  } as Client
}

describe('run', () => {
  it('backfill writes one file per in-scope release with compare-derived entries', async () => {
    const written: Record<string, string> = {}
    const res = await run({
      repo: 'strands-agents/harness-sdk',
      mode: 'backfill',
      client: fakeClient(),
      readExisting: async () => null,
      writeFile: async (p, c) => {
        written[p] = c
      },
    })
    // python-wasm is out of scope; v1.41.0 is the first in-scope release (no prior
    // tag -- no entries) but still gets a file; v1.42.0 gets the derived entry.
    expect(written['site/src/content/changelog/sdk/python-v1.42.0.md']).toBeTruthy()
    expect(written['site/src/content/changelog/sdk/python-v1.42.0.md']).toMatch(/title: "a"/)
    // enrichment landed: area-model label -> areas: [model]
    expect(written['site/src/content/changelog/sdk/python-v1.42.0.md']).toMatch(/areas: \[model\]/)
    expect(Object.keys(written).some((p) => p.includes('wasm'))).toBe(false)
  })

  it('skipExisting skips releases with files and never calls enrichment for them', async () => {
    let prCalls = 0
    const client = fakeClient({
      getPr: async () => {
        prCalls++
        return { labels: [], merge_commit_sha: 'abc1234', user: 'x' }
      },
    })
    const res = await run({
      repo: 'strands-agents/harness-sdk',
      mode: 'backfill',
      skipExisting: true,
      client,
      readExisting: async () => '---\nsdk: sdk\n---\n', // every file already exists
      writeFile: async () => {},
    })
    expect(res.written).toEqual([])
    expect(prCalls).toBe(0) // existence checked BEFORE enrichment
  })

  it('single mode writes only the given tag', async () => {
    const written: Record<string, string> = {}
    await run({
      repo: 'strands-agents/harness-sdk',
      mode: 'single',
      tag: 'python/v1.42.0',
      client: fakeClient(),
      readExisting: async () => null,
      writeFile: async (p, c) => {
        written[p] = c
      },
    })
    expect(Object.keys(written)).toEqual(['site/src/content/changelog/sdk/python-v1.42.0.md'])
  })

  it('single mode with unknown tag writes nothing and warns', async () => {
    const written: Record<string, string> = {}
    const res = await run({
      repo: 'strands-agents/harness-sdk',
      mode: 'single',
      tag: 'python/v9.9.9',
      client: fakeClient(),
      readExisting: async () => null,
      writeFile: async (p, c) => {
        written[p] = c
      },
    })
    expect(Object.keys(written)).toEqual([])
    expect(res.written).toEqual([])
    expect(res.warnings[0]).toMatch(/no release found for tag "python\/v9\.9\.9"/)
  })

  it('keeps a prerelease whose tag maps to a recognized version (rc releases are first-class)', async () => {
    // A GitHub release flagged prerelease=true but tagged as a real stream
    // version (typescript rc) must still produce a changelog file -- inclusion
    // must not hinge on the publisher's "pre-release" checkbox.
    const pre = [
      {
        tag_name: 'typescript/v1.7.0-rc.0',
        published_at: '2026-06-01T00:00:00Z',
        html_url: 'h',
        prerelease: true,
        body: '',
      },
      {
        tag_name: 'typescript/v1.6.0',
        published_at: '2026-05-01T00:00:00Z',
        html_url: 'h0',
        prerelease: false,
        body: '',
      },
    ]
    const client = fakeClient({
      listReleases: async () => pre,
      getRelease: async () => null,
      listTags: async () => pre.map((r) => ({ name: r.tag_name })),
      compareCommits: async (_r: string, _base: string, head: string) =>
        head === 'typescript/v1.7.0-rc.0'
          ? { commits: [{ sha: 'sx' }], truncated: false }
          : { commits: [], truncated: false },
      commitPulls: async (_r: string, sha: string) =>
        sha === 'sx' ? [{ number: 9, title: 'feat: rc thing', user: 'x' }] : [],
    })
    const written: Record<string, string> = {}
    await run({
      repo: 'strands-agents/harness-sdk',
      mode: 'backfill',
      client,
      readExisting: async () => null,
      writeFile: async (p, c) => {
        written[p] = c
      },
    })
    expect(written['site/src/content/changelog/sdk/typescript-v1.7.0-rc.0.md']).toBeTruthy()
  })

  it('drops a flagged prerelease whose tag is not a recognized version', async () => {
    // The prerelease flag still excludes oddball/non-stream tags.
    const pre = [
      { tag_name: 'nightly-20260601', published_at: '2026-06-01T00:00:00Z', html_url: 'h', prerelease: true, body: '' },
    ]
    const client = fakeClient({ listReleases: async () => pre, getRelease: async () => null })
    const res = await run({
      repo: 'strands-agents/harness-sdk',
      mode: 'backfill',
      client,
      readExisting: async () => null,
      writeFile: async () => {
        throw new Error('must not write')
      },
    })
    expect(res.written).toEqual([])
  })

  it('memoizes PR fetches across entries and newContributors', async () => {
    let prCalls = 0
    const rel = [
      {
        tag_name: 'python/v9.0.0',
        published_at: '2026-06-01T00:00:00Z',
        html_url: 'h',
        body: '## New Contributors\n* @newdev made their first contribution in https://github.com/strands-agents/harness-sdk/pull/7',
      },
      { tag_name: 'python/v8.9.0', published_at: '2026-05-01T00:00:00Z', html_url: 'h0', body: '' },
    ]
    const client = fakeClient({
      listReleases: async () => rel,
      getRelease: async () => null,
      listTags: async () => rel.map((r: { tag_name: string }) => ({ name: r.tag_name })),
      compareCommits: async (_r: string, base: string, head: string) =>
        head === 'python/v9.0.0' ? { commits: [{ sha: 's7' }], truncated: false } : { commits: [], truncated: false },
      commitPulls: async (_r: string, sha: string) =>
        sha === 's7' ? [{ number: 7, title: 'feat: thing', user: 'newdev' }] : [],
      getPr: async () => {
        prCalls++
        return { labels: [], merge_commit_sha: 'abc1234', user: 'newdev', files: ['strands-py/x.py'] }
      },
    })
    await run({
      repo: 'strands-agents/harness-sdk',
      mode: 'backfill',
      client,
      readExisting: async () => null,
      writeFile: async () => {},
    })
    expect(prCalls).toBe(1) // entry (#7) + contributor (#7) gating share one fetch
  })

  it('skips draft releases (null published_at) without crashing', async () => {
    const withDraft = [
      { tag_name: 'v1.0.0', published_at: null, html_url: 'h', body: '' },
      { tag_name: 'v0.9.0', published_at: '2026-01-01T00:00:00Z', html_url: 'h', body: '' },
    ]
    const client = fakeClient({
      listReleases: async () => withDraft,
      getRelease: async () => null,
      listTags: async () => withDraft.map((r: { tag_name: string }) => ({ name: r.tag_name })),
    })
    const written: Record<string, string> = {}
    const res = await run({
      repo: 'strands-agents/evals',
      mode: 'backfill',
      client,
      readExisting: async () => null,
      writeFile: async (p, c) => {
        written[p] = c
      },
    })
    // only the published one is written
    expect(res.written).toEqual(['site/src/content/changelog/evals/v0.9.0.md'])
  })

  it('surfaces a truncated-compare warning', async () => {
    const rel = [
      { tag_name: 'python/v2.0.0', published_at: '2026-01-02T00:00:00Z', html_url: 'h', body: '' },
      { tag_name: 'python/v1.0.0', published_at: '2026-01-01T00:00:00Z', html_url: 'h0', body: '' },
    ]
    const client = fakeClient({
      listReleases: async () => rel,
      getRelease: async () => null,
      listTags: async () => rel.map((r: { tag_name: string }) => ({ name: r.tag_name })),
      compareCommits: async () => ({ commits: [{ sha: 's1' }], truncated: true }),
      commitPulls: async () => [{ number: 1, title: 'feat: x', user: 'a' }],
    })
    const res = await run({
      repo: 'strands-agents/harness-sdk',
      mode: 'backfill',
      client,
      readExisting: async () => null,
      writeFile: async () => {},
    })
    expect(res.warnings.some((w) => /250-commit cap/.test(w))).toBe(true)
  })
})

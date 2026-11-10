import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { buildStats, loadEntries, type StatsFetchers, type StatsEntry } from '../scripts/catalog/refresh-stats'

const entries: StatsEntry[] = [
  {
    id: 'strands-example',
    github: 'https://github.com/example/strands-example',
    python: 'strands-example',
    typescript: '@example/strands',
  },
  { id: 'strands-broken', github: 'https://github.com/example/strands-broken', python: 'strands-broken' },
]

function fetchers(overrides: Partial<StatsFetchers> = {}): StatsFetchers {
  return {
    githubRepo: async () => ({ stars: 42 }),
    pypiDownloads: async () => 100,
    npmDownloads: async () => 50,
    ...overrides,
  }
}

describe('buildStats', () => {
  it('aggregates stats per entry', async () => {
    const stats = await buildStats(entries, fetchers())
    expect(stats['strands-example']).toEqual({
      stars: 42,
      downloads: { python: 100, typescript: 50 },
    })
    expect(stats['strands-broken']).toEqual({ stars: 42, downloads: { python: 100 } })
  })

  it('skips failing sources without failing the run', async () => {
    const stats = await buildStats(
      entries,
      fetchers({
        githubRepo: async (repo) => {
          if (repo.includes('broken')) throw new Error('boom')
          return { stars: 42 }
        },
        pypiDownloads: async (pkg) => {
          if (pkg === 'strands-broken') throw new Error('boom')
          return 100
        },
      })
    )
    expect(stats['strands-example']?.stars).toBe(42)
    expect(stats['strands-broken']).toEqual({ downloads: {} })
  })

  it('keeps the previous value for a failing source while successful sources refresh', async () => {
    const previous = {
      'strands-example': {
        stars: 40,
        downloads: { python: 90, typescript: 45 },
      },
    }
    const stats = await buildStats(
      [entries[0]!],
      fetchers({
        pypiDownloads: async () => {
          throw new Error('rate limited')
        },
      }),
      previous
    )
    expect(stats['strands-example']).toEqual({
      stars: 42,
      downloads: { python: 90, typescript: 50 },
    })
  })

  it('treats malformed payloads as failures and keeps the previous values', async () => {
    const previous = {
      'strands-example': { stars: 40, downloads: { python: 90, typescript: 45 } },
    }
    const stats = await buildStats(
      [entries[0]!],
      fetchers({
        // Upstream returned 200 with garbage: non-numeric, NaN, negative.
        githubRepo: async () => ({ stars: 'lots' }) as unknown as { stars: number },
        pypiDownloads: async () => Number.NaN,
        npmDownloads: async () => -5,
      }),
      previous
    )
    expect(stats['strands-example']).toEqual({
      stars: 40,
      downloads: { python: 90, typescript: 45 },
    })
  })

  it('keeps previous github stats when the github fetch fails', async () => {
    const previous = {
      'strands-example': { stars: 40, downloads: { python: 90 } },
    }
    const stats = await buildStats(
      [entries[0]!],
      fetchers({
        githubRepo: async () => {
          throw new Error('boom')
        },
      }),
      previous
    )
    expect(stats['strands-example']).toEqual({
      stars: 40,
      downloads: { python: 100, typescript: 50 },
    })
  })
})

describe('loadEntries', () => {
  it('skips download stats for extras-qualified pypi packages but keeps the github repo', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'catalog-'))
    try {
      writeFileSync(
        path.join(dir, 'temporal.yaml'),
        [
          'name: temporal',
          'github: https://github.com/temporalio/sdk-python',
          'languages:',
          '  python:',
          '    package: temporalio[strands-agents]',
        ].join('\n')
      )
      expect(loadEntries(dir)).toEqual([{ id: 'temporal', github: 'https://github.com/temporalio/sdk-python' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips github stats for guide-only entries whose repo is the vendor product', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'catalog-'))
    try {
      writeFileSync(
        path.join(dir, 'vendor-guide.yaml'),
        ['name: vendor-guide', 'github: https://github.com/example/vendor-product', 'languages:', '  python: {}'].join(
          '\n'
        )
      )
      expect(loadEntries(dir)).toEqual([{ id: 'vendor-guide' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

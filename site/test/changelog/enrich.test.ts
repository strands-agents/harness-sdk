import { describe, it, expect } from 'vitest'
import { enrichFromPr } from '../../scripts/changelog/enrich'

describe('enrich', () => {
  it('extracts areas, commit, author', async () => {
    const fetcher = async (repo: string, num: number) => {
      expect(repo).toBe('strands-agents/harness-sdk')
      expect(num).toBe(2287)
      return {
        labels: ['enhancement', 'python', 'area-model', 'area-otel', 'size/xs'],
        merge_commit_sha: '155239dca769c8eea7652b2496822ea47283a1a9',
        user: 'yatszhash',
      }
    }
    const e = await enrichFromPr('strands-agents/harness-sdk', 2287, fetcher)
    expect(e.areas).toEqual(['model', 'otel'])
    expect(e.breaking).toBe(false)
    expect(e.commit).toBe('155239d')
    expect(e.author).toBe('yatszhash')
  })

  it('detects breaking label', async () => {
    const f = async () => ({ labels: ['breaking change'], merge_commit_sha: 'abcdef0123', user: 'x' })
    const e = await enrichFromPr('r', 1, f)
    expect(e.breaking).toBe(true)
  })

  it('missing pr degrades gracefully (fetcher returns null)', async () => {
    const f = async () => null
    const e = await enrichFromPr('r', 1, f)
    expect(e).toEqual({ areas: [], breaking: false, commit: null, author: null, streams: null, docsOnly: false })
  })

  it('docsOnly true when every file is under site/ or docs/', async () => {
    const f = async () => ({
      labels: [],
      merge_commit_sha: 'abc1234',
      user: 'x',
      files: ['site/src/content/blog/post.md', 'docs/guide.md'],
    })
    const e = await enrichFromPr('r', 1, f)
    expect(e.docsOnly).toBe(true)
  })

  it('docsOnly false when a PR also touches code', async () => {
    const f = async () => ({
      labels: [],
      merge_commit_sha: 'abc1234',
      user: 'x',
      files: ['site/blog/post.md', 'strands-py/src/agent.py'],
    })
    const e = await enrichFromPr('r', 1, f)
    expect(e.docsOnly).toBe(false)
  })

  it('docsOnly false on unknown or empty file info (do not drop)', async () => {
    const unknown = await enrichFromPr('r', 1, async () => ({ labels: [], merge_commit_sha: 'a', user: 'x' }))
    expect(unknown.docsOnly).toBe(false)
    const empty = await enrichFromPr('r', 1, async () => ({ labels: [], merge_commit_sha: 'a', user: 'x', files: [] }))
    expect(empty.docsOnly).toBe(false)
  })

  it('docsOnly true for top-level doc files (README, AGENTS.md, CONTRIBUTING)', async () => {
    const f = async () => ({
      labels: [],
      merge_commit_sha: 'a',
      user: 'x',
      files: ['README.md', 'AGENTS.md', 'CONTRIBUTING'],
    })
    const e = await enrichFromPr('r', 1, f)
    expect(e.docsOnly).toBe(true)
  })

  it('docsOnly false when a root doc PR also touches code', async () => {
    const f = async () => ({
      labels: [],
      merge_commit_sha: 'a',
      user: 'x',
      files: ['README.md', 'strands-py/src/agent.py'],
    })
    const e = await enrichFromPr('r', 1, f)
    expect(e.docsOnly).toBe(false)
  })

  it('docsOnly false for a top-level non-doc file (e.g. pyproject.toml)', async () => {
    // A root config/build file is not docs -- don't drop a release-affecting change.
    const f = async () => ({ labels: [], merge_commit_sha: 'a', user: 'x', files: ['pyproject.toml'] })
    const e = await enrichFromPr('r', 1, f)
    expect(e.docsOnly).toBe(false)
  })

  it('no merge sha yields null commit', async () => {
    const f = async () => ({ labels: [], merge_commit_sha: null, user: null })
    const e = await enrichFromPr('r', 1, f)
    expect(e.commit).toBe(null)
    expect(e.author).toBe(null)
  })

  it('derives streams from monorepo top-level dirs', async () => {
    const f = async () => ({
      labels: [],
      merge_commit_sha: 'abc1234',
      user: 'x',
      files: ['strands-py/src/agent.py', 'strands-py/tests/t.py'],
    })
    const e = await enrichFromPr('r', 1, f)
    expect(e.streams).toEqual(['sdk:python'])
  })

  it('PR touching both sdk dirs yields both streams', async () => {
    const f = async () => ({
      labels: [],
      merge_commit_sha: 'abc1234',
      user: 'x',
      files: ['strands-py/a.py', 'strands-ts/b.ts'],
    })
    const e = await enrichFromPr('r', 1, f)
    expect(e.streams!.sort()).toEqual(['sdk:python', 'sdk:typescript'])
  })

  it('site/ci/docs-only PR yields empty streams', async () => {
    const f = async () => ({
      labels: [],
      merge_commit_sha: 'abc1234',
      user: 'x',
      files: ['site/src/page.astro', '.github/workflows/x.yml', 'designs/d.md'],
    })
    const e = await enrichFromPr('r', 1, f)
    expect(e.streams).toEqual([])
  })

  it('missing files info yields null streams (unknown -- keep everywhere)', async () => {
    const f = async () => ({ labels: [], merge_commit_sha: 'abc1234', user: 'x' })
    const e = await enrichFromPr('r', 1, f)
    expect(e.streams).toBe(null)
  })

  it('maps harness, cli, and mcp dirs to their own streams', async () => {
    const cases: Array<[string, string]> = [
      ['harness-py/src/strands_harness/harness.py', 'harness:python'],
      ['harness-ts/src/index.ts', 'harness:typescript'],
      ['strands-cli/src/main.ts', 'cli'],
      ['strands-mcp/src/server.py', 'mcp'],
    ]
    for (const [file, stream] of cases) {
      const e = await enrichFromPr('r', 1, async () => ({
        labels: [],
        merge_commit_sha: 'abc1234',
        user: 'x',
        files: [file],
      }))
      expect(e.streams, file).toEqual([stream])
    }
  })

  it('a root-npm-lockfile-only PR is attributed to typescript', async () => {
    // Guards the leak in the python/v1.51.0 changelog sync (#3712): five npm bumps
    // that touch only the root lockfile were listed on the python stream.
    const npmBump = async () => ({
      labels: [],
      merge_commit_sha: 'abc1234',
      user: 'dependabot[bot]',
      files: ['package-lock.json'],
    })
    expect((await enrichFromPr('r', 1, npmBump)).streams).toEqual(['sdk:typescript'])
  })

  it('a root lockfile alongside SDK code keeps the dir signal', async () => {
    const f = async () => ({
      labels: [],
      merge_commit_sha: 'abc1234',
      user: 'x',
      files: ['package-lock.json', 'strands-py/pyproject.toml'],
    })
    const e = await enrichFromPr('r', 1, f)
    expect(e.streams).toEqual(['sdk:python'])
  })

  it('root manifests and non-root lockfiles stay language-neutral', async () => {
    // package.json/pyproject.toml configure repo-wide tooling, and a nested
    // lockfile belongs to its own dir (site = docs, .github = ci).
    const files = [
      'package.json',
      'pyproject.toml',
      'site/package-lock.json',
      '.github/scripts/pr-metrics/tools/package-lock.json',
    ]
    for (const file of files) {
      const e = await enrichFromPr('r', 1, async () => ({
        labels: [],
        merge_commit_sha: 'abc1234',
        user: 'x',
        files: [file],
      }))
      expect(e.streams, file).toEqual([])
    }
  })

  it('a lockfile bump carrying any other file stays language-neutral', async () => {
    const f = async () => ({
      labels: [],
      merge_commit_sha: 'abc1234',
      user: 'x',
      files: ['package-lock.json', '.github/workflows/ci.yml'],
    })
    const e = await enrichFromPr('r', 1, f)
    expect(e.streams).toEqual([])
  })
})

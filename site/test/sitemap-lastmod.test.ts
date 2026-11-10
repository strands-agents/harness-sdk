import { describe, it, expect } from 'vitest'
import { urlToContentPaths, newestDateUnder } from '../src/plugins/sitemap-lastmod'

// The sitemap lastmod lookup matches URLs against keys produced by
// `git log --name-only`, which are repo-root-relative with forward slashes
// (e.g. `site/src/content/...` when the build runs from `site/`). These cases
// lock in that path space so a future change can't silently reintroduce the
// prefix/separator mismatch this plugin exists to avoid.
describe('urlToContentPaths', () => {
  it('builds repo-root-relative candidates with the git prefix', () => {
    expect(urlToContentPaths('/docs/user-guide/quickstart/python/', 'src/content', 'site/')).toEqual([
      'site/src/content/docs/user-guide/quickstart/python.mdx',
      'site/src/content/docs/user-guide/quickstart/python.md',
      'site/src/content/docs/user-guide/quickstart/python/index.mdx',
      'site/src/content/docs/user-guide/quickstart/python/index.md',
      'site/src/content/docs/user-guide/quickstart/python/README.mdx',
      'site/src/content/docs/user-guide/quickstart/python/README.md',
    ])
  })

  it('omits the prefix when built from the repo root (empty gitPrefix)', () => {
    expect(urlToContentPaths('/changelog/sdk/python-v1.43.0/', 'src/content', '')).toEqual([
      'src/content/changelog/sdk/python-v1.43.0.mdx',
      'src/content/changelog/sdk/python-v1.43.0.md',
      'src/content/changelog/sdk/python-v1.43.0/index.mdx',
      'src/content/changelog/sdk/python-v1.43.0/index.md',
      'src/content/changelog/sdk/python-v1.43.0/README.mdx',
      'src/content/changelog/sdk/python-v1.43.0/README.md',
    ])
  })

  it('always emits forward slashes regardless of platform', () => {
    // path.posix.join keeps `/` so candidates match git output on Windows too.
    for (const candidate of urlToContentPaths('/docs/a/b/', 'src/content', 'site/')) {
      expect(candidate).not.toContain('\\')
    }
  })
})

describe('newestDateUnder', () => {
  it('compares dates numerically across mixed UTC offsets', () => {
    // git log %cI emits committer-local offsets: 09:00+09:00 is 00:00 UTC,
    // so the -07:00 entry is newer despite sorting earlier as a string.
    const map = new Map([
      ['site/src/content/blog/a.mdx', '2026-07-10T09:00:00+09:00'],
      ['site/src/content/blog/b.mdx', '2026-07-10T08:00:00-07:00'],
    ])

    expect(newestDateUnder(map, 'site/src/content/blog/')).toBe('2026-07-10T08:00:00-07:00')
  })

  it('only considers entries under the prefix', () => {
    const map = new Map([
      ['site/src/content/blog/a.mdx', '2026-07-01T00:00:00Z'],
      ['site/src/content/changelog/b.md', '2026-07-15T00:00:00Z'],
    ])

    expect(newestDateUnder(map, 'site/src/content/blog/')).toBe('2026-07-01T00:00:00Z')
  })

  it('returns undefined when nothing matches or dates are unparseable', () => {
    const map = new Map([['site/src/content/blog/a.mdx', 'not-a-date']])

    expect(newestDateUnder(map, 'site/src/content/blog/')).toBeUndefined()
    expect(newestDateUnder(new Map(), 'site/src/content/')).toBeUndefined()
  })
})

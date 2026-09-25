import { describe, it, expect } from 'vitest'
import { buildReleaseFile } from '../../scripts/changelog/build-release-file'
import { classifyTitle } from '../../scripts/changelog/parse-release-body'
import { enrichFromPr } from '../../scripts/changelog/enrich'
import type { BuildDeps } from '../../scripts/changelog/build-release-file'

// buildReleaseFile sources entries from deps.deriveEntries (compare-driven), not
// from the release body. These tests describe the desired entry set as a bullet
// body for readability; this local helper turns that bullet body into the
// parsed-line shape deriveEntries returns, so the tests exercise the same
// downstream enrichment + gating the real derive feeds. (It is NOT the
// production path -- that reads the compare API.)
const BULLET =
  /^\s*[-*]\s+(.*?)(?:\s+by\s+@([\w-]+(?:\[[\w-]+\])?))?\s+in\s+https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\s*$/
const parseBulletBody = (body: string | null | undefined) =>
  String(body || '')
    .split('\n')
    .map((line) => line.match(BULLET))
    .filter((m): m is RegExpMatchArray => m !== null && !/made their first contribution/.test(m[0]))
    .map((m) => ({ ...classifyTitle(m[1]), author: m[2] || null, pr: Number(m[4]), prRepo: m[3] }))
const bodyDerive = async (_repo: string, release: { body: string | null }) => ({
  entries: parseBulletBody(release.body),
  warning: undefined,
})

const release = {
  tag_name: 'python/v1.42.0',
  published_at: '2026-06-01T18:18:57Z',
  html_url: 'https://github.com/strands-agents/harness-sdk/releases/tag/python%2Fv1.42.0',
  body: "## What's Changed\n* feat(model): plumb cache tokens by @yatszhash in https://github.com/strands-agents/sdk-python/pull/2287\n",
}

describe('build-release-file', () => {
  it('produces correct path + parsed/enriched contents', async () => {
    const result = await buildReleaseFile('strands-agents/harness-sdk', release, {
      enrich: async () => ({
        areas: ['model'],
        breaking: false,
        commit: '155239d',
        author: 'yatszhash',
        languages: null,
        docsOnly: false,
      }),
      deriveEntries: bodyDerive,
      readExisting: async () => null,
    } as any)
    expect(result!.path).toBe('site/src/content/changelog/sdk/python-v1.42.0.md')
    expect(result!.contents).toMatch(/sdk: sdk/)
    expect(result!.contents).toMatch(/title: "plumb cache tokens"/)
    expect(result!.contents).toMatch(/areas: \[model\]/)
    // prUrl/commitUrl use the PR's own repo (sdk-python), not harness-sdk
    expect(result!.contents).toMatch(/sdk-python\/pull\/2287/)
    expect(result!.contents).toMatch(/sdk-python\/commit\/155239d/)
    expect(result!.warning).toBe(undefined)
  })

  it('evals file path + no language', async () => {
    const evalsRelease = {
      tag_name: 'v0.2.1',
      published_at: '2026-05-29T00:00:00Z',
      html_url: 'https://github.com/strands-agents/evals/releases/tag/v0.2.1',
      body: '* feat: add chaos testing by @x in https://github.com/strands-agents/evals/pull/224\n',
    }
    const r = await buildReleaseFile('strands-agents/evals', evalsRelease, {
      enrich: async () => ({
        areas: [],
        breaking: false,
        commit: 'aaa1111',
        author: 'x',
        languages: null,
        docsOnly: false,
      }),
      deriveEntries: bodyDerive,
      readExisting: async () => null,
    } as any)
    expect(r!.path).toBe('site/src/content/changelog/evals/v0.2.1.md')
    expect(r!.contents).not.toMatch(/\nlanguage:/)
  })

  it('skips out-of-scope tags', async () => {
    const r = await buildReleaseFile('strands-agents/harness-sdk', { ...release, tag_name: 'python-wasm/v0.0.1' }, {
      enrich: async () => ({
        areas: [],
        breaking: false,
        commit: null,
        author: null,
        languages: null,
        docsOnly: false,
      }),
      deriveEntries: bodyDerive,
      readExisting: async () => null,
    } as any)
    expect(r).toBe(null)
  })

  it('passes through a derive warning (e.g. truncated compare range)', async () => {
    const r = await buildReleaseFile('strands-agents/harness-sdk', release, {
      deriveEntries: async () => ({ entries: [], warning: 'python/v1.42.0: compare range exceeded 250 commits' }),
      enrich: async () => ({
        areas: [],
        breaking: false,
        commit: null,
        author: null,
        languages: null,
        docsOnly: false,
      }),
      readExisting: async () => null,
    } as any)
    expect(r).toBeTruthy()
    expect(r!.warning).toMatch(/exceeded 250 commits/)
  })

  it('monorepo release filters entries by stream language from PR files', async () => {
    const body = [
      '* feat: py thing by @a in https://github.com/strands-agents/harness-sdk/pull/1',
      '* feat: ts thing by @b in https://github.com/strands-agents/harness-sdk/pull/2',
      '* feat: both thing by @c in https://github.com/strands-agents/harness-sdk/pull/3',
      '* chore: neither-dir thing by @d in https://github.com/strands-agents/harness-sdk/pull/4',
      '* fix: unknown thing by @e in https://github.com/strands-agents/harness-sdk/pull/5',
    ].join('\n')
    // 4 = empty languages (touches neither SDK dir -- e.g. root/ci, or a flat-layout
    // pre-monorepo PR). 5 = unknown (files unavailable).
    const langByPr: Record<number, string[] | null> = {
      1: ['python'],
      2: ['typescript'],
      3: ['python', 'typescript'],
      4: [],
      5: null,
    }
    const deps = {
      enrich: async (_repo: string, pr: number) => ({
        areas: [],
        breaking: false,
        commit: null,
        author: null,
        languages: langByPr[pr],
        docsOnly: false,
      }),
      deriveEntries: bodyDerive,
      readExisting: async () => null,
    }
    const py = await buildReleaseFile(
      'strands-agents/harness-sdk',
      { tag_name: 'python/v1.43.0', published_at: '2026-06-12T00:00:00Z', html_url: 'h', body },
      deps as any
    )
    // python stream keeps py(1), both(3); drops ts(2). Empty-languages(4) and
    // unknown(5) are KEPT -- only a POSITIVE other-language signal drops a PR.
    expect(py!.contents).toMatch(/py thing/)
    expect(py!.contents).toMatch(/both thing/)
    expect(py!.contents).toMatch(/neither-dir thing/)
    expect(py!.contents).toMatch(/unknown thing/)
    expect(py!.contents).not.toMatch(/ts thing/)

    const ts = await buildReleaseFile(
      'strands-agents/harness-sdk',
      { tag_name: 'typescript/v1.5.0', published_at: '2026-06-12T00:00:00Z', html_url: 'h', body },
      deps as any
    )
    // typescript stream: keeps ts(2), both(3), neither-dir(4), unknown(5); drops py(1)
    expect(ts!.contents).toMatch(/ts thing/)
    expect(ts!.contents).toMatch(/both thing/)
    expect(ts!.contents).toMatch(/neither-dir thing/)
    expect(ts!.contents).toMatch(/unknown thing/)
    expect(ts!.contents).not.toMatch(/py thing/)
    expect(ts!.contents).not.toMatch(/site thing/)
  })

  it('a root-lockfile-only dependency bump lands on one stream only', async () => {
    // Root lockfile bumps touch no SDK dir, but they do change one published
    // package's dependency tree, so exactly one stream may carry them (#3712).
    const body =
      '* ci(typescript): bump hono from 4.12.32 to 4.13.0 by @dependabot in https://github.com/strands-agents/harness-sdk/pull/3643'
    const deps = {
      // Real enricher: the language signal under test is derived from PR files.
      enrich: (repo: string, pr: number) =>
        enrichFromPr(repo, pr, async () => ({
          labels: [],
          merge_commit_sha: 'cfc8825aaaa',
          user: 'dependabot[bot]',
          files: ['package-lock.json'],
        })),
      deriveEntries: bodyDerive,
      readExisting: async () => null,
    }
    const py = await buildReleaseFile(
      'strands-agents/harness-sdk',
      { tag_name: 'python/v1.51.0', published_at: '2026-08-07T00:00:00Z', html_url: 'h', body },
      deps as any
    )
    expect(py!.contents).not.toMatch(/bump hono/)

    const ts = await buildReleaseFile(
      'strands-agents/harness-sdk',
      { tag_name: 'typescript/v1.12.0', published_at: '2026-08-07T00:00:00Z', html_url: 'h', body },
      deps as any
    )
    expect(ts!.contents).toMatch(/bump hono/)
  })

  it('monorepo-tagged release with PRs in the OLD flat repo is not language-gated', async () => {
    // Early python releases were re-tagged `python/v*` but their PRs live in the
    // old `sdk-python` repo (code under `src/`, no strands-py/ dir). The file
    // signal there is empty languages -- gating on it would empty the release.
    const body = [
      '* feat: real py feature by @a in https://github.com/strands-agents/sdk-python/pull/423',
      '* fix: another py fix by @b in https://github.com/strands-agents/sdk-python/pull/429',
    ].join('\n')
    const deps = {
      // old-repo PRs touch src/ etc -> languagesFromFiles yields [] (empty)
      enrich: async () => ({ areas: [], breaking: false, commit: null, author: null, languages: [], docsOnly: false }),
      deriveEntries: bodyDerive,
      readExisting: async () => null,
    }
    const r = await buildReleaseFile(
      'strands-agents/harness-sdk',
      { tag_name: 'python/v1.0.0', published_at: '2026-01-01T00:00:00Z', html_url: 'h', body },
      deps as any
    )
    // Both entries must survive -- the cross-repo PRs are python by provenance,
    // not gated by the (nonexistent) monorepo dir signal.
    expect(r!.contents).toMatch(/real py feature/)
    expect(r!.contents).toMatch(/another py fix/)
  })

  it('pre-monorepo and evals releases are not language-filtered', async () => {
    const deps = {
      // even if files say typescript, a single-language-repo release keeps everything
      enrich: async () => ({
        areas: [],
        breaking: false,
        commit: null,
        author: null,
        languages: ['typescript'],
        docsOnly: false,
      }),
      deriveEntries: bodyDerive,
      readExisting: async () => null,
    }
    const old = await buildReleaseFile(
      'strands-agents/harness-sdk',
      {
        tag_name: 'v1.9.1',
        published_at: '2026-01-01T00:00:00Z',
        html_url: 'h',
        body: '* feat: old thing by @a in https://github.com/strands-agents/sdk-python/pull/9',
      },
      deps as any
    )
    expect(old!.contents).toMatch(/old thing/)
    const ev = await buildReleaseFile(
      'strands-agents/evals',
      {
        tag_name: 'v0.2.1',
        published_at: '2026-01-01T00:00:00Z',
        html_url: 'h',
        body: '* feat: eval thing by @a in https://github.com/strands-agents/evals/pull/9',
      },
      deps as any
    )
    expect(ev!.contents).toMatch(/eval thing/)
  })

  it('new contributors are language-gated, but docs/ci-only ones appear in both streams', async () => {
    const body = [
      '* feat: x by @a in https://github.com/strands-agents/harness-sdk/pull/1',
      '',
      '## New Contributors',
      '* @pydev made their first contribution in https://github.com/strands-agents/harness-sdk/pull/10',
      '* @tsdev made their first contribution in https://github.com/strands-agents/harness-sdk/pull/11',
      '* @docsdev made their first contribution in https://github.com/strands-agents/harness-sdk/pull/12',
      '* @mystery made their first contribution in https://github.com/strands-agents/harness-sdk/pull/13',
    ].join('\n')
    const langByPr: Record<number, string[] | null> = {
      1: ['python'],
      10: ['python'],
      11: ['typescript'],
      12: [],
      13: null,
    }
    const deps = {
      enrich: async (_r: string, pr: number) => ({
        areas: [],
        breaking: false,
        commit: null,
        author: null,
        languages: langByPr[pr],
        docsOnly: false,
      }),
      deriveEntries: bodyDerive,
      readExisting: async () => null,
    }
    const py = await buildReleaseFile(
      'strands-agents/harness-sdk',
      { tag_name: 'python/v1.43.0', published_at: '2026-06-12T00:00:00Z', html_url: 'h', body },
      deps as any
    )
    // python stream: pydev (python), docsdev (neither -> both), mystery (unknown -> both); NOT tsdev
    expect(py!.contents).toMatch(/login: pydev/)
    expect(py!.contents).toMatch(/login: docsdev/)
    expect(py!.contents).toMatch(/login: mystery/)
    expect(py!.contents).not.toMatch(/login: tsdev/)

    const ts = await buildReleaseFile(
      'strands-agents/harness-sdk',
      { tag_name: 'typescript/v1.5.0', published_at: '2026-06-12T00:00:00Z', html_url: 'h', body },
      deps as any
    )
    expect(ts!.contents).toMatch(/login: tsdev/)
    expect(ts!.contents).toMatch(/login: docsdev/)
    expect(ts!.contents).toMatch(/login: mystery/)
    expect(ts!.contents).not.toMatch(/login: pydev/)
  })

  it('docs-only PRs are dropped on every stream (incl. pre-monorepo and evals)', async () => {
    const body = [
      '* feat: real code by @a in https://github.com/strands-agents/sdk-python/pull/1',
      '* docs: blog post by @b in https://github.com/strands-agents/sdk-python/pull/2',
    ].join('\n')
    const deps = {
      enrich: async (_r: string, pr: number) =>
        pr === 2
          ? { areas: [], breaking: false, commit: null, author: null, languages: [], docsOnly: true }
          : { areas: [], breaking: false, commit: null, author: null, languages: null, docsOnly: false },
      deriveEntries: bodyDerive,
      readExisting: async () => null,
    }
    // pre-monorepo bare-v (no language gate, but docs-only still drops)
    const old = await buildReleaseFile(
      'strands-agents/harness-sdk',
      { tag_name: 'v1.9.1', published_at: '2026-01-01T00:00:00Z', html_url: 'h', body },
      deps as any
    )
    expect(old!.contents).toMatch(/real code/)
    expect(old!.contents).not.toMatch(/blog post/)
    // evals (no language gate either)
    const ev = await buildReleaseFile(
      'strands-agents/evals',
      {
        tag_name: 'v0.2.1',
        published_at: '2026-01-01T00:00:00Z',
        html_url: 'h',
        body: '* docs: site only by @b in https://github.com/strands-agents/evals/pull/2',
      },
      {
        enrich: async () => ({ areas: [], breaking: false, commit: null, author: null, languages: [], docsOnly: true }),
        deriveEntries: bodyDerive,
        readExisting: async () => null,
      } as any
    )
    expect(ev!.contents).not.toMatch(/site only/)
  })

  it('docs-only first-time contributors are dropped on every stream', async () => {
    const body = [
      '* feat: x by @a in https://github.com/strands-agents/sdk-python/pull/1',
      '',
      '## New Contributors',
      '* @blogger made their first contribution in https://github.com/strands-agents/sdk-python/pull/2',
    ].join('\n')
    const deps = {
      enrich: async (_r: string, pr: number) =>
        pr === 2
          ? { areas: [], breaking: false, commit: null, author: null, languages: [], docsOnly: true }
          : { areas: [], breaking: false, commit: null, author: null, languages: null, docsOnly: false },
      deriveEntries: bodyDerive,
      readExisting: async () => null,
    }
    // pre-monorepo stream: a blog-only first contribution does NOT appear
    const old = await buildReleaseFile(
      'strands-agents/harness-sdk',
      { tag_name: 'v1.9.1', published_at: '2026-01-01T00:00:00Z', html_url: 'h', body },
      deps as any
    )
    expect(old!.contents).not.toMatch(/login: blogger/)
  })

  it('monorepo new contributor whose PR is in the OLD flat repo is not language-gated', async () => {
    // Mirror of the entries-loop guard for the contributors loop: a python/v*
    // release's first-contributor PR can live in sdk-python (no strands-py/ dir ->
    // languages []). It must NOT be dropped by the language gate.
    const body = [
      '* feat: x by @a in https://github.com/strands-agents/harness-sdk/pull/1',
      '',
      '## New Contributors',
      '* @earlybird made their first contribution in https://github.com/strands-agents/sdk-python/pull/900',
    ].join('\n')
    const deps = {
      enrich: async (_r: string, pr: number) =>
        pr === 900
          ? { areas: [], breaking: false, commit: null, author: null, languages: [], docsOnly: false } // cross-repo, code-touching
          : { areas: [], breaking: false, commit: null, author: null, languages: ['python'], docsOnly: false },
      deriveEntries: bodyDerive,
      readExisting: async () => null,
    }
    const py = await buildReleaseFile(
      'strands-agents/harness-sdk',
      { tag_name: 'python/v1.43.0', published_at: '2026-06-12T00:00:00Z', html_url: 'h', body },
      deps as any
    )
    expect(py!.contents).toMatch(/login: earlybird/) // survives -- cross-repo, not dir-gated
  })

  it('docs-only contributor is dropped even on a monorepo stream', async () => {
    // Pins the gate ordering: docs-only check runs before the language gate.
    const body = [
      '* feat: x by @a in https://github.com/strands-agents/harness-sdk/pull/1',
      '',
      '## New Contributors',
      '* @docsdev made their first contribution in https://github.com/strands-agents/harness-sdk/pull/5',
    ].join('\n')
    const deps = {
      enrich: async (_r: string, pr: number) =>
        pr === 5
          ? { areas: [], breaking: false, commit: null, author: null, languages: [], docsOnly: true }
          : { areas: [], breaking: false, commit: null, author: null, languages: ['python'], docsOnly: false },
      deriveEntries: bodyDerive,
      readExisting: async () => null,
    }
    const py = await buildReleaseFile(
      'strands-agents/harness-sdk',
      { tag_name: 'python/v1.43.0', published_at: '2026-06-12T00:00:00Z', html_url: 'h', body },
      deps as any
    )
    expect(py!.contents).not.toMatch(/login: docsdev/)
  })

  it('new contributors flow into frontmatter, not entries', async () => {
    const body = [
      '* feat: real thing by @a in https://github.com/strands-agents/harness-sdk/pull/1',
      '',
      '## New Contributors',
      '* @newdev made their first contribution in https://github.com/strands-agents/harness-sdk/pull/2700',
    ].join('\n')
    const r = await buildReleaseFile(
      'strands-agents/harness-sdk',
      { tag_name: 'python/v1.43.0', published_at: '2026-06-12T00:00:00Z', html_url: 'h', body },
      {
        enrich: async () => ({
          areas: [],
          breaking: false,
          commit: null,
          author: null,
          languages: ['python'],
          docsOnly: false,
        }),
        deriveEntries: bodyDerive,
        readExisting: async () => null,
      } as any
    )
    expect(r!.contents).toMatch(/newContributors:\n  - \{ login: newdev, pr: 2700 \}/)
    expect(r!.contents).not.toMatch(/first contribution/) // not an entry
  })

  it('breaking marker promotes type when no conventional type', async () => {
    // a non-conventional line that the PR labels mark breaking -> type becomes 'breaking'
    const r = await buildReleaseFile(
      'strands-agents/harness-sdk',
      { ...release, body: '* drop the old api by @x in https://github.com/strands-agents/harness-sdk/pull/1\n' },
      {
        enrich: async () => ({
          areas: [],
          breaking: true,
          commit: 'bbb2222',
          author: 'x',
          languages: null,
          docsOnly: false,
        }),
        deriveEntries: bodyDerive,
        readExisting: async () => null,
      } as any
    )
    expect(r!.contents).toMatch(/type: breaking/)
    expect(r!.contents).toMatch(/breaking: true/)
  })
})

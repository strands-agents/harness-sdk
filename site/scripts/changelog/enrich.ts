// Enrich a parsed line from its linked PR: area-* labels, breaking flag,
// short merge-commit SHA, author, and (for monorepo PRs) which release streams
// the PR touches -- derived from changed-file paths because labels are too
// sparse to rely on. Pure given an injected fetcher, so unit-testable.
// A null fetch (404: permission/cross-repo edge cases) degrades to an
// unenriched entry; rate limits fail the run in github-client instead.

import { streamKey } from './tag-meta'
import type { PrData, Enrichment } from './types'

// Monorepo top-level dirs mapped to the release stream (see streamKey) they
// ship in. `mcp` has no changelog stream, so its PRs drop from every stream.
const STREAM_DIRS = new Map([
  ['strands-py', streamKey('sdk', 'python')],
  ['strands-ts', streamKey('sdk', 'typescript')],
  ['harness-py', streamKey('harness', 'python')],
  ['harness-ts', streamKey('harness', 'typescript')],
  ['strands-cli', streamKey('cli')],
  ['strands-mcp', 'mcp'],
])

// The repo-root npm lockfile resolves the strands-ts workspace (root
// package.json `workspaces`), so a bump there can change what npm consumers
// install and can never reach the PyPI distribution. A Map keyed by filename,
// so a GitHub-controlled path cannot reach Object.prototype. Lockfiles only:
// the sibling manifests (package.json, pyproject.toml) also carry repo-wide
// tooling, which belongs to neither SDK.
const ROOT_LOCKFILES = new Map([['package-lock.json', streamKey('sdk', 'typescript')]])

// Top-level dirs holding docs/blog/website content rather than SDK code.
// `site/` is the monorepo home for all docs+blog+website; `docs/` is the
// pre-monorepo / evals docs tree. A PR confined to these never lines up with
// a release stream, so it's dropped on every stream (see build-release-file).
const DOCS_DIRS = new Set(['site', 'docs'])

// A changed path is "docs" if it's under a docs dir OR is a top-level docs file
// -- a repo-root Markdown file (README.md, AGENTS.md, ...) or a well-known root doc
// regardless of extension (CONTRIBUTING, CHANGELOG, NOTICE, LICENSE, ...). These
// carry no package surface, so a PR confined to them is docs-only.
const ROOT_DOC_NAMES = new Set([
  'readme',
  'contributing',
  'changelog',
  'notice',
  'license',
  'security',
  'code_of_conduct',
  'maintainers',
  'authors',
  'codeowners',
])
function isDocPath(f: string): boolean {
  const p = String(f)
  const segs = p.split('/')
  if (DOCS_DIRS.has(segs[0])) return true
  if (segs.length > 1) return false // nested under a non-docs dir -> code-ish
  // top-level file: any markdown, or a known root doc by basename
  if (/\.mdx?$/i.test(p)) return true
  const base = p.replace(/\.[^.]*$/, '').toLowerCase()
  return ROOT_DOC_NAMES.has(base)
}

/**
 * Derive release streams from changed-file paths. Returns:
 * - string[] of stream keys (possibly empty = site/ci/docs-only PR)
 * - null when file info is unavailable (unknown -- callers should not filter)
 *
 * A PR confined to repo-root lockfiles touches no package dir yet still changes
 * one package's dependency tree, so it's attributed to that stream. A dir hit
 * wins outright: a lockfile touched alongside package code adds no stream.
 */
function streamsFromFiles(files: unknown): string[] | null {
  if (!Array.isArray(files)) return null
  const streams = new Set<string>()
  for (const f of files) {
    const stream = STREAM_DIRS.get(String(f).split('/')[0])
    if (stream) streams.add(stream)
  }
  if (streams.size > 0) return [...streams]
  return rootLockfileStreams(files) || []
}

/**
 * Streams implied by a PR that changes *nothing but* repo-root lockfiles, or
 * null otherwise. Requiring every file to be a root lockfile keeps a PR that
 * edits repo tooling alongside a lockfile stream-neutral, and a nested
 * lockfile (site/, .github/) is already covered by its dir.
 */
function rootLockfileStreams(files: unknown[]): string[] | null {
  const streams = new Set<string>()
  for (const f of files) {
    const stream = ROOT_LOCKFILES.get(String(f))
    if (!stream) return null
    streams.add(stream)
  }
  return streams.size > 0 ? [...streams] : null
}

/**
 * True when every changed file lives under a docs/website dir -- i.e. a
 * docs/blog/site-only PR. Unknown (null) or empty file lists are NOT docs-only
 * (we don't drop on missing info). A PR touching docs AND code is not docs-only.
 */
function docsOnlyFromFiles(files: unknown): boolean {
  if (!Array.isArray(files) || files.length === 0) return false
  return files.every(isDocPath)
}

export async function enrichFromPr(
  repo: string,
  num: number,
  fetcher: (repo: string, num: number) => Promise<PrData | null>
): Promise<Enrichment> {
  const pr = await fetcher(repo, num)
  // Unfetchable PR (404): degrade open -- keep the entry, streams unknown,
  // not docs-only. Rate limits throw in the fetcher and never reach here.
  if (!pr) return { areas: [], breaking: false, commit: null, author: null, streams: null, docsOnly: false }
  const areas = (pr.labels || []).filter((l) => l.startsWith('area-')).map((l) => l.slice('area-'.length))
  const breaking = (pr.labels || []).some((l) => l.toLowerCase() === 'breaking change')
  const commit = pr.merge_commit_sha ? pr.merge_commit_sha.slice(0, 7) : null
  return {
    areas,
    breaking,
    commit,
    author: pr.user || null,
    streams: streamsFromFiles(pr.files),
    docsOnly: docsOnlyFromFiles(pr.files),
  }
}

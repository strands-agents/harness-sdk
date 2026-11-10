// Parse the "New Contributors" section of a GitHub release body, and classify
// PR titles into changelog fields. Pure, dependency-free.
//
// Entries themselves are derived from the compare API (see derive-entries.ts),
// not parsed from the body -- so the body is read only for the "New Contributors"
// section, which the compare API doesn't expose.

import type { NewContributor } from './types'

const LINE = /^\s*[-*]\s+(.*)$/
// Cross-SDK marker in newer harness notes, e.g. "title _(shared with TS)_".
// Language gating (from PR changed files) already decides stream membership,
// so strip this annotation from the rendered title.
const SHARED_ANNOTATION = /\s*_\(shared with [^)]+\)_\s*$/i
const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert)(?:\(([^)]+)\))?(!)?:\s*(.+)$/i
const KNOWN_TYPES = new Set(['feat', 'fix', 'docs', 'perf', 'refactor', 'test', 'chore'])
// GitHub's "## New Contributors" lines: "@login made their first contribution in <pr-url>".
// Login may carry a bracket suffix for apps/bots, e.g. dependabot[bot].
const FIRST_CONTRIBUTION =
  /^@([\w-]+(?:\[[\w-]+\])?) made their first contribution\s+in\s+https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\s*$/i

/**
 * Classify a PR title / commit message into changelog fields. Strips the
 * cross-SDK "_(shared with ...)_" annotation, then applies the conventional-commit
 * grammar (type/scope/!), falling back to type "other" for non-conventional
 * titles. Used by the compare-driven derive-entries path.
 */
export function classifyTitle(message: string): {
  type: string
  scope: string | null
  breaking: boolean
  title: string
} {
  const msg = String(message).trim().replace(SHARED_ANNOTATION, '')
  const cc = msg.match(CONVENTIONAL)
  if (cc) {
    const type = cc[1].toLowerCase()
    return {
      type: KNOWN_TYPES.has(type) ? type : 'other',
      scope: cc[2] || null,
      breaking: cc[3] === '!',
      title: cc[4].trim(),
    }
  }
  return { type: 'other', scope: null, breaking: false, title: msg }
}

/**
 * Extract GitHub's "## New Contributors" section into structured data.
 * prRepo is the repo from the PR url (may differ from the release's repo for
 * pre-monorepo releases) -- gate/enrich against THAT repo, mirroring entries.
 */
export function parseNewContributors(body: string | null | undefined): NewContributor[] {
  if (!body) return []
  const out: NewContributor[] = []
  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const li = raw.match(LINE)
    if (!li) continue
    const m = li[1].trim().match(FIRST_CONTRIBUTION)
    if (m) out.push({ login: m[1], pr: Number(m[3]), prRepo: m[2] })
  }
  return out
}

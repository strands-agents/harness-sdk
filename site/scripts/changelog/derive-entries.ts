// Derive a release's changelog entries deterministically from the GitHub
// compare API instead of parsing the release-notes body. The compare endpoint
// lists every merged commit between two tags regardless of how the notes are
// written, so the breakdown is immune to release-note format drift. Each
// commit is resolved to its PR via the commit->PR API for authoritative
// association (handles squash and merge-commit repos), then classified with the
// shared conventional-commit logic. Pure given an injected client.

import { classifyTitle } from './parse-release-body'
import { tagToMeta } from './tag-meta'
import { compareVersionDesc } from '../../src/util/semver'
import type { Client, ParsedEntry } from './types'

/**
 * The previous tag in the same stream (same sdk + language) as `tag`, or null
 * if `tag` is the first release in its stream. Streams: the per-package monorepo
 * prefixes (python/v*, harness-cli/v*, ...) and bare v* (evals / box /
 * pre-monorepo). Uses tagToMeta to classify and compareVersionDesc to order.
 */
export async function previousTagInStream(
  repo: string,
  tag: string,
  client: Pick<Client, 'listTags'>
): Promise<string | null> {
  const meta = tagToMeta(repo, tag)
  if (!meta) return null
  const tags = (await client.listTags(repo)) || []
  // Parse tagToMeta once per tag, then filter/sort/search on the precomputed value.
  const stream = tags
    .flatMap((t) => {
      if (t.name === tag) return []
      const m = tagToMeta(repo, t.name)
      if (!m || m.sdk !== meta.sdk || m.language !== meta.language) return []
      return [{ name: t.name, version: m.version }]
    })
    .sort((a, b) => compareVersionDesc(a.version, b.version)) // newest-first
  // The immediate predecessor is the newest tag older than `tag`.
  for (const entry of stream) {
    if (compareVersionDesc(meta.version, entry.version) < 0) {
      // `meta` is newer than `entry` (compareVersionDesc<0 means first is newer)
      return entry.name
    }
  }
  return null
}

/**
 * Derive parsed-line entries (the shape parseReleaseBody returns) for the range
 * base..head in `repo`. Resolves each commit to its PR(s); a commit with no
 * associated PR (direct push) is skipped. Memoizes commit->PR lookups.
 */
export async function deriveEntries(opts: {
  repo: string
  base: string | null
  head: string
  client: Pick<Client, 'compareCommits' | 'commitPulls'>
}): Promise<{ entries: ParsedEntry[]; truncated: boolean; warning?: string }> {
  const { repo, base, head, client } = opts
  if (!base) {
    // First release in the stream -- no prior tag to diff against. Don't guess
    // the whole history; emit nothing and let the caller note it.
    return {
      entries: [],
      truncated: false,
      warning: `${head}: no prior tag in stream -- entries not derived from compare.`,
    }
  }
  const cmp = (await client.compareCommits(repo, base, head)) || { commits: [] }
  const commits = cmp.commits || []
  const seen = new Set<number>()
  const entries: ParsedEntry[] = []
  for (const c of commits) {
    const pulls = (await client.commitPulls(repo, c.sha)) || []
    for (const pr of pulls) {
      if (seen.has(pr.number)) continue // a PR can map to multiple commits
      seen.add(pr.number)
      entries.push({ ...classifyTitle(pr.title || ''), author: pr.user || null, pr: pr.number, prRepo: repo })
    }
  }
  const truncated = cmp.truncated === true
  return {
    entries,
    truncated,
    warning: truncated
      ? `${head}: compare range exceeded GitHub's 250-commit cap -- entry list may be incomplete; review before merge.`
      : undefined,
  }
}

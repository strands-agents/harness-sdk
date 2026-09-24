import { getCollection, type CollectionEntry } from 'astro:content'
import type { ChangelogEntry } from '../content.config'
import { compareVersionDesc } from './semver'
export { compareVersionDesc } from './semver'

export type ChangelogRelease = CollectionEntry<'changelog'>

/**
 * Escape Markdown-significant characters in inline text (e.g. PR titles) before
 * interpolating into the machine-readable `.md` endpoints. Without this,
 * snake_case identifiers like `_extract_trace_level` render as italics and
 * brackets/backticks reshape the output. Titles are single-line YAML strings,
 * so only inline constructs matter (no block-level escaping needed).
 */
export function escapeMarkdownInline(text: string): string {
  return text.replace(/[\\`*_[\]<>]/g, (c) => '\\' + c)
}

/**
 * Render a release's entries (Features / Fixes / Other) as Markdown bullet
 * sections, shared by the aggregate and per-release `.md` endpoints so the two
 * can't drift. `headingLevel` is the `#` count for the section headers (the
 * aggregate nests sections under a per-release `##`, so it passes 3; the
 * per-release page is the top-level doc, so it passes 2). Titles are escaped
 * (see escapeMarkdownInline); the curated `community` area is hidden to match
 * the HTML.
 */
export function renderEntrySectionsMd(entries: ChangelogEntry[], headingLevel: number): string[] {
  const hashes = '#'.repeat(headingLevel)
  const { features, fixes, other } = groupEntries(entries)
  const out: string[] = []
  const section = (title: string, items: ChangelogEntry[]) => {
    if (!items.length) return
    out.push('', `${hashes} ${title}`)
    for (const e of items) {
      const tags = e.areas.filter((a) => !HIDDEN_AREAS.has(a))
      const areas = tags.length ? ` [${tags.join(', ')}]` : ''
      const pr = e.prUrl ? ` (${e.prUrl})` : ''
      out.push(`- ${escapeMarkdownInline(e.title)}${areas}${pr}`)
    }
  }
  section('Features', features)
  section('Fixes', fixes)
  section('Other', other)
  return out
}

const FEATURE_TYPES = new Set(['feat', 'breaking', 'perf'])
const FIX_TYPES = new Set(['fix'])

/**
 * All releases sorted newest first. Filtering by SDK/language happens
 * client-side on the page. Ties on date are broken by version (newest first)
 * then id, so same-day releases (e.g. typescript rc.0 and rc.1) get a stable,
 * loader-order-independent ordering — which the prev/next links depend on.
 */
export async function getReleases(): Promise<ChangelogRelease[]> {
  const releases = await getCollection('changelog')
  return releases.sort((a, b) => {
    const byDate = b.data.date.getTime() - a.data.date.getTime()
    if (byDate !== 0) return byDate
    const byVersion = compareVersionDesc(a.data.version, b.data.version)
    if (byVersion !== 0) return byVersion
    return a.id.localeCompare(b.id)
  })
}

/**
 * URL slug for a release, e.g. `sdk/python-v1.43.0`, `evals/v0.2.1`.
 * Derived from frontmatter (NOT collection `id`): the glob loader slugifies ids
 * with github-slugger, which strips the dots from version numbers and would
 * make `/changelog/sdk/python-v1430/` (ugly and ambiguous). This keeps the
 * dotted version the team chose. Used for both the route param and links so
 * they always match.
 */
export function releaseSlug(r: ChangelogRelease): string {
  const file = r.data.language ? `${r.data.language}-v${r.data.version}` : `v${r.data.version}`
  return `${r.data.sdk}/${file}`
}

/**
 * Build the getStaticPaths array for the per-release routes, asserting slug
 * uniqueness. Two files mapping to the same slug (e.g. a duplicated sdk+lang+
 * version) would otherwise collide into one route silently; fail the build fast
 * with a clear message instead.
 */
export interface ReleasePathProps {
  release: ChangelogRelease
  newer: ChangelogRelease | null
  older: ChangelogRelease | null
  // Astro's GetStaticPathsItem requires props to be index-signature compatible.
  [key: string]: unknown
}

export async function getReleasePaths(): Promise<Array<{ params: { release: string }; props: ReleasePathProps }>> {
  const releases = await getReleases()
  const seen = new Map<string, string>()
  // Compute same-stream prev/next neighbors here (once) and pass them as props,
  // so detail pages don't each re-read the whole collection to find them.
  return releases.map((release) => {
    const slug = releaseSlug(release)
    if (seen.has(slug)) {
      throw new Error(`changelog: duplicate release slug "${slug}" from ${release.id} and ${seen.get(slug)}`)
    }
    seen.set(slug, release.id)
    const { newer, older } = getStreamNeighbors(release, releases)
    return { params: { release: slug }, props: { release, newer, older } }
  })
}

/** A release belongs to a stream identified by sdk + language (evals has none). */
function streamKey(r: ChangelogRelease): string {
  return `${r.data.sdk}:${r.data.language ?? ''}`
}

/**
 * Newer/older neighbours of `release` within its own stream (same sdk+language),
 * for prev/next links on the detail page. `newer`/`older` are relative to date;
 * either may be null at the ends of the stream.
 */
function getStreamNeighbors(
  release: ChangelogRelease,
  all: ChangelogRelease[]
): { newer: ChangelogRelease | null; older: ChangelogRelease | null } {
  const key = streamKey(release)
  const stream = all.filter((r) => streamKey(r) === key) // `all` is newest-first
  const i = stream.findIndex((r) => r.id === release.id)
  return {
    newer: i > 0 ? stream[i - 1] ?? null : null,
    older: i >= 0 && i < stream.length - 1 ? stream[i + 1] ?? null : null,
  }
}

interface GroupedEntries {
  features: ChangelogEntry[]
  fixes: ChangelogEntry[]
  other: ChangelogEntry[]
}

/** Group a version's entries into Features / Fixes / Other, breaking changes first within features. */
export function groupEntries(entries: ChangelogEntry[]): GroupedEntries {
  const features = entries.filter((e) => FEATURE_TYPES.has(e.type))
  features.sort((a, b) => Number(b.breaking || b.type === 'breaking') - Number(a.breaking || a.type === 'breaking'))
  return {
    features,
    fixes: entries.filter((e) => FIX_TYPES.has(e.type)),
    other: entries.filter((e) => !FEATURE_TYPES.has(e.type) && !FIX_TYPES.has(e.type)),
  }
}

export interface AreaCount {
  area: string
  count: number
}

// Areas suppressed from the facet sidebar and entry tags. `community` is a
// contribution-origin label, not a product area — surfacing it implied
// community work was a separate track from the rest of the changelog.
export const HIDDEN_AREAS = new Set(['community'])

/**
 * Count entries per area across the given entries, sorted by count desc then
 * name. Only the curated `areas` field counts — raw conventional-commit scopes
 * are deliberately NOT folded in (they're an unbounded vocabulary: `tests`,
 * `readme`, `gemini`, … which polluted the filter sidebar). Area values come
 * from `area-*` labels or the backfill classifier, both on the canonical
 * taxonomy. Must mirror the client-side `entryAreas` in the page script.
 */
export function getAreaCounts(entries: ChangelogEntry[]): AreaCount[] {
  const map = new Map<string, number>()
  for (const e of entries) {
    for (const area of e.areas) {
      if (HIDDEN_AREAS.has(area)) continue
      map.set(area, (map.get(area) ?? 0) + 1)
    }
  }
  return [...map.entries()]
    .map(([area, count]) => ({ area, count }))
    .sort((a, b) => b.count - a.count || a.area.localeCompare(b.area))
}

export function formatChangelogDate(date: Date): string {
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/**
 * Compute "Related pages" for user-guide docs. Headless-only — surfaced in
 * /<slug>/index.md, /llms-full.txt, and JSON-LD `relatedLink`. Not rendered
 * on the HTML page itself.
 *
 * Called from src/util/render-to-markdown.ts (markdown/llms surfaces) and
 * src/components/overrides/Head.astro (JSON-LD).
 *
 * --- Scoring ---
 *
 * For each candidate page, we ask: "of all the distinct tags between this
 * page and the candidate, what fraction are in common?" Pages with more
 * tags in common (relative to their combined tag set) score higher.
 *
 * The catch: not all shared tags are equally meaningful. A shared `aws`
 * tag (used by 14 pages) tells us much less than a shared `bedrock` tag
 * (used by 8) — the rarer tag is more topical. So we weight each tag by
 * its *rarity*, computed as `1 - (pages_with_tag / total_tagged_pages)`.
 * Common tags weight near 0; rare tags weight near 1.
 *
 * Putting it together — a candidate's score is:
 *
 *   sum of rarity-weights of TAGS_IN_BOTH_PAGES
 *   ────────────────────────────────────────────
 *   sum of rarity-weights of TAGS_IN_EITHER_PAGE
 *
 * Range is 0 (no shared tags) to 1 (identical tag sets). The denominator
 * is what penalizes "this candidate matched on one tag but has 7 unrelated
 * ones": adding extra tags to the candidate inflates the denominator and
 * drops the score.
 *
 * --- Why this shape ---
 *
 * - A 1-tag match on a broad tag (e.g. just `aws`) ranks below any 2-tag
 *   specific match. Coincidental connections sink naturally.
 * - Self-correcting as the corpus grows. If a tag bloats from 8 to 30
 *   pages over time, its weight drops automatically and its 1-tag matches
 *   stop dominating — no manual audit needed to react.
 * - Score is a ratio, so the threshold remains stable as the corpus grows
 *   roughly proportionally. Uneven growth (e.g. a flood of `aws`-tagged
 *   pages) does shift the meaning of the threshold and may warrant review.
 *
 * Tie-breaking on score: alphabetical by title. Deterministic.
 */
import type { CollectionEntry } from 'astro:content'

export interface RelatedLink {
  slug: string
  title: string
  /** Raw count of shared tags. Surfaced in the headless output as a hint. */
  overlap: number
}

const HEADLESS_MAX = 10
const USER_GUIDE_PREFIX = 'docs/user-guide/'

function isUserGuide(entry: CollectionEntry<'docs'>): boolean {
  return entry.id.startsWith(USER_GUIDE_PREFIX)
}

interface ScoredCandidate {
  doc: CollectionEntry<'docs'>
  overlap: number
  score: number
}

/**
 * Build a tag → specificity map for the user-guide corpus.
 * specificity = 1 - freq/N, so rare tags weight heavier than common ones.
 *
 * Memoized on the `allDocs` array. Astro's `getCollection` returns a stable
 * reference within a build, so successive calls (one per page render across
 * Head.astro and render-to-markdown) hit the cache.
 */
const specificityCache = new WeakMap<readonly CollectionEntry<'docs'>[], Map<string, number>>()

function tagSpecificity(allDocs: readonly CollectionEntry<'docs'>[]): Map<string, number> {
  const cached = specificityCache.get(allDocs)
  if (cached) return cached

  const freq = new Map<string, number>()
  let totalTagged = 0
  for (const d of allDocs) {
    if (!isUserGuide(d)) continue
    const tags = d.data.tags ?? []
    if (tags.length === 0) continue
    totalTagged++
    for (const t of tags) freq.set(t, (freq.get(t) ?? 0) + 1)
  }
  const specificity = new Map<string, number>()
  for (const [tag, count] of freq) {
    specificity.set(tag, totalTagged > 0 ? 1 - count / totalTagged : 0)
  }
  specificityCache.set(allDocs, specificity)
  return specificity
}

/**
 * All tagged user-guide candidates with non-zero overlap, sorted best-first.
 */
function rankedCandidates(
  current: CollectionEntry<'docs'>,
  allDocs: readonly CollectionEntry<'docs'>[]
): ScoredCandidate[] {
  if (!isUserGuide(current)) return []
  const currentTags = current.data.tags ?? []
  if (currentTags.length === 0) return []
  const tagSet = new Set<string>(currentTags)
  const specificity = tagSpecificity(allDocs)
  const weightOf = (t: string) => specificity.get(t) ?? 0

  return allDocs
    .filter((d) => d.id !== current.id && isUserGuide(d) && (d.data.tags ?? []).length > 0)
    .map((d) => {
      const otherTags = d.data.tags ?? []
      const sharedTags = otherTags.filter((t) => tagSet.has(t))
      const unionTags = [...new Set([...currentTags, ...otherTags])]
      const sharedWeight = sharedTags.reduce((s, t) => s + weightOf(t), 0)
      const unionWeight = unionTags.reduce((s, t) => s + weightOf(t), 0)
      return {
        doc: d,
        overlap: sharedTags.length,
        score: unionWeight === 0 ? 0 : sharedWeight / unionWeight,
      }
    })
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.score - a.score || a.doc.data.title.localeCompare(b.doc.data.title))
}

function toLink({ doc, overlap }: ScoredCandidate): RelatedLink {
  return { slug: doc.id, title: doc.data.title, overlap }
}

/** Headless surface: top 10 by specificity-weighted Jaccard. */
export function relatedUserGuideFor(
  current: CollectionEntry<'docs'>,
  allDocs: readonly CollectionEntry<'docs'>[]
): RelatedLink[] {
  return rankedCandidates(current, allDocs).slice(0, HEADLESS_MAX).map(toLink)
}

/**
 * Other user-guide pages carrying a given tag, ranked by relevance to the
 * current page (specificity-weighted Jaccard, the same scorer used for the
 * headless Related Pages list). Ties break alphabetically by title.
 *
 * Used by the clickable-tags UI to populate per-tag expansion content.
 * Excludes the current page so a tag never lists itself.
 */
export function userGuidePagesWithTag(
  tag: string,
  current: CollectionEntry<'docs'>,
  allDocs: readonly CollectionEntry<'docs'>[]
): { slug: string; title: string }[] {
  return rankedCandidates(current, allDocs)
    .filter(({ doc }) => (doc.data.tags ?? []).includes(tag))
    .map(({ doc }) => ({ slug: doc.id, title: doc.data.title }))
}

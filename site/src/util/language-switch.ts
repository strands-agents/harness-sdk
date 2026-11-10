/**
 * Build-time resolution of where the header language toggle should navigate.
 *
 * Pages live under language-specific path segments (e.g.
 * `docs/api/python/...`, `docs/user-guide/quickstart/typescript`). When the
 * user switches language we want to land on the equivalent page in the other
 * language — but the two trees are not mirrors of each other. The Python API
 * reference uses module paths (`strands.agent.a2a_agent`) while the
 * TypeScript one uses symbol names (`Agent`), so a naive URL swap produces
 * URLs that don't exist.
 *
 * Instead, the switch target is resolved against the content collection at
 * build time:
 *   1. If the exact counterpart slug exists, use it (quickstart, deploy).
 *   2. Otherwise, if a symbol-level API counterpart is known (see
 *      api-counterparts.ts), deep-link to it.
 *   3. Otherwise fall back to the target language's section index
 *      (e.g. `docs/api/typescript`), if it exists.
 *   4. Otherwise don't navigate at all.
 */
import { normalizePathToSlug } from './links'

const LANGUAGE_SLUGS = ['python', 'typescript'] as const
export type LanguageSlug = (typeof LANGUAGE_SLUGS)[number]

function isLanguageSlug(segment: string): segment is LanguageSlug {
  return (LANGUAGE_SLUGS as readonly string[]).includes(segment)
}

/**
 * Resolve the URL the language toggle should navigate to from the current
 * page when switching to `targetLang`.
 *
 * @param currentPath - The current page path without the site base (e.g. `/docs/api/python/strands.agent.agent/`)
 * @param targetLang - The language being switched to
 * @param docIds - All doc content-collection ids (slugs), used to check which pages exist
 * @param apiCounterparts - Optional symbol-level API pairing (see api-counterparts.ts)
 * @returns A root-relative path with a trailing slash (optionally `#anchor`), or null if no
 *   navigation should happen (the page has no language segment, is already in the target
 *   language, or has no counterpart)
 */
export function getLanguageSwitchTarget(
  currentPath: string,
  targetLang: LanguageSlug,
  docIds: ReadonlySet<string>,
  apiCounterparts?: ReadonlyMap<string, string>
): string | null {
  const slug = normalizePathToSlug(currentPath.replace(/^\//, ''))
  const segments = slug.split('/')

  // First language segment wins: assumes no page nests a language-named
  // segment under a tree of the other language (true of today's structure).
  const langIndex = segments.findIndex(isLanguageSlug)
  if (langIndex === -1) return null
  if (segments[langIndex] === targetLang) return null

  const swapped = [...segments]
  swapped[langIndex] = targetLang

  // Exact counterpart page (e.g. quickstart/python -> quickstart/typescript)
  const counterpart = swapped.join('/')
  if (docIds.has(counterpart)) return `/${counterpart}/`

  // Symbol-level API counterpart (e.g. strands.models.bedrock -> BedrockModel)
  const apiTarget = apiCounterparts?.get(slug)
  if (apiTarget) return apiTarget

  // Section index for the target language (e.g. docs/api/typescript)
  const sectionIndex = swapped.slice(0, langIndex + 1).join('/')
  if (docIds.has(sectionIndex)) return `/${sectionIndex}/`

  return null
}

/**
 * Build-time static redirects for legacy MkDocs URLs.
 *
 * The site is deployed to GitHub Pages, so there are no server-side redirects.
 * The client-side fallback in Redirect404.astro works for humans, but crawlers
 * don't execute it — old URLs return HTTP 404 and backlink equity is lost.
 *
 * buildStaticRedirects() enumerates every known legacy URL at config time so
 * astro.config.mjs can feed them to Astro's `redirects` option. Sources come
 * from:
 *
 *   1. STATIC_SLUG_REDIRECTS in redirect.ts (exact-match slug renames)
 *   2. `redirectFrom` frontmatter entries in src/content docs
 *   3. The append-only published route registry
 *
 * This module runs at config time, before the content layer exists, so it
 * reads frontmatter from disk instead of using astro:content (unlike
 * redirect.build.ts, which serves the same map to the 404 page at build time).
 */

import fs from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import yaml from 'js-yaml'

import { resolveRedirectFromUrl, STATIC_SLUG_REDIRECTS } from './redirect'
import { pathToDocsSlug } from './links'

/**
 * Extract frontmatter from a markdown/MDX file. Returns an empty object when
 * the file has no frontmatter block.
 *
 * This must stay compatible with the frontmatter parsing Astro's content
 * loader does (gray-matter): both treat the first `---`-fenced block as YAML.
 * A divergence would produce a wrong target slug here, which the build-time
 * "has no content file" validation below then catches.
 */
function readFrontmatter(filePath: string): Record<string, unknown> {
  const source = fs.readFileSync(filePath, 'utf-8')
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const parsed = yaml.load(match[1] ?? '')
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
}

/**
 * Scan the docs content directory once, producing the set of every real page
 * slug (for validation) and the old-slug → new-slug pairs declared in
 * `redirectFrom` frontmatter (same source of truth as redirect.build.ts, read
 * from disk because astro:content isn't available at config time).
 *
 * Slugs come from pathToDocsSlug — including frontmatter `slug` overrides —
 * so validation agrees with the ids the content collection actually uses,
 * rather than guessing filenames from slugs.
 */
function scanContent(contentDir: string): { slugs: Set<string>; redirectFromEntries: Record<string, string> } {
  const slugs = new Set<string>()
  const redirectFromEntries: Record<string, string> = {}

  const files = fg.sync('docs/**/*.{md,mdx}', {
    cwd: contentDir,
    followSymbolicLinks: false,
  })

  for (const relativePath of files) {
    const frontmatter = readFrontmatter(path.join(contentDir, relativePath))
    const target = pathToDocsSlug(relativePath, frontmatter.slug)
    slugs.add(target)

    const redirectFrom = frontmatter.redirectFrom
    if (!Array.isArray(redirectFrom)) continue

    for (const source of redirectFrom) {
      if (typeof source !== 'string') continue
      const existing = redirectFromEntries[source]
      if (existing !== undefined && existing !== target) {
        throw new Error(
          `[redirect.static] duplicate redirectFrom slug "${source}" points to both "${existing}" and "${target}"`
        )
      }
      redirectFromEntries[source] = target
    }
  }

  return { slugs, redirectFromEntries }
}

/**
 * Scan the Astro pages directory for statically routable page slugs
 * (integrations.astro → "integrations"), so redirect rules can target custom
 * pages as well as docs content. Dynamic routes ([...slug]) can't be
 * enumerated and are excluded; docs pages are validated via scanContent.
 */
function scanPages(pagesDir: string): Set<string> {
  const slugs = new Set<string>()
  if (!fs.existsSync(pagesDir)) return slugs

  const files = fg.sync('**/*.astro', {
    cwd: pagesDir,
    followSymbolicLinks: false,
  })

  for (const relativePath of files) {
    if (relativePath.includes('[')) continue
    const slug = relativePath.replace(/\.astro$/, '').replace(/(^|\/)index$/, '')
    slugs.add(slug)
  }

  return slugs
}

/** Format a slug as a root-relative URL path in the site's directory format. */
function toUrlPath(slug: string, base: string): string {
  const prefix = base.replace(/\/+$/, '')
  const suffix = slug.replace(/^\/+|\/+$/g, '')
  return suffix ? `${prefix}/${suffix}/` : `${prefix}/` || '/'
}

function resolveDestination(target: string, source: string, validSlugs: Set<string>, base: string): string {
  if (/^https?:\/\//.test(target)) return target

  const targetSlug = target.replace(/^\/+|\/+$/g, '')
  if (!validSlugs.has(targetSlug)) {
    throw new Error(`[redirect.static] redirect target "${target}" (from "${source}") has no page`)
  }
  return toUrlPath(targetSlug, base)
}

function registerRedirect(
  redirects: Record<string, string>,
  source: string,
  target: string,
  validSlugs: Set<string>,
  base: string
): void {
  const sourceSlug = source.replace(/^\/+|\/+$/g, '')
  if (validSlugs.has(sourceSlug)) {
    throw new Error(`[redirect.static] redirect source "${sourceSlug}" collides with an existing page`)
  }

  const destination = resolveDestination(target, sourceSlug, validSlugs, base)

  const sourcePath = `/${sourceSlug}`
  const existing = redirects[sourcePath]
  if (existing !== undefined && existing !== destination) {
    throw new Error(
      `[redirect.static] redirect source "${sourceSlug}" points to both "${existing}" and "${destination}"`
    )
  }
  redirects[sourcePath] = destination
}

/**
 * Build the value for Astro's `redirects` config option: a map of
 * old URL path → new URL path (or external URL).
 *
 * @param contentDir - Absolute path to src/content, used to validate that no
 *   redirect source shadows a real page and every internal target exists
 * @param base - The site's base path (Astro `base` config), prepended to
 *   internal destinations so meta-refresh URLs work under a subpath deploy
 * @param staticRedirects - Exact-match rename rules; defaults to the production
 *   STATIC_SLUG_REDIRECTS. Injectable so unit tests aren't coupled to the
 *   production entries (adding a rename must not break the test suite).
 * @param pagesDir - Absolute path to src/pages; custom Astro pages found there
 *   (e.g. integrations.astro) are additional valid redirect targets. Defaults
 *   to the sibling of contentDir, matching the src/ layout.
 * @param legacyRoutes - Published URL paths to preserve. Current routes are
 *   ignored; routes changed by version normalization or rename rules are emitted.
 */
export function buildStaticRedirects(
  contentDir: string,
  base = '/',
  staticRedirects: Record<string, string> = STATIC_SLUG_REDIRECTS,
  pagesDir: string = path.resolve(contentDir, '../pages'),
  legacyRoutes: string[] = []
): Record<string, string> {
  const { slugs, redirectFromEntries } = scanContent(contentDir)
  const pageSlugs = scanPages(pagesDir)
  const validSlugs = new Set([...slugs, ...pageSlugs])

  // A redirectFrom entry that collides with a rename rule but points elsewhere
  // is an authoring mistake — the rename rule would silently win. Same
  // fail-fast treatment as duplicate redirectFrom entries.
  for (const [source, target] of Object.entries(redirectFromEntries)) {
    const staticTarget = staticRedirects[source]
    if (staticTarget !== undefined && staticTarget !== target) {
      throw new Error(
        `[redirect.static] redirectFrom slug "${source}" conflicts with a static rename rule ` +
          `("${target}" vs "${staticTarget}")`
      )
    }
  }

  const slugMap: Record<string, string> = {
    ...redirectFromEntries,
    // Exact-match renames take priority, matching resolveRedirect's rule order
    ...staticRedirects,
  }

  const redirects: Record<string, string> = {}

  for (const [source, target] of Object.entries(slugMap)) {
    registerRedirect(redirects, source, target, validSlugs, base)
  }

  for (const route of legacyRoutes) {
    const source = route.replace(/^\/+|\/+$/g, '')
    const target = resolveRedirectFromUrl(route, redirectFromEntries)
    if (!target) continue

    const normalizedTarget = /^https?:\/\//.test(target) ? target : target.replace(/^\/+|\/+$/g, '')
    if (source === normalizedTarget) continue

    registerRedirect(redirects, source, target, validSlugs, base)
  }

  return redirects
}

export function buildPublishedRedirects(
  contentDir: string,
  legacyRoutes: string[],
  base = '/'
): Record<string, string> {
  return buildStaticRedirects(
    contentDir,
    base,
    STATIC_SLUG_REDIRECTS,
    path.resolve(contentDir, '../pages'),
    legacyRoutes
  )
}

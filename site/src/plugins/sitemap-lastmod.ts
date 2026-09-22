/**
 * Sitemap lastmod plugin
 *
 * Adds <lastmod> dates to the XML sitemap by looking up each page's
 * last git commit date. Runs a single `git log` command at config time
 * to build a map of file paths to ISO dates, then injects them via
 * the @astrojs/sitemap `serialize` callback.
 *
 * Dynamically-generated routes have no backing content file, so they
 * derive lastmod from the content that feeds them:
 *   - homepage        → newest commit across all of src/content
 *   - /blog/          → newest blog post commit
 *   - /changelog/     → newest changelog entry commit
 *   - /docs/api/**    → newest changelog commit for the matching SDK
 *                       stream (API docs are regenerated per release,
 *                       and each release lands a changelog file)
 *
 * Blog tag and author archive pages are noindexed (thin near-duplicate
 * content), so the `filter` option drops them from the sitemap entirely.
 *
 * When Starlight sees @astrojs/sitemap already in the integrations
 * array, it skips adding its own — so this replaces the default
 * sitemap with one that includes lastmod.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import sitemap from '@astrojs/sitemap'
import type { SitemapItem } from '@astrojs/sitemap'

/**
 * Build a map of content file path → last git commit date (ISO 8601).
 *
 * Uses a single `git log` call with --name-only to get all commits
 * touching the content directory, then picks the most recent date
 * for each file. This is much faster than running git log per file.
 */
function buildLastModMap(contentDir: string): Map<string, string> {
  const map = new Map<string, string>()

  try {
    // Single git command: output all commits with dates and affected files
    // Format: each commit outputs its ISO date, then the list of files
    const output = execFileSync('git', ['log', '--format=%cI', '--name-only', '--diff-filter=ACMR', '--', contentDir], {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    })

    // Parse: lines alternate between date lines and file path lines,
    // separated by blank lines. First occurrence of each file = most recent.
    let currentDate = ''
    for (const line of output.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue

      // ISO date lines start with a digit (e.g., "2026-03-07T00:22:25-08:00")
      if (/^\d{4}-/.test(trimmed)) {
        currentDate = trimmed
      } else if (currentDate && !map.has(trimmed)) {
        // File path — only store if we haven't seen it yet (first = most recent)
        map.set(trimmed, currentDate)
      }
    }
  } catch (error) {
    // If git isn't available (e.g., Docker build without .git),
    // fall back gracefully — sitemap just won't have lastmod
    console.warn('[sitemap-lastmod] Failed to build lastmod map:', error instanceof Error ? error.message : error)
  }

  return map
}

/**
 * Determine the path from the git repo root to the current working directory.
 *
 * `git log --name-only` emits file paths relative to the repo root, but the
 * build runs from `site/`, so those paths carry a `site/` prefix. We prepend
 * the same prefix to lookup candidates so both sides share one path space.
 * Returns '' when the build runs from the repo root (e.g. a Docker build) or
 * when git is unavailable, which keeps the plugin correct in both layouts.
 */
function getGitPrefix(): string {
  try {
    // git uses forward slashes with a trailing slash (e.g. "site/"), or "" at the repo root
    return execFileSync('git', ['rev-parse', '--show-prefix'], { encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

/**
 * Convert a URL path to likely content file paths.
 * e.g., /docs/user-guide/quickstart/python/ → site/src/content/docs/user-guide/quickstart/python.mdx
 *
 * `gitPrefix` is prepended so candidates match the repo-root-relative paths
 * that `git log --name-only` produces. Uses `path.posix.join` (not `path.join`)
 * because both the git paths and `gitPrefix` use forward slashes — joining with
 * the OS-native separator would reintroduce a separator mismatch on Windows,
 * the same bug class this lookup is built to avoid.
 */
export function urlToContentPaths(urlPath: string, contentDir: string, gitPrefix: string): string[] {
  const slug = urlPath.replace(/^\//, '').replace(/\/$/, '')

  // README.* is included because the content loader maps a directory's README
  // to its index route (e.g. docs/examples/README.mdx → /docs/examples/).
  return [
    `${slug}.mdx`,
    `${slug}.md`,
    path.posix.join(slug, 'index.mdx'),
    path.posix.join(slug, 'index.md'),
    path.posix.join(slug, 'README.mdx'),
    path.posix.join(slug, 'README.md'),
  ].map((rel) => gitPrefix + path.posix.join(contentDir, rel))
}

/**
 * Newest commit date among map entries whose file path starts with `pathPrefix`.
 * Dates are compared numerically (via Date.parse) rather than lexically because
 * git emits committer-local UTC offsets, so ISO strings aren't sortable as text.
 */
export function newestDateUnder(lastModMap: Map<string, string>, pathPrefix: string): string | undefined {
  let newest: string | undefined
  let newestMs = -Infinity
  for (const [file, date] of lastModMap) {
    if (!file.startsWith(pathPrefix)) continue
    const ms = Date.parse(date)
    if (!Number.isNaN(ms) && ms > newestMs) {
      newestMs = ms
      newest = date
    }
  }
  return newest
}

// Blog tag/author archives are noindexed thin content — keep them out of the
// sitemap so it only lists indexable URLs. Anchored to the deploy base path
// (subpath previews) so a content page like /docs/blog/tags/ can't be caught.
const EXCLUDED_ROUTES = ['blog/tags/', 'blog/authors/']
const basePath = (process.env.ASTRO_BASE_PATH || '/').replace(/\/+$/, '')

export function sitemapWithLastmod(contentDir: string = 'src/content') {
  const gitPrefix = getGitPrefix()
  const lastModMap = buildLastModMap(contentDir)
  console.log(`[sitemap-lastmod] Loaded ${lastModMap.size} git dates`)

  const contentPrefix = (rel: string) => gitPrefix + path.posix.join(contentDir, rel)

  // Precompute lastmod dates for route classes with no backing content file.
  // Homepage uses the newest content commit overall — never the build date,
  // which would advertise fake freshness on every deploy. Keys are anchored to
  // the deploy base path, like the filter below, so subpath builds still match.
  const indexDates: Record<string, string | undefined> = {
    [`${basePath}/`]: newestDateUnder(lastModMap, contentPrefix('')),
    [`${basePath}/blog/`]: newestDateUnder(lastModMap, contentPrefix('blog/')),
    [`${basePath}/changelog/`]: newestDateUnder(lastModMap, contentPrefix('changelog/')),
  }
  // API reference pages are regenerated from SDK source at each release, and
  // every release commits a changelog file — its commit date approximates the
  // release date for the matching stream.
  const apiDates: Array<[urlPattern: string, date: string | undefined]> = [
    ['/api/python/', newestDateUnder(lastModMap, contentPrefix('changelog/sdk/python-'))],
    ['/api/typescript/', newestDateUnder(lastModMap, contentPrefix('changelog/sdk/typescript-'))],
  ]

  return sitemap({
    filter: (page: string) => {
      const pathname = new URL(page).pathname
      return !EXCLUDED_ROUTES.some((route) => pathname.startsWith(`${basePath}/${route}`))
    },
    serialize(item: SitemapItem) {
      const url = new URL(item.url)
      const pathname = url.pathname

      // Dynamically-generated index routes: derive lastmod from the newest
      // commit to the content that feeds them.
      if (pathname in indexDates) {
        const date = indexDates[pathname]
        if (date) item.lastmod = date
        return item
      }

      // Content-backed pages: look up the page's own file commit date.
      // Curated API landing pages (e.g. /docs/api/python/ → index.mdx) are
      // git-tracked and resolve here; generated API pages fall through.
      const candidates = urlToContentPaths(pathname, contentDir, gitPrefix)
      for (const candidate of candidates) {
        const date = lastModMap.get(candidate)
        if (date) {
          item.lastmod = date
          return item
        }
      }

      // Generated API reference pages: use the stream's latest release date.
      for (const [urlPattern, date] of apiDates) {
        if (date && pathname.includes(urlPattern)) {
          item.lastmod = date
          return item
        }
      }

      return item
    },
  })
}

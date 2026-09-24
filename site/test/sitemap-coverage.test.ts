import { describe, it, expect } from 'vitest'
import { getCollection } from 'astro:content'
import fs from 'node:fs'
import path from 'node:path'
import Sitemapper from 'sitemapper'
import { resolveRedirectFromUrl } from '../src/util/redirect'
import { buildRedirectFromMap } from '../src/util/redirect.build'
import { tagToSlug, getAllTags, getPublishedPosts } from '../src/util/blog'

const KNOWN_ROUTES_PATH = path.resolve('test/known-routes.json')
const SITEMAP_URL = 'https://strandsagents.com/sitemap-index.xml'
const CACHE_PATH = path.resolve('.build/sitemap-cache.json')
const CACHE_TTL_MS = 4 * 60 * 60 * 1000 // 4 hours

// Sitemap URLs under API reference paths are excluded — regenerated from source.
const API_REFERENCE_URL = /\/docs\/api\/(python|typescript)\//

/**
 * Fetch all non-API doc URLs from the live sitemap index using sitemapper, with a 4-hour file cache.
 * Returns full URLs (e.g. "https://strandsagents.com/1.x/documentation/docs/user-guide/quickstart/").
 */
async function fetchSitemapUrls(): Promise<string[]> {
  const cacheValid =
    fs.existsSync(CACHE_PATH) && Date.now() - fs.statSync(CACHE_PATH).mtimeMs < CACHE_TTL_MS

  let allUrls: string[]

  if (cacheValid) {
    allUrls = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'))
  } else {
    const sitemap = new Sitemapper({ url: SITEMAP_URL, timeout: 15000 })
    const { sites } = await sitemap.fetch()
    allUrls = sites
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true })
    fs.writeFileSync(CACHE_PATH, JSON.stringify(allUrls), 'utf-8')
  }

  return allUrls.filter((url) => !API_REFERENCE_URL.test(url))
}

/**
 * Build the set of all valid URL slugs across docs, blog, authors, and tag pages.
 */
async function buildValidSlugs(): Promise<Set<string>> {
  const [docs, posts, authors, tags] = await Promise.all([
    getCollection('docs'),
    getPublishedPosts(),
    getCollection('authors'),
    getAllTags(),
  ])

  return new Set([
    ...docs.map((doc) => doc.id),
    'blog',
    ...posts.map((post) => `blog/${post.id}`),
    ...authors.map((author) => `blog/authors/${author.id}`),
    ...tags.map((tag) => `blog/tags/${tagToSlug(tag)}`),
  ])
}

const VERIFY_LIVE_SITEMAP = process.env.VERIFY_LIVE_SITEMAP === 'true'

describe('Sitemap Coverage', { skip: !VERIFY_LIVE_SITEMAP }, () => {
  it('every page in the live sitemap has a corresponding CMS entry (or a known redirect)', async () => {
    const [sitemapUrls, validIds, redirectFromMap] = await Promise.all([
      fetchSitemapUrls(),
      buildValidSlugs(),
      buildRedirectFromMap(),
    ])

    expect(sitemapUrls.length).toBeGreaterThan(0)

    const missing: string[] = []
    const redirected: Array<{ from: string; to: string }> = []

    for (const url of sitemapUrls) {
      // resolveRedirectFromUrl strips version prefix and /documentation/ segment from the path,
      // then applies any slug rename rules. The result is a CMS slug (e.g. "docs/user-guide/...").
      const urlPath = new URL(url).pathname
      const resolved = resolveRedirectFromUrl(urlPath, redirectFromMap)
      if (!resolved || resolved === '/') continue

      // External redirects (e.g. GitHub) are always valid — no CMS entry needed
      if (resolved.startsWith('https://') || resolved.startsWith('http://')) continue

      // Strip trailing slash to match content collection IDs
      const slug = resolved.replace(/\/$/, '')

      if (validIds.has(slug)) {
        // Check whether a redirect rule was applied (i.e. the raw path differs from resolved)
        const rawPath = new URL(url).pathname.replace(/^\/+|\/+$/g, '')
        if (rawPath !== slug) {
          redirected.push({ from: rawPath, to: slug })
        }
        continue
      }

      missing.push(url)
    }

    if (redirected.length > 0) {
      console.log(`\n=== Slugs resolved via redirect (${redirected.length}) ===\n`)
      for (const { from, to } of redirected) {
        console.log(`  ${from}\n    -> ${to}`)
      }
    }

    if (missing.length > 0) {
      console.log(`\n=== Sitemap pages missing from CMS and no redirect (${missing.length}) ===\n`)
      for (const url of missing) {
        console.log(`- ${url}`)
      }
    }

    expect(missing).toEqual([])
  })

  // Redirect rule unit tests live in test/redirect.test.ts.
  // This test verifies that redirect targets actually exist in the CMS collection.
  it('redirect targets all resolve to valid CMS entries', async () => {
    const [sitemapUrls, validIds, redirectFromMap] = await Promise.all([
      fetchSitemapUrls(),
      buildValidSlugs(),
      buildRedirectFromMap(),
    ])

    const brokenRedirects: Array<{ from: string; to: string }> = []
    for (const url of sitemapUrls) {
      const urlPath = new URL(url).pathname
      const resolved = resolveRedirectFromUrl(urlPath, redirectFromMap)
      if (!resolved || resolved === '/') continue

      // External redirects (e.g. GitHub) are always valid
      if (resolved.startsWith('https://') || resolved.startsWith('http://')) continue

      const slug = resolved.replace(/\/$/, '')
      if (!validIds.has(slug)) {
        brokenRedirects.push({ from: url, to: slug })
      }
    }

    if (brokenRedirects.length > 0) {
      console.log(`\n=== Redirect targets missing from CMS (${brokenRedirects.length}) ===\n`)
      for (const { from, to } of brokenRedirects) {
        console.log(`  ${from}\n    -> ${to} (NOT FOUND)`)
      }
    }

    expect(brokenRedirects).toEqual([])
  })
})

describe('Known Routes', () => {
  // test/known-routes.json is an append-only registry of paths that must always resolve.
  // Add new entries from the live sitemap with: npm run routes:update
  it('every redirectFrom source slug has a corresponding entry in known-routes.json', async () => {
    const knownRoutes = new Set<string>(JSON.parse(fs.readFileSync(KNOWN_ROUTES_PATH, 'utf-8')))
    const knownRedirects = Object.entries(await buildRedirectFromMap()).map(([redirect, page]) => ({
      page,
      redirect,
    }))

    const missing = knownRedirects.filter((it) => !knownRoutes.has(`/${it.redirect}/`))

    const entries = missing.map((it) => `  "/${it.redirect}/"`)
    expect(
      missing,
      `${missing.length} redirectFrom slug(s) are missing from known-routes.json.\n` +
        `Add these entries to test/known-routes.json:\n` +
        entries.join(',\n')
    ).toEqual([])
  })

  it('every known route resolves to a valid CMS entry', async () => {
    const knownRoutes: string[] = JSON.parse(fs.readFileSync(KNOWN_ROUTES_PATH, 'utf-8'))
    const docs = await getCollection('docs')
    const validIds = new Set(docs.map((doc) => doc.id))

    // Non-docs Astro pages that are valid redirect targets (not in the docs collection)
    const validNonDocsPages = new Set(['integrations', 'examples'])

    // Verify each allowlisted non-docs page exists as an Astro file
    const missingPages: string[] = []
    for (const slug of validNonDocsPages) {
      const astroPagePath = path.resolve(`src/pages/${slug}.astro`)
      if (!fs.existsSync(astroPagePath)) {
        missingPages.push(slug)
      }
    }

    if (missingPages.length > 0) {
      console.log(`\n=== Non-docs pages in allowlist but missing as Astro files (${missingPages.length}) ===\n`)
      for (const slug of missingPages) {
        console.log(`  ${slug} (expected at src/pages/${slug}.astro)`)
      }
    }

    expect(missingPages).toEqual([])

    // Build redirectFromMap from frontmatter so page-level redirects are honoured
    const redirectFromMap = await buildRedirectFromMap()

    const broken: Array<{ url: string; resolved: string }> = []
    for (const routePath of knownRoutes) {
      const resolved = resolveRedirectFromUrl(routePath, redirectFromMap)
      if (!resolved || resolved === '/') continue
      // External redirects (e.g. GitHub) are always valid
      if (resolved.startsWith('https://') || resolved.startsWith('http://')) continue
      const slug = resolved.replace(/\/$/, '')
      if (validNonDocsPages.has(slug)) continue
      if (!validIds.has(slug)) broken.push({ url: routePath, resolved: slug })
    }

    if (broken.length > 0) {
      console.log(`\n=== Known routes no longer resolving (${broken.length}) ===\n`)
      for (const { url, resolved } of broken) {
        console.log(`  ${url}\n    -> ${resolved} (NOT FOUND)`)
      }
      console.log('\nIf these pages moved, add a redirect rule in src/util/redirect.ts.')
      console.log('To sync known-routes.json with the live sitemap, run: npm run routes:update')
    }

    expect(broken).toEqual([])
  })
})

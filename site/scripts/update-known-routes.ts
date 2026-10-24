/**
 * Merges every docs URL from the live sitemap and every docs page on disk into
 * src/config/legacy-routes.json. Registering pages from disk records a new page
 * in the PR that adds it, so its URL keeps resolving after it later moves.
 * Existing entries are never removed — the file is append-only so old routes
 * continue to be tested even after pages move or are deleted from the sitemap.
 *
 * Usage: npm run routes:update
 */

import fs from 'node:fs'
import path from 'node:path'
import Sitemapper from 'sitemapper'

import { docsPageSlugs } from '../src/util/redirect.static'

const SITEMAP_URL = 'https://strandsagents.com/sitemap-index.xml'
const KNOWN_ROUTES_PATH = path.resolve('src/config/legacy-routes.json')
const CONTENT_DIR = path.resolve('src/content')
// API reference pages are regenerated from source, so they aren't registered.
const DOCS_PATH = /^\/docs\/(?!api\/)/

const { sites, errors } = await new Sitemapper({ url: SITEMAP_URL, timeout: 15000 }).fetch()
if (errors.length > 0 || sites.length === 0) {
  throw new Error(`Failed to fetch sitemap ${SITEMAP_URL}: ${JSON.stringify(errors)}`)
}

const incoming = new Set<string>()
for (const url of sites) {
  const pathname = new URL(url).pathname
  if (DOCS_PATH.test(pathname)) incoming.add(pathname)
}
for (const slug of docsPageSlugs(CONTENT_DIR)) {
  const pathname = `/${slug}/`
  if (DOCS_PATH.test(pathname)) incoming.add(pathname)
}

const existing: string[] = fs.existsSync(KNOWN_ROUTES_PATH)
  ? JSON.parse(fs.readFileSync(KNOWN_ROUTES_PATH, 'utf-8') || '[]')
  : []

const merged = [...new Set([...existing, ...incoming])].sort()
const added = merged.length - existing.length

fs.writeFileSync(KNOWN_ROUTES_PATH, JSON.stringify(merged, null, 2) + '\n')
console.log(`${added} new route(s) added. Total: ${merged.length}`)

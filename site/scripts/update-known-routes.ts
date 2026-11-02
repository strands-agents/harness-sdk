/**
 * Fetches the live sitemap and merges any new URLs into src/config/legacy-routes.json.
 * Existing entries are never removed — the file is append-only so old routes
 * continue to be tested even after pages move or are deleted from the sitemap.
 *
 * Usage: npm run routes:update
 */

import fs from 'node:fs'
import path from 'node:path'

const SITEMAP_URL = 'https://strandsagents.com/1.x/sitemap.xml'
const KNOWN_ROUTES_PATH = path.resolve('src/config/legacy-routes.json')
const API_REFERENCE_URL = /\/documentation\/docs\/api-reference\//

const res = await fetch(SITEMAP_URL)
if (!res.ok) throw new Error(`Failed to fetch sitemap: ${res.status} ${res.statusText}`)
const xml = await res.text()

const incoming = new Set<string>()
for (const match of xml.matchAll(/<loc>(.*?)<\/loc>/g)) {
  const url = match[1].trim()
  if (!API_REFERENCE_URL.test(url)) {
    // Strip domain, keep only the path
    incoming.add(new URL(url).pathname)
  }
}

const existing: string[] = fs.existsSync(KNOWN_ROUTES_PATH)
  ? JSON.parse(fs.readFileSync(KNOWN_ROUTES_PATH, 'utf-8') || '[]')
  : []

const merged = [...new Set([...existing, ...incoming])].sort()
const added = merged.length - existing.length

fs.writeFileSync(KNOWN_ROUTES_PATH, JSON.stringify(merged, null, 2) + '\n')
console.log(`${added} new route(s) added. Total: ${merged.length}`)

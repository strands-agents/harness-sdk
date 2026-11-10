/**
 * Refreshes site/src/data/catalog-stats.json with GitHub stars and registry
 * download counts for every catalog entry. Run by the
 * catalog-stats.yml scheduled workflow; per-source failures are logged and the
 * previous committed value is kept, so one broken upstream can neither block
 * the whole refresh nor regress the stats it can't fetch.
 *
 * Usage: npm run catalog:stats   (requires GITHUB_TOKEN for the GitHub API)
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

export interface StatsEntry {
  id: string
  github?: string
  python?: string
  typescript?: string
}

export interface StatsFetchers {
  githubRepo(repoUrl: string): Promise<{ stars: number }>
  pypiDownloads(pkg: string): Promise<number>
  npmDownloads(pkg: string): Promise<number>
}

export interface EntryStats {
  stars?: number
  downloads: { python?: number; typescript?: number }
}

/**
 * A malformed upstream payload (missing field, string, NaN, negative) must
 * take the same keep-previous path as a failed fetch, not overwrite a good
 * committed value — so validation throws inside the per-source try blocks.
 */
function assertStat(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`malformed payload: ${what}=${JSON.stringify(value)}`)
  }
  return value
}

export async function buildStats(
  entries: StatsEntry[],
  fetchers: StatsFetchers,
  previous: Record<string, EntryStats> = {}
): Promise<Record<string, EntryStats>> {
  const result: Record<string, EntryStats> = {}
  for (const entry of entries) {
    const stats: EntryStats = { downloads: {} }
    const prev = previous[entry.id]
    if (entry.github) {
      try {
        const repo = await fetchers.githubRepo(entry.github)
        stats.stars = assertStat(repo?.stars, 'stars')
      } catch (err) {
        // Keep the previous value so a transient outage doesn't regress stats.
        console.warn(`entry=<${entry.id}>, source=github | fetch failed, keeping previous value`, err)
        if (prev?.stars !== undefined) stats.stars = prev.stars
      }
    }
    if (entry.python) {
      try {
        stats.downloads.python = assertStat(await fetchers.pypiDownloads(entry.python), 'pypi downloads')
      } catch (err) {
        console.warn(`entry=<${entry.id}>, source=pypi | fetch failed, keeping previous value`, err)
        if (prev?.downloads?.python !== undefined) stats.downloads.python = prev.downloads.python
      }
    }
    if (entry.typescript) {
      try {
        stats.downloads.typescript = assertStat(await fetchers.npmDownloads(entry.typescript), 'npm downloads')
      } catch (err) {
        console.warn(`entry=<${entry.id}>, source=npm | fetch failed, keeping previous value`, err)
        if (prev?.downloads?.typescript !== undefined) stats.downloads.typescript = prev.downloads.typescript
      }
    }
    result[entry.id] = stats
  }
  return result
}

// ── Live fetchers ─────────────────────────────────────────────────────────────
// Payload validation lives in buildStats (assertStat), so a fetcher that
// extracts garbage from a malformed response still takes the keep-previous
// path there.

function githubApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  return headers
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`status=${res.status} url=${url}`)
  return res.json()
}

const liveFetchers: StatsFetchers = {
  async githubRepo(repoUrl) {
    // Keep only the org/repo segments so tree/blob URLs resolve to the repo.
    const slug = new URL(repoUrl).pathname
      .replace(/^\/|\/$/g, '')
      .split('/')
      .slice(0, 2)
      .join('/')
    const repo = (await fetchJson(`https://api.github.com/repos/${slug}`, githubApiHeaders())) as {
      stargazers_count: number
    }
    return { stars: repo.stargazers_count }
  },
  async pypiDownloads(pkg) {
    // pypistats.org: last-month downloads for the package.
    const data = (await fetchJson(`https://pypistats.org/api/packages/${encodeURIComponent(pkg)}/recent`)) as {
      data: { last_month: number }
    }
    return data.data.last_month
  },
  async npmDownloads(pkg) {
    const data = (await fetchJson(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(pkg)}`)) as {
      downloads: number
    }
    return data.downloads
  },
}

// ── CLI entry point ───────────────────────────────────────────────────────────

export function loadEntries(catalogDir: string): StatsEntry[] {
  const entries: StatsEntry[] = []
  for (const f of readdirSync(catalogDir)) {
    if (!f.endsWith('.yaml')) continue
    const id = f.replace(/\.yaml$/, '')
    try {
      const data = yaml.load(readFileSync(path.join(catalogDir, f), 'utf-8')) as {
        github?: string
        // package is absent for guide-only language blocks (`python: {}`) —
        // those entries get no download stats for that language.
        languages?: { python?: { package?: string }; typescript?: { package?: string } }
      }
      if (!data?.github || typeof data.github !== 'string') {
        console.warn(`entry=<${id}> | missing or non-string github field, skipping`)
        continue
      }
      const languages = data.languages ?? {}
      const entry: StatsEntry = { id }
      // Entries anchored to the SDK itself (no dedicated package or repo) must
      // not display the SDK's own downloads/stars as their popularity.
      const repoSlug = new URL(data.github).pathname.replace(/^\//, '')
      // A guide-only entry (no package in any language block) points its
      // github at the vendor's main repo — that repo's stars measure the
      // vendor's product, not the Strands integration, so skip them.
      const hasPackage = Boolean(languages.python?.package || languages.typescript?.package)
      if (repoSlug.startsWith('strands-agents/')) {
        console.warn(`entry=<${id}>, source=github | repo is the sdk itself, skipping stats`)
      } else if (!hasPackage) {
        console.warn(`entry=<${id}> | guide-only entry, skipping github stats`)
      } else {
        entry.github = data.github
      }
      if (languages.python?.package === 'strands-agents') {
        console.warn(`entry=<${id}>, source=pypi | package is the sdk itself, skipping stats`)
      } else if (languages.python?.package?.endsWith(']')) {
        // An extras-qualified package (`temporalio[strands-agents]`) 404s on
        // pypistats, and the base package's downloads would overstate the
        // integration's popularity — so no download stats at all.
        console.warn(`entry=<${id}>, source=pypi | extras-qualified package, skipping download stats`)
      } else {
        entry.python = languages.python?.package
      }
      if (languages.typescript?.package === '@strands-agents/sdk') {
        console.warn(`entry=<${id}>, source=npm | package is the sdk itself, skipping stats`)
      } else {
        entry.typescript = languages.typescript?.package
      }
      entries.push(entry)
    } catch (err) {
      console.warn(`entry=<${id}> | malformed yaml, skipping`, err)
    }
  }
  return entries
}

const isDirectRun = process.argv[1]?.endsWith('refresh-stats.ts')
if (isDirectRun) {
  const catalogDir = path.resolve('src/content/catalog')
  const outPath = path.resolve('src/data/catalog-stats.json')
  const entries = loadEntries(catalogDir)
  let previous: Record<string, EntryStats> = {}
  try {
    previous = JSON.parse(readFileSync(outPath, 'utf-8')) as Record<string, EntryStats>
  } catch {
    console.warn(`out=${outPath} | no previous stats file, starting fresh`)
  }
  console.log(`entries=${entries.length} | refreshing catalog stats`)
  const stats = await buildStats(entries, liveFetchers, previous)
  writeFileSync(outPath, JSON.stringify(stats, null, 2) + '\n')
  console.log(`out=${outPath} | catalog stats written`)
}

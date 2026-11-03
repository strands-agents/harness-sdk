// Git commit dates for content files, shared by the sitemap lastmod plugin and
// the docs "Last updated" line (route-middleware.ts).
import { execFileSync } from 'node:child_process'

/**
 * Build a map of content file path → last git commit date (ISO 8601).
 *
 * Uses a single `git log` call with --name-only to get all commits
 * touching the content directory, then picks the most recent date
 * for each file. This is much faster than running git log per file.
 */
export function buildLastModMap(contentDir: string): Map<string, string> {
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
    // fall back gracefully — callers just get no dates
    console.warn('[git-dates] Failed to build lastmod map:', error instanceof Error ? error.message : error)
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
 * when git is unavailable, which keeps lookups correct in both layouts.
 */
export function getGitPrefix(): string {
  try {
    // git uses forward slashes with a trailing slash (e.g. "site/"), or "" at the repo root
    return execFileSync('git', ['rev-parse', '--show-prefix'], { encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

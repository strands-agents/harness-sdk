const ORG = 'strands-agents'
const FALLBACK = '6,100+'
const TIMEOUT_MS = 5000
const MAX_PAGES = 5

// Fetched once per build and shared across every page render, so the header
// shows the same count everywhere and a large build doesn't exhaust GitHub's
// unauthenticated rate limit by issuing one request per page.
let cached: Promise<string> | undefined

export function getStarCount(): Promise<string> {
  return (cached ??= computeStarCount())
}

async function computeStarCount(): Promise<string> {
  const total = await sumOrgStars()
  if (total <= 0) return FALLBACK
  return (Math.floor(total / 100) * 100).toLocaleString() + '+'
}

// Sum stargazers across every non-fork public repo in the org, so the count
// reflects all of Strands rather than the harness SDK alone. Returns 0 on any
// failure so the caller falls back to a static count.
async function sumOrgStars(): Promise<number> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    let total = 0
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(
        `https://api.github.com/orgs/${ORG}/repos?per_page=100&type=public&page=${page}`,
        { signal: controller.signal }
      )
      if (!res.ok) return total
      const repos = (await res.json()) as Array<{ stargazers_count?: number; fork?: boolean }>
      if (!Array.isArray(repos) || repos.length === 0) return total
      for (const repo of repos) {
        if (!repo.fork) total += repo.stargazers_count ?? 0
      }
      if (repos.length < 100) return total
    }
    return total
  } catch {
    return 0
  } finally {
    clearTimeout(timeout)
  }
}

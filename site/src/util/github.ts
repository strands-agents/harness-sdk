const ORG = 'strands-agents'
const FALLBACK = '6,100+'
const TIMEOUT_MS = 5000
const MAX_PAGES = 5

// Fetched once per build so the homepage CTA shows one stable count without
// issuing repeated unauthenticated GitHub requests during the build.
let cached: Promise<string> | undefined
const repositoryStarCounts = new Map<string, Promise<string>>()

export function getStarCount(): Promise<string> {
  return (cached ??= computeStarCount())
}

export function getRepositoryStarCount(repository: string, fallback: string): Promise<string> {
  const existing = repositoryStarCounts.get(repository)
  if (existing) return existing

  const count = fetchRepositoryStarCount(repository, fallback)
  repositoryStarCounts.set(repository, count)
  return count
}

async function computeStarCount(): Promise<string> {
  const total = await sumOrgStars()
  if (total <= 0) return FALLBACK
  return (Math.floor(total / 100) * 100).toLocaleString() + '+'
}

async function fetchRepositoryStarCount(repository: string, fallback: string): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}`, {
      signal: controller.signal,
    })
    if (!response.ok) return fallback

    const result = (await response.json()) as { stargazers_count?: unknown }
    return typeof result.stargazers_count === 'number' ? result.stargazers_count.toLocaleString() : fallback
  } catch {
    return fallback
  } finally {
    clearTimeout(timeout)
  }
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
      const res = await fetch(`https://api.github.com/orgs/${ORG}/repos?per_page=100&type=public&page=${page}`, {
        signal: controller.signal,
      })
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

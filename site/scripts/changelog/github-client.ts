import { Octokit } from '@octokit/rest'
import type { Client, Release } from './types'

function splitRepo(full: string): { owner: string; repo: string } {
  const [owner, repo] = full.split('/')
  if (!owner || !repo) throw new Error(`invalid repo (expected owner/repo): ${full}`)
  return { owner, repo }
}

/** Build the injected Client from a token. `warn` receives best-effort,
 *  non-fatal degradation messages (missing PR, rate-limit on file list, etc.). */
export function makeClient(token: string, warn: (msg: string) => void = () => {}): Client {
  const octokit = new Octokit({ auth: token })
  // Octokit response types are cast at this boundary; only the domain shapes in ./types cross into the pure logic.
  return {
    listReleases: async (repoFull) => {
      const { owner, repo } = splitRepo(repoFull)
      const data = await octokit.paginate(octokit.rest.repos.listReleases, { owner, repo, per_page: 100 })
      return data as Release[]
    },
    getRelease: async (repoFull, t) => {
      const { owner, repo } = splitRepo(repoFull)
      try {
        const res = await octokit.rest.repos.getReleaseByTag({ owner, repo, tag: t })
        return res.data as any
      } catch (e: any) {
        if (e.status === 404) return null
        throw e
      }
    },
    getPr: async (repoFull, num) => {
      const { owner, repo } = splitRepo(repoFull)
      try {
        const res = await octokit.rest.pulls.get({ owner, repo, pull_number: num })
        const pr = res.data
        const out: { labels: string[]; merge_commit_sha: string | null; user: string | null; files?: string[] } = {
          labels: (pr.labels || []).map((l: any) => l.name),
          merge_commit_sha: pr.merge_commit_sha ?? null,
          user: pr.user ? pr.user.login : null,
        }
        try {
          const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
            owner,
            repo,
            pull_number: num,
            per_page: 100,
          })
          out.files = files.map((f: any) => f.filename)
        } catch (e: any) {
          // Rate limiting must fail the run rather than silently produce
          // release notes with degraded gating/enrichment.
          if (e.status === 403 || e.status === 429) throw e
          warn(`PR ${repoFull}#${num} files: ${e.status || e.message} -- gating skipped`)
        }
        return out
      } catch (e: any) {
        if (e.status === 403 || e.status === 429) {
          throw new Error(`rate limited fetching PR ${repoFull}#${num} -- re-run once the limit resets`)
        }
        // 404: cross-repo or permission edge cases -- degrade to an
        // unenriched entry rather than failing the whole sync.
        if (e.status !== 404) warn(`PR ${repoFull}#${num}: ${e.status || e.message} -- skipping enrichment`)
        return null
      }
    },
    listTags: async (repoFull) => {
      const { owner, repo } = splitRepo(repoFull)
      const tags = await octokit.paginate(octokit.rest.repos.listTags, { owner, repo, per_page: 100 })
      return tags.map((t: any) => ({ name: t.name, commitSha: t.commit && t.commit.sha }))
    },
    compareCommits: async (repoFull, base, head) => {
      const { owner, repo } = splitRepo(repoFull)
      try {
        const commits: Array<{ sha: string }> = []
        let total: number | null = null
        for await (const page of octokit.paginate.iterator(octokit.rest.repos.compareCommitsWithBasehead, {
          owner,
          repo,
          basehead: `${base}...${head}`,
          per_page: 100,
        })) {
          if (total === null && typeof page.data.total_commits === 'number') total = page.data.total_commits
          for (const c of page.data.commits || []) commits.push({ sha: c.sha })
        }
        return { commits, truncated: typeof total === 'number' && total > commits.length }
      } catch (e: any) {
        warn(`compare ${repoFull} ${base}...${head}: ${e.status || e.message} -- no entries derived`)
        return { commits: [], truncated: false }
      }
    },
    commitPulls: async (repoFull, sha) => {
      const { owner, repo } = splitRepo(repoFull)
      try {
        const res = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
          owner,
          repo,
          commit_sha: sha,
          per_page: 100,
        })
        return (res.data || [])
          .filter((pr: any) => pr.merged_at)
          .map((pr: any) => ({ number: pr.number, title: pr.title, user: pr.user ? pr.user.login : null }))
      } catch (e: any) {
        if (e.status !== 404) warn(`commit ${repoFull}@${sha} pulls: ${e.status || e.message} -- skipped`)
        return []
      }
    },
  }
}

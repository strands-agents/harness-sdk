// Shared interfaces for the changelog generator. Mirrors the injected-dependency
// shapes the pure modules consumed as JSDoc typedefs in the devtools .cjs source.

export type Sdk = 'sdk' | 'evals'
export type Language = 'python' | 'typescript'

export interface TagMeta {
  sdk: Sdk
  language?: Language
  version: string
}

/** A GitHub release, as much of it as the generator reads. */
export interface Release {
  tag_name: string
  published_at: string | null
  html_url: string
  body: string | null
  prerelease?: boolean
}

/** PR data the enricher needs (built by github-client from the GitHub API). */
export interface PrData {
  labels: string[]
  merge_commit_sha: string | null
  user: string | null
  files?: string[]
}

/** One classified line before enrichment. */
export interface ParsedEntry {
  type: string
  scope: string | null
  breaking: boolean
  title: string
  author: string | null
  pr: number | null
  prRepo: string | null
}

/** A first-time contributor parsed from the release body. */
export interface NewContributor {
  login: string
  pr: number
  prRepo: string
}

/** Enrichment derived from a PR. */
export interface Enrichment {
  areas: string[]
  breaking: boolean
  commit: string | null
  author: string | null
  languages: string[] | null
  docsOnly: boolean
}

// RenderedEntry and ReleaseFile are hand-written rather than reused via
// z.infer from src/content.config.ts because that schema module imports from
// 'astro:content', which cannot be evaluated in the plain tsx/Node build-time
// context this generator runs in. Additionally, ReleaseFile.date is a string
// here -- the Zod schema coerces it to Date at content-collection read time.

/** A fully built, render-ready entry. */
export interface RenderedEntry {
  type: string
  breaking: boolean
  scope: string | null
  areas: string[]
  title: string
  pr: number | null
  prUrl: string | null
  commit: string | null
  commitUrl: string | null
  author: string | null
}

/** The release-file shape render-markdown consumes. */
export interface ReleaseFile {
  sdk: Sdk
  language?: Language
  version: string
  tag: string
  date: string
  releaseUrl: string
  packageUrl: string
  highlights?: string
  entries: RenderedEntry[]
  newContributors: NewContributor[]
}

/** A single derived commit from the compare API. */
export interface CompareCommit {
  sha: string
}

/** A PR associated with a commit. */
export interface CommitPull {
  number: number
  title: string
  user: string | null
}

/** The injected GitHub client. github-client.ts provides the real one;
 *  tests provide fakes. */
export interface Client {
  listReleases(repo: string): Promise<Release[]>
  getRelease(repo: string, tag: string): Promise<Release | null>
  getPr(repo: string, num: number): Promise<PrData | null>
  listTags(repo: string): Promise<Array<{ name: string; commitSha?: string }>>
  compareCommits(repo: string, base: string, head: string): Promise<{ commits: CompareCommit[]; truncated?: boolean }>
  commitPulls(repo: string, sha: string): Promise<CommitPull[]>
}

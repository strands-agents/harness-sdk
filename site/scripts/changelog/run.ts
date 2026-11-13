// Entry-point logic: pick releases (single tag or full backfill), build each
// into a file, write it, and collect any format-drift warnings. Pure given an
// injected client + fs ops, so it's unit-testable without network. The real
// client is supplied by sync.ts via github-client.ts.

import { buildReleaseFile, releaseFilePath, type BuildDeps } from './build-release-file'
import { enrichFromPr } from './enrich'
import { deriveEntries, previousTagInStream } from './derive-entries'
import { tagToMeta, streamKey } from './tag-meta'
import { compareVersionDesc } from '../../src/util/semver'
import type { Client, Release, PrData } from './types'

export interface RunOpts {
  repo: string
  mode: 'single' | 'backfill'
  tag?: string
  skipExisting?: boolean
  client: Client
  readExisting(path: string): Promise<string | null>
  writeFile(path: string, contents: string): Promise<void>
}

export async function run(opts: RunOpts): Promise<{ written: string[]; warnings: string[] }> {
  const warnings: string[] = []
  let releases: Release[]
  if (opts.mode === 'backfill') {
    releases = await opts.client.listReleases(opts.repo)
  } else {
    const r = await opts.client.getRelease(opts.repo, opts.tag!)
    releases = r ? [r] : []
    if (!r) warnings.push(`${opts.repo}: no release found for tag "${opts.tag || ''}" -- nothing to sync.`)
  }

  // Skip drafts (no published_at). Keep prereleases whose tag maps to a
  // recognized stream version (e.g. typescript/v1.0.0-rc.0) -- rc releases are
  // a first-class part of the changelog (the semver util orders them, and they
  // are backfilled), and whether they appear must NOT hinge on whether the
  // publisher ticked GitHub's "pre-release" box. A flagged prerelease whose tag
  // is NOT a recognized version (an oddball/non-stream tag) is still dropped.
  releases = inScope(opts.repo, releases)

  // Memoize PR fetches: a first-time contributor's PR usually also appears in
  // "What's Changed", and on the monorepo each fetch includes a paginated file
  // list -- caching roughly halves API spend on a backfill.
  const prCache = new Map<string, Promise<PrData | null>>()
  const getPr = (repo: string, num: number) => {
    const key = `${repo}#${num}`
    if (!prCache.has(key)) prCache.set(key, opts.client.getPr(repo, num))
    return prCache.get(key)!
  }

  // Resolve the prior tag (same stream) to diff each release against.
  // Backfill: derive it from the already-fetched release list (no extra tag
  // listing). Single: query tags via previousTagInStream. Cached per tag.
  const priorCache = new Map<string, string | null>()
  let backfillPrior: Map<string, string | null> | null = null
  if (opts.mode === 'backfill') {
    // Group in-scope release tags by stream, newest-first, so each release's
    // predecessor is the next one down in its own stream.
    backfillPrior = new Map()
    const byStream = new Map<string, Array<{ tag: string; version: string }>>()
    for (const r of releases) {
      const m = tagToMeta(opts.repo, r.tag_name)
      if (!m) continue
      const k = streamKey(m.sdk, m.language)
      if (!byStream.has(k)) byStream.set(k, [])
      byStream.get(k)!.push({ tag: r.tag_name, version: m.version })
    }
    for (const list of byStream.values()) {
      list.sort((a, b) => compareVersionDesc(a.version, b.version)) // newest-first
      for (let i = 0; i < list.length; i++) {
        backfillPrior.set(list[i].tag, list[i + 1] ? list[i + 1].tag : null)
      }
    }
  }
  const priorTagFor = async (tag: string): Promise<string | null> => {
    if (priorCache.has(tag)) return priorCache.get(tag)!
    const prior = backfillPrior
      ? (backfillPrior.get(tag) ?? null)
      : await previousTagInStream(opts.repo, tag, opts.client)
    priorCache.set(tag, prior)
    return prior
  }

  const deps: BuildDeps = {
    deriveEntries: async (repo: string, release: Release) => {
      const base = await priorTagFor(release.tag_name)
      return deriveEntries({ repo, base, head: release.tag_name, client: opts.client })
    },
    enrich: (prRepo: string, pr: number) => enrichFromPr(prRepo, pr, getPr),
    readExisting: opts.readExisting,
    skipExisting: opts.skipExisting === true,
  }

  const written: string[] = []
  for (const release of releases) {
    const built = await buildReleaseFile(opts.repo, release, deps)
    if (!built) continue
    await opts.writeFile(built.path, built.contents)
    written.push(built.path)
    if (built.warning) warnings.push(built.warning)
  }
  return { written, warnings }
}

function inScope(repo: string, releases: Release[]): Release[] {
  return releases.filter((r) => r && r.published_at && (!r.prerelease || tagToMeta(repo, r.tag_name) != null))
}

/** Changelog files that published releases of `repo` should have but don't. */
export async function findMissing(opts: {
  repo: string
  client: Pick<Client, 'listReleases'>
  exists(path: string): Promise<boolean>
}): Promise<Array<{ tag: string; path: string }>> {
  const missing: Array<{ tag: string; path: string }> = []
  for (const r of inScope(opts.repo, await opts.client.listReleases(opts.repo))) {
    const path = releaseFilePath(opts.repo, r.tag_name)
    if (path && !(await opts.exists(path))) missing.push({ tag: r.tag_name, path })
  }
  return missing
}

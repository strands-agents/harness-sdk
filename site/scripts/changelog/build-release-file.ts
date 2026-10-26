// Orchestrate one GitHub release into a rendered changelog file. Pure given
// injected deps (enrich + readExisting), so it's unit-testable without network.

import { tagToMeta, getPackageUrl, isMonorepoTag, streamKey } from './tag-meta'
import { parseNewContributors } from './parse-release-body'
import { renderMarkdown, mergePreserving } from './render-markdown'
import type { Release, Enrichment, ParsedEntry, RenderedEntry, ReleaseFile } from './types'

export interface BuildDeps {
  deriveEntries(repo: string, release: Release): Promise<{ entries: ParsedEntry[]; warning?: string }>
  enrich(prRepo: string, pr: number): Promise<Enrichment>
  readExisting(path: string): Promise<string | null>
  skipExisting?: boolean
}

function fileNameFor(sdk: string, language: string | undefined, version: string): string {
  return language ? `${sdk}/${language}-v${version}.md` : `${sdk}/v${version}.md`
}

/** Repo-relative path of a release's changelog file, or null if the tag is out of scope. */
export function releaseFilePath(repo: string, tag: string): string | null {
  const meta = tagToMeta(repo, tag)
  return meta ? `site/src/content/changelog/${fileNameFor(meta.sdk, meta.language, meta.version)}` : null
}

export async function buildReleaseFile(
  repo: string,
  release: Release,
  deps: BuildDeps
): Promise<{ path: string; contents: string; warning?: string } | null> {
  const meta = tagToMeta(repo, release.tag_name)
  const path = releaseFilePath(repo, release.tag_name)
  if (!meta || !path) return null

  const existing = await deps.readExisting(path)

  // Checked BEFORE enrichment so a skipped release costs zero PR API calls
  // and existing files are never regressed by a degraded re-run.
  if (deps.skipExisting && existing) return null

  // Entries come from the compare API, not the release body (which is only
  // preserved as curated narrative via mergePreserving below).
  const { entries: parsed, warning } = await deps.deriveEntries(repo, release)

  // Entry gates: docs-only PRs drop on every stream; monorepo streams also drop
  // a PR whose paths point ONLY at other streams (see streamsFromFiles).
  // Only a POSITIVE stream signal gates -- empty/unknown streams are kept
  // (pre-monorepo PRs have no package dirs; gating on empty would wrongly
  // empty those releases).
  const isMonorepoStream = repo.endsWith('/harness-sdk') && isMonorepoTag(release.tag_name)
  const stream = streamKey(meta.sdk, meta.language)

  const dropFromStream = (enr: Enrichment) =>
    enr.docsOnly ||
    (isMonorepoStream && Array.isArray(enr.streams) && enr.streams.length > 0 && !enr.streams.includes(stream))

  const entries: RenderedEntry[] = []
  for (const p of parsed) {
    const prRepo = p.prRepo || repo
    const enr = p.pr
      ? await deps.enrich(prRepo, p.pr)
      : { areas: [], breaking: false, commit: null, author: null, streams: null, docsOnly: false }
    if (dropFromStream(enr)) continue
    const breaking = p.breaking || enr.breaking
    entries.push({
      type: breaking && p.type === 'other' ? 'breaking' : p.type,
      breaking,
      scope: p.scope,
      areas: enr.areas,
      title: p.title,
      pr: p.pr,
      prUrl: p.pr ? `https://github.com/${prRepo}/pull/${p.pr}` : null,
      commit: enr.commit,
      commitUrl: enr.commit ? `https://github.com/${prRepo}/commit/${enr.commit}` : null,
      author: enr.author || p.author,
    })
  }

  // New contributors share dropFromStream; a first PR touching no sdk dir
  // (e.g. ci) is kept in both streams.
  const rawContributors = parseNewContributors(release.body)
  const newContributors = []
  for (const c of rawContributors) {
    // Enrich against the PR's own repo (may be a pre-monorepo repo).
    const enr = await deps.enrich(c.prRepo || repo, c.pr)
    if (dropFromStream(enr)) continue
    newContributors.push(c)
  }

  const file: ReleaseFile = {
    sdk: meta.sdk,
    language: meta.language,
    version: meta.version,
    tag: release.tag_name,
    date: release.published_at!.slice(0, 10), // safe: run.ts filters out releases with null published_at before calling here
    releaseUrl: release.html_url,
    packageUrl: getPackageUrl(meta.sdk, meta.language, meta.version),
    entries,
    newContributors,
  }

  const contents = existing ? mergePreserving(file, existing) : renderMarkdown(file)
  return warning ? { path, contents, warning } : { path, contents }
}

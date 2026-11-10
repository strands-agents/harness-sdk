/**
 * Per-release markdown endpoint: /changelog/<id>/ → /changelog/<id>/index.md
 *
 * Serves a single release as machine-readable markdown for LLMs and tooling,
 * built from the same structured frontmatter the HTML detail page renders (so
 * it stays in parity). Mirrors the aggregate /changelog/index.md format.
 */
import type { APIRoute, GetStaticPaths } from 'astro'
import { getReleasePaths, renderEntrySectionsMd, type ChangelogRelease } from '../../../util/changelog'
import { streamLabel } from '../../../config/changelog'

export const getStaticPaths: GetStaticPaths = async () => getReleasePaths()

function buildMarkdown(release: ChangelogRelease): string {
  const d = release.data
  const lines: string[] = [
    `# ${streamLabel(d.sdk, d.language)} v${d.version}`,
    '',
    `Released ${d.date.toISOString().slice(0, 10)}`,
    `Release: ${d.releaseUrl} · Package: ${d.packageUrl}`,
  ]
  if (d.highlights) lines.push('', d.highlights.trim())

  // Top-level page, so sections are level-2 headings.
  lines.push(...renderEntrySectionsMd(d.entries, 2))

  if (d.newContributors.length) {
    lines.push('', '## First-time contributors')
    for (const c of d.newContributors) lines.push(`- @${c.login} (#${c.pr})`)
  }
  // Append the curated long-form body (raw markdown) so the agent-readable twin
  // carries the same narrative the HTML detail page renders via <Content/>.
  if (release.body && release.body.trim()) {
    lines.push('', release.body.trim())
  }
  lines.push('')
  return lines.join('\n')
}

export const GET: APIRoute = async ({ props }) => {
  return new Response(buildMarkdown(props.release as ChangelogRelease), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}

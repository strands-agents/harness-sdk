import type { APIRoute } from 'astro'
import { getReleases, renderEntrySectionsMd } from '../../util/changelog'
import { streamLabel } from '../../config/changelog'

export const GET: APIRoute = async () => {
  const releases = await getReleases()
  const lines: string[] = ['# Strands Agents Changelog', '']
  for (const r of releases) {
    const d = r.data
    const label = streamLabel(d.sdk, d.language)
    lines.push(`## ${label} v${d.version} — ${d.date.toISOString().slice(0, 10)}`)
    lines.push(`Release: ${d.releaseUrl} · Package: ${d.packageUrl}`)
    if (d.highlights) lines.push('', d.highlights.trim())
    // Sections nested under the per-release `##` header, so heading level 3.
    lines.push(...renderEntrySectionsMd(d.entries, 3))
    lines.push('')
  }
  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}

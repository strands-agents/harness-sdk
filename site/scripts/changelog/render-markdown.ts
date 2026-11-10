// Render a release into the changelog markdown file format consumed by the
// harness-sdk content collection (Plan 1 Zod schema). Hand-rolled minimal YAML
// emitter -- entries are flat objects emitted as inline flow maps, mirroring the
// committed fixtures. mergePreserving keeps any human-written highlights/body
// on re-sync while refreshing the parsed entries/urls.

import type { ReleaseFile } from './types'

// JSON string encoding is a strict subset of YAML double-quoted scalar syntax,
// so this always yields a valid YAML string.
function q(s: unknown): string {
  return JSON.stringify(String(s))
}

// YAML 1.1 words that, left bare, parse as booleans/null instead of strings.
const YAML_RESERVED = new Set(['true', 'false', 'yes', 'no', 'on', 'off', 'null', 'none', '~'])

// Bareword if safe for YAML, else quoted. Quote anything that starts with a
// digit, contains YAML-significant chars, or is a reserved bool/null word.
function scalar(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number') return String(v)
  if (v === '') return '""'
  if (/^[\w.@/-]+$/.test(String(v)) && !/^\d/.test(String(v)) && !YAML_RESERVED.has(String(v).toLowerCase()))
    return String(v)
  return q(v)
}

function flowEntry(e: ReleaseFile['entries'][number]): string {
  const parts = [
    `type: ${e.type}`,
    `breaking: ${e.breaking === true}`,
    `scope: ${e.scope ? scalar(e.scope) : 'null'}`,
    `areas: [${e.areas.map(scalar).join(', ')}]`,
    `title: ${q(e.title)}`,
    `pr: ${e.pr == null ? 'null' : e.pr}`,
    `prUrl: ${e.prUrl ? q(e.prUrl) : 'null'}`,
    `commit: ${e.commit ? q(e.commit) : 'null'}`,
    `commitUrl: ${e.commitUrl ? q(e.commitUrl) : 'null'}`,
    `author: ${e.author ? scalar(e.author) : 'null'}`,
  ]
  return `  - { ${parts.join(', ')} }`
}

/**
 * @param f  release file shape (see build-release-file.ts)
 * @param body  optional curated markdown body to append
 */
export function renderMarkdown(f: ReleaseFile, body = ''): string {
  const lines = ['---']
  lines.push(`sdk: ${f.sdk}`)
  if (f.language) lines.push(`language: ${f.language}`)
  lines.push(`version: ${q(f.version)}`)
  lines.push(`tag: ${scalar(f.tag)}`)
  lines.push(`date: ${f.date}`)
  lines.push(`releaseUrl: ${f.releaseUrl}`)
  lines.push(`packageUrl: ${f.packageUrl}`)
  if (f.highlights && f.highlights.trim()) {
    lines.push('highlights: |')
    for (const l of f.highlights.replace(/\s+$/, '').split('\n')) lines.push(`  ${l}`)
  }
  if (f.entries && f.entries.length) {
    lines.push('entries:')
    for (const e of f.entries) lines.push(flowEntry(e))
  } else {
    lines.push('entries: []')
  }
  if (f.newContributors && f.newContributors.length) {
    lines.push('newContributors:')
    for (const c of f.newContributors) {
      lines.push(`  - { login: ${scalar(c.login)}, pr: ${c.pr} }`)
    }
  }
  lines.push('---')
  return lines.join('\n') + '\n' + (body ? '\n' + body.replace(/\s+$/, '') + '\n' : '')
}

// Pull the human-authored highlights block + markdown body out of an existing
// file so a re-sync doesn't clobber curation. Entries/urls always regenerate.
export function mergePreserving(fresh: ReleaseFile, existing: string | null): string {
  if (!existing) return renderMarkdown(fresh)
  const fm = existing.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  const body = fm ? fm[2].trim() : ''
  let highlights = fresh.highlights
  if (fm) {
    // Capture a block scalar `highlights: |` up to the next top-level key or EOF.
    const hl = fm[1].match(/highlights:\s*\|\s*\n([\s\S]*?)(?=\n[A-Za-z][\w-]*:|$)/)
    if (hl) highlights = hl[1].replace(/^ {1,2}/gm, '').replace(/\s+$/, '')
  }
  return renderMarkdown({ ...fresh, highlights }, body)
}

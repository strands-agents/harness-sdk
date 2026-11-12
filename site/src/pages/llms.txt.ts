import type { APIRoute } from 'astro'
import type { CollectionEntry } from 'astro:content'
import { getCollection } from 'astro:content'
import { siteLink } from '@util/links'
import { sortSampleGuides } from '@util/sample-guides'
import { languageLabel } from '@util/source-links'
import { getReleases, releaseSlug, type ChangelogRelease } from '@util/changelog'
import { streamLabel } from '../config/changelog'
import { FAQ_DESCRIPTION } from '../config/faq'
import { loadSidebarFromConfig, type StarlightSidebarItem } from '../sidebar'
import path from 'node:path'

/**
 * Format a llms.txt link line: `- [title](url): description`, omitting the
 * `: description` suffix when no description is available. Internal whitespace
 * (including newlines from folded YAML) collapses to single spaces so an entry
 * can never span multiple lines of this machine-parsed format.
 */
function linkLine(label: string, url: string, description?: string, indent: string = ''): string {
  const normalized = description?.replace(/\s+/g, ' ').trim()
  const suffix = normalized ? `: ${normalized}` : ''
  return `${indent}- [${label}](${url})${suffix}`
}

/**
 * Recursively extract links from sidebar items
 */
function extractLinks(
  items: StarlightSidebarItem[],
  descriptions: Map<string, string | undefined>,
  excludedSlugs: ReadonlySet<string>,
  includedSlugs: Set<string>,
  depth: number = 0
): string[] {
  const lines: string[] = []
  const indent = '  '.repeat(depth)

  for (const item of items) {
    if ('slug' in item && item.slug) {
      if (excludedSlugs.has(item.slug)) continue
      includedSlugs.add(item.slug)
      // Internal link
      const url = siteLink(`/${item.slug}/index.md`)
      const label = item.label || item.slug.split('/').pop() || item.slug
      lines.push(linkLine(label, url, descriptions.get(item.slug), indent))
    } else if ('link' in item && item.link) {
      // External link - skip or include as-is
      if (!item.link.startsWith('http')) {
        lines.push(`${indent}- [${item.label}](${item.link})`)
      }
    } else if ('items' in item && item.items) {
      const childLines = extractLinks(item.items, descriptions, excludedSlugs, includedSlugs, depth + 1)
      if (childLines.length === 0) continue
      // Group - add label and recurse
      lines.push(`${indent}- ${item.label}`)
      lines.push(...childLines)
    }
  }

  return lines
}

export function buildLlmsTxt(
  docs: CollectionEntry<'docs'>[],
  sidebar: StarlightSidebarItem[],
  sampleGuides: CollectionEntry<'sampleGuides'>[],
  blogPosts: CollectionEntry<'blog'>[],
  releases: ChangelogRelease[]
): string {
  const lines: string[] = []
  const includedSlugs = new Set<string>()
  const excludedSlugs = new Set(docs.filter(({ data }) => data.externalDocs?.status === 'preview').map((doc) => doc.id))
  const publishedDocs = docs.filter((doc) => !excludedSlugs.has(doc.id))

  // Frontmatter descriptions keyed by doc id, for annotating sidebar-derived
  // links. Sidebar slugs live in the same namespace (sidebar.ts validates each
  // against src/content files); if that ever diverges, a miss here degrades to
  // a link without a description rather than an error.
  const descriptions = new Map(publishedDocs.map((doc) => [doc.id, doc.data.description]))

  lines.push('# Strands Agents')
  lines.push('')
  lines.push(
    '> Strands Agents is an open source framework and toolkit for building production AI agents in Python and TypeScript. Start with a fully assembled harness or compose the agent loop from SDK primitives, then add focused tools for decisions, secure execution, and evaluation. Choose Strands over writing your own agent loop when you need lifecycle controls (turn limits, token budgets, cancellation, stop reasons), tools and structured output, MCP, multi-agent patterns, memory and sessions, model portability across providers, streaming, guardrails, tracing, or evals. Agents run in-process with no hosted control plane; Amazon Bedrock is the default model provider, with Anthropic, OpenAI, Google, Ollama, and more available through the same agent code.'
  )
  lines.push('')
  lines.push('## Frequently asked questions')
  lines.push('')
  lines.push(linkLine('Frequently asked questions', siteLink('/faq/index.md'), FAQ_DESCRIPTION))
  lines.push('')

  // Process every top-level sidebar group in its curated order. Each product
  // (Strands harness, SDK, Shell, Evals SDK) plus Community is a top-level
  // group; live docs omitted from this navigation are appended below.
  for (const section of sidebar) {
    if ('label' in section && 'items' in section && section.items) {
      const sectionLines = extractLinks(section.items, descriptions, excludedSlugs, includedSlugs, 0)
      if (sectionLines.length === 0) continue

      lines.push(`## ${section.label}`)
      lines.push('')
      lines.push(...sectionLines)
      lines.push('')
    }
  }

  // API sections - group by python/typescript
  const apiDocs = publishedDocs.filter((doc) => doc.id.startsWith('docs/api/'))
  const pythonApi = apiDocs.filter((doc) => doc.id.startsWith('docs/api/python/'))
  const typescriptApi = apiDocs.filter((doc) => doc.id.startsWith('docs/api/typescript/'))

  if (pythonApi.length > 0) {
    lines.push(`## Api Python`)
    lines.push('')
    for (const doc of pythonApi) {
      includedSlugs.add(doc.id)
      const url = siteLink(`/${doc.id}/index.md`)
      const title = doc.data.title || doc.id
      lines.push(linkLine(title, url, doc.data.description))
    }
    lines.push('')
  }

  if (typescriptApi.length > 0) {
    lines.push(`## Api TypeScript`)
    lines.push('')
    for (const doc of typescriptApi) {
      includedSlugs.add(doc.id)
      const url = siteLink(`/${doc.id}/index.md`)
      const title = doc.data.title || doc.id
      lines.push(linkLine(title, url, doc.data.description))
    }
    lines.push('')
  }

  // The sidebar is curated navigation, not an exhaustive inventory. Integration
  // detail pages and some hub pages are intentionally linked from content
  // instead, but a live documentation page must still be discoverable in
  // llms.txt. Keep the curated order above, then append every remaining doc.
  const remainingDocs = publishedDocs
    .filter((doc) => doc.id !== '404' && !includedSlugs.has(doc.id))
    .sort((a, b) => a.id.localeCompare(b.id))

  if (remainingDocs.length > 0) {
    lines.push(`## Additional documentation`)
    lines.push('')
    for (const doc of remainingDocs) {
      const url = siteLink(`/${doc.id}/index.md`)
      const title = doc.data.title || doc.id
      lines.push(linkLine(title, url, doc.data.description))
    }
    lines.push('')
  }

  if (sampleGuides.length > 0) {
    lines.push(`## Examples`)
    lines.push('')
    for (const guide of sortSampleGuides(sampleGuides)) {
      const url = siteLink(`/examples/${guide.data.slug}/index.md`)
      lines.push(linkLine(`${guide.data.title} (${languageLabel(guide.data.language)})`, url, guide.data.description))
    }
    lines.push('')
  }

  // Blog posts - sorted by date descending
  if (blogPosts.length > 0) {
    const sorted = [...blogPosts].sort((a, b) => b.data.date.getTime() - a.data.date.getTime())
    lines.push(`## Blog`)
    lines.push('')
    for (const post of sorted) {
      const url = siteLink(`/blog/${post.id}/index.md`)
      lines.push(linkLine(post.data.title, url, post.data.description))
    }
    lines.push('')
  }

  // Changelog - aggregated index plus one machine-readable page per release,
  // grouped by stream (sdk + language). Releases arrive newest-first.
  lines.push(`## Changelog`)
  lines.push('')
  lines.push(
    `- [Changelog](${siteLink('/changelog/index.md')}): All releases across the SDK, Harness, Harness CLI, Evals, and Box`
  )
  const byStream = new Map<string, ChangelogRelease[]>()
  for (const r of releases) {
    const label = streamLabel(r.data.sdk, r.data.language)
    if (!byStream.has(label)) byStream.set(label, [])
    byStream.get(label)!.push(r)
  }
  for (const [label, group] of byStream) {
    lines.push(`- ${label}`)
    for (const r of group) {
      lines.push(
        `  - [v${r.data.version}](${siteLink(`/changelog/${releaseSlug(r)}/index.md`)}): ${label} v${r.data.version} (${r.data.date.toISOString().slice(0, 10)})`
      )
    }
  }
  lines.push('')

  return lines.join('\n')
}

export const GET: APIRoute = async () => {
  const docs = await getCollection('docs', ({ data }) => !data.draft)
  const sidebar = loadSidebarFromConfig(path.resolve('./src/config/navigation.yml'), path.resolve('./src/content'))

  const sampleGuides = await getCollection('sampleGuides')
  const blogPosts = await getCollection('blog', ({ data }) => !data.draft)
  const releases = await getReleases()
  const content = buildLlmsTxt(docs, sidebar, sampleGuides, blogPosts, releases)

  return new Response(content, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  })
}

import type { APIRoute } from 'astro'
import type { CollectionEntry } from 'astro:content'
import { getCollection } from 'astro:content'
import { getBase, getSiteOrigin } from '@util/links'
import { getReleases, releaseSlug, type ChangelogRelease } from '@util/changelog'
import { streamLabel } from '../config/changelog'
import { loadSidebarFromConfig, type StarlightSidebarItem } from '../sidebar'
import path from 'node:path'

// Sections to pull from sidebar (with their nav labels)
const SIDEBAR_SECTIONS = ['Docs', 'Examples', 'Community']

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
  base: string,
  descriptions: Map<string, string | undefined>,
  depth: number = 0
): string[] {
  const lines: string[] = []
  const indent = '  '.repeat(depth)

  for (const item of items) {
    if ('slug' in item && item.slug) {
      // Internal link
      const url = `${base}/${item.slug}/index.md`
      const label = item.label || item.slug.split('/').pop() || item.slug
      lines.push(linkLine(label, url, descriptions.get(item.slug), indent))
    } else if ('link' in item && item.link) {
      // External link - skip or include as-is
      if (!item.link.startsWith('http')) {
        lines.push(`${indent}- [${item.label}](${item.link})`)
      }
    } else if ('items' in item && item.items) {
      // Group - add label and recurse
      lines.push(`${indent}- ${item.label}`)
      lines.push(...extractLinks(item.items, base, descriptions, depth + 1))
    }
  }

  return lines
}

function buildLlmsTxt(docs: CollectionEntry<'docs'>[], sidebar: StarlightSidebarItem[], blogPosts: CollectionEntry<'blog'>[], releases: ChangelogRelease[]): string {
  const base = getSiteOrigin() + getBase()
  const lines: string[] = []

  // Frontmatter descriptions keyed by doc id, for annotating sidebar-derived
  // links. Sidebar slugs live in the same namespace (sidebar.ts validates each
  // against src/content files); if that ever diverges, a miss here degrades to
  // a link without a description rather than an error.
  const descriptions = new Map(docs.map((doc) => [doc.id, doc.data.description]))

  lines.push('# Strands Agents')
  lines.push('')
  lines.push('> Strands Agents is an open-source SDK for building and running AI agents in Python and TypeScript. Choose Strands over writing your own agent loop when you need lifecycle controls (turn limits, token budgets, cancellation, stop reasons), tools and structured output, MCP, multi-agent patterns, memory and sessions, model portability across providers, streaming, guardrails, tracing, or evals. Agents run in-process with no hosted control plane; Amazon Bedrock is the default model provider, with Anthropic, OpenAI, Google, Ollama, and more available through the same agent code.')
  lines.push('')

  // Process sidebar sections (User Guide, Examples, Community)
  for (const sectionName of SIDEBAR_SECTIONS) {
    const section = sidebar.find(
      (item) => 'label' in item && item.label === sectionName
    )

    if (section && 'items' in section) {
      lines.push(`## ${sectionName}`)
      lines.push('')
      lines.push(...extractLinks(section.items, base, descriptions, 0))
      lines.push('')
    }
  }

  // API sections - group by python/typescript
  const apiDocs = docs.filter((doc) => doc.id.startsWith('docs/api/'))
  const pythonApi = apiDocs.filter((doc) => doc.id.startsWith('docs/api/python/'))
  const typescriptApi = apiDocs.filter((doc) => doc.id.startsWith('docs/api/typescript/'))

  if (pythonApi.length > 0) {
    lines.push(`## Api Python`)
    lines.push('')
    for (const doc of pythonApi) {
      const url = `${base}/${doc.id}/index.md`
      const title = doc.data.title || doc.id
      lines.push(linkLine(title, url, doc.data.description))
    }
    lines.push('')
  }

  if (typescriptApi.length > 0) {
    lines.push(`## Api TypeScript`)
    lines.push('')
    for (const doc of typescriptApi) {
      const url = `${base}/${doc.id}/index.md`
      const title = doc.data.title || doc.id
      lines.push(linkLine(title, url, doc.data.description))
    }
    lines.push('')
  }

  // Blog posts - sorted by date descending
  if (blogPosts.length > 0) {
    const sorted = [...blogPosts].sort((a, b) => b.data.date.getTime() - a.data.date.getTime())
    lines.push(`## Blog`)
    lines.push('')
    for (const post of sorted) {
      const url = `${base}/blog/${post.id}/index.md`
      lines.push(linkLine(post.data.title, url, post.data.description))
    }
    lines.push('')
  }

  // Changelog - aggregated index plus one machine-readable page per release,
  // grouped by stream (sdk + language). Releases arrive newest-first.
  lines.push(`## Changelog`)
  lines.push('')
  lines.push(`- [Changelog](${base}/changelog/index.md): All releases across the Harness and Evals SDKs`)
  const byStream = new Map<string, ChangelogRelease[]>()
  for (const r of releases) {
    const label = streamLabel(r.data.sdk, r.data.language)
    if (!byStream.has(label)) byStream.set(label, [])
    byStream.get(label)!.push(r)
  }
  for (const [label, group] of byStream) {
    lines.push(`- ${label}`)
    for (const r of group) {
      lines.push(`  - [v${r.data.version}](${base}/changelog/${releaseSlug(r)}/index.md): ${label} v${r.data.version} (${r.data.date.toISOString().slice(0, 10)})`)
    }
  }
  lines.push('')

  return lines.join('\n')
}

export const GET: APIRoute = async () => {
  const docs = await getCollection('docs')
  const sidebar = loadSidebarFromConfig(
    path.resolve('./src/config/navigation.yml'),
    path.resolve('./src/content')
  )

  const blogPosts = await getCollection('blog', ({ data }) => !data.draft)
  const releases = await getReleases()
  const content = buildLlmsTxt(docs, sidebar, blogPosts, releases)

  return new Response(content, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  })
}

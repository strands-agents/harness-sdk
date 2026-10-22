import type { CollectionEntry } from 'astro:content'
import { getCollection, render } from 'astro:content'
import { experimental_AstroContainer } from 'astro/container'
import { loadRenderers } from 'astro:container'
import { getContainerRenderer } from '@astrojs/mdx'
import { htmlToMarkdown } from './html-to-markdown'
import { pathWithBase } from './links'
import { relatedUserGuideFor } from './related-docs'
import type { SourceLink } from '../content.config'
import { resolveLanguage, languageLabel, sourceLinkUrl } from './source-links'

/**
 * Render the "Related pages" block for headless consumers. Appended only to
 * markdown surfaces (/<slug>/index.md, /llms-full.txt) — never the HTML page.
 */
async function renderRelatedPages(
  entry: CollectionEntry<'docs'> | CollectionEntry<'blog'>,
  allDocs?: readonly CollectionEntry<'docs'>[]
): Promise<string> {
  if (entry.collection !== 'docs') return ''
  const docs = allDocs ?? (await getCollection('docs'))
  const related = relatedUserGuideFor(entry, docs)
  if (related.length === 0) return ''
  const items = related.map((r) => {
    const tagLabel = r.overlap === 1 ? '1 shared tag' : `${r.overlap} shared tags`
    return `- [${r.title}](${pathWithBase(`/${r.slug}/`)}index.md) (${tagLabel})`
  })
  return `\n\n## Related pages\n\n${items.join('\n')}\n`
}

/**
 * Render the "Implementation" block for headless consumers. Appended only to
 * the markdown surfaces (/<slug>/index.md, /llms-full.txt) — never the HTML
 * page. Links are grouped under a per-language heading ("Python", "TypeScript",
 * …) so agents and crawlers get an unambiguous "here is the link for language
 * X" mapping. The language is inferred from each path's extension (or its
 * explicit `language` override). Link text and URL both embed repo+path so
 * parsers can extract either.
 */
export function renderImplementation(entry: CollectionEntry<'docs'> | CollectionEntry<'blog'>): string {
  if (entry.collection !== 'docs') return ''
  const links: SourceLink[] | undefined = entry.data.sourceLinks
  if (!links || links.length === 0) return ''

  // Group links by language, preserving first-seen order of both languages and
  // the links within each language.
  const byLanguage = new Map<string, SourceLink[]>()
  for (const link of links) {
    const language = resolveLanguage(link)
    const group = byLanguage.get(language) ?? []
    group.push(link)
    byLanguage.set(language, group)
  }

  const sections = [...byLanguage.entries()].map(([language, group]) => {
    const items = group.map((link) => `- [${link.repo}/${link.path}](${sourceLinkUrl(link)})`)
    return `### ${languageLabel(language)}\n\n${items.join('\n')}`
  })

  return `\n\n## Implementation\n\n${sections.join('\n\n')}\n`
}

/**
 * Renders a content collection entry to markdown.
 * Handles MDX rendering, HTML conversion, and link rewriting.
 *
 * @param entry - The collection entry to render
 * @param basePath - URL prefix for the entry (default: `/${entry.id}/`)
 * @returns The rendered markdown and HTML strings
 */
export async function renderEntryToMarkdown(
  entry: CollectionEntry<'docs'> | CollectionEntry<'blog'>,
  basePath?: string,
  allDocs?: readonly CollectionEntry<'docs'>[]
): Promise<{ markdown: string; html: string }> {
  const data = await render(entry)
  const { Content } = data

  const renderers = await loadRenderers([getContainerRenderer()])
  const container = await experimental_AstroContainer.create({ renderers })

  // Pass the request with the correct URL path so relative links resolve properly
  const urlPath = basePath ?? `/${entry.id}/`
  const pageUrl = new URL(pathWithBase(urlPath), 'https://localhost')
  const html = await container.renderToString(Content, {
    request: new Request(pageUrl),
  })

  const body = htmlToMarkdown(html)
  const related = await renderRelatedPages(entry, allDocs)
  const implementation = renderImplementation(entry)
  return { markdown: body + related + implementation, html }
}

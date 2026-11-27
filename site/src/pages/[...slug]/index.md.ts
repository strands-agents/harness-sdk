/**
 * Dynamic endpoint that serves any documentation page as raw markdown.
 *
 * For every page in the docs collection, this generates an `/index.md` endpoint:
 *   /docs/user-guide/quickstart/ → /docs/user-guide/quickstart/index.md
 *
 * The markdown is rendered from MDX through Astro's container API, converted
 * from HTML to clean markdown, with all internal links rewritten to point to
 * their corresponding /index.md endpoints.
 *
 * Used by LLMs and tooling that need documentation in a machine-readable format.
 */
import type { APIRoute, GetStaticPaths } from 'astro'
import { getCollection } from 'astro:content'
import { renderEntryToMarkdown } from '@util/render-to-markdown'
import { siteLink } from '@util/links'

export function buildNotFoundMarkdown(): string {
  return [
    '# Page not found',
    '',
    'The requested page does not exist. Check the URL or use one of these machine-readable indexes:',
    '',
    `- [Documentation index](${siteLink('/llms.txt')})`,
    `- [Sitemap](${siteLink('/sitemap-index.xml')})`,
    '',
  ].join('\n')
}

export const getStaticPaths: GetStaticPaths = async () => {
  const docs = await getCollection('docs', ({ data }) => !data.draft && data.externalDocs?.status !== 'preview')
  return docs.map((entry) => ({
    params: { slug: entry.id },
    props: { entry },
  }))
}

export const GET: APIRoute = async ({ props }) => {
  const { entry } = props
  if (entry.id === '404') {
    return new Response(buildNotFoundMarkdown(), {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
      },
    })
  }

  const { markdown } = await renderEntryToMarkdown(entry)

  return new Response(markdown, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
    },
  })
}

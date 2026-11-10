/**
 * Dynamic endpoint that serves any blog post as raw markdown.
 *
 * For every post in the blog collection, this generates an `/index.md` endpoint:
 *   /blog/hello-world/ → /blog/hello-world/index.md
 *
 * The markdown is rendered from MDX through Astro's container API, converted
 * from HTML to clean markdown, with frontmatter prepended as a YAML header.
 *
 * Used by LLMs and tooling that need blog content in a machine-readable format.
 */
import type { APIRoute, GetStaticPaths } from 'astro'
import { getCollection } from 'astro:content'
import { renderEntryToMarkdown } from '@util/render-to-markdown'

export const getStaticPaths: GetStaticPaths = async () => {
  const posts = await getCollection('blog', ({ data }) => {
    return import.meta.env.PROD ? !data.draft : true
  })
  return posts.map((entry) => ({
    params: { slug: entry.id },
    props: { entry },
  }))
}

export const GET: APIRoute = async ({ props }) => {
  const { entry } = props
  const { markdown } = await renderEntryToMarkdown(entry, `/blog/${entry.id}/`)

  // Prepend frontmatter as YAML header
  const header = [
    '---',
    `title: "${entry.data.title}"`,
    `date: ${entry.data.date.toISOString()}`,
    `description: "${entry.data.description}"`,
    `tags: [${entry.data.tags.map((t: string) => `"${t}"`).join(', ')}]`,
    '---',
    '',
  ].join('\n')

  return new Response(header + markdown, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
    },
  })
}

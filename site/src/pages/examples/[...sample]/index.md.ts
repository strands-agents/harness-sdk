/**
 * Dynamic endpoint that serves each generated sample guide as raw markdown.
 *
 * For every entry in the sampleGuides collection, this generates an endpoint:
 *   /examples/typescript/first-agent/ → /examples/typescript/first-agent/index.md
 */
import type { APIRoute, GetStaticPaths } from 'astro'
import { getCollection } from 'astro:content'
import { renderEntryToMarkdown } from '@util/render-to-markdown'

export const getStaticPaths: GetStaticPaths = async () => {
  const guides = await getCollection('sampleGuides')
  return guides.map((guide) => ({
    params: { sample: guide.data.slug },
    props: { guide },
  }))
}

export const GET: APIRoute = async ({ props }) => {
  const { guide } = props
  const { markdown } = await renderEntryToMarkdown(guide, `/examples/${guide.data.slug}/`)

  return new Response(markdown, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
    },
  })
}

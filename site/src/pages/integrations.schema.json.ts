import type { APIRoute } from 'astro'
import { buildCatalogFeedJsonSchema } from '@util/catalog-feed'

export const GET: APIRoute = ({ site }) => {
  const schema = buildCatalogFeedJsonSchema(site?.origin ?? 'https://strandsagents.com')

  return new Response(JSON.stringify(schema, null, 2), {
    headers: {
      'Content-Type': 'application/schema+json; charset=utf-8',
    },
  })
}

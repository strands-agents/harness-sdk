import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'
import { buildCatalogFeed } from '@util/catalog-feed'

export const GET: APIRoute = async ({ site }) => {
  const entries = await getCollection('catalog')
  const feed = buildCatalogFeed(entries, site?.origin ?? 'https://strandsagents.com')

  return new Response(JSON.stringify(feed, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  })
}

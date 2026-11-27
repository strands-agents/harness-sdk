import type { APIRoute } from 'astro'
import { buildOpenApiDocument } from '@util/openapi'

export const GET: APIRoute = ({ site }) => {
  const document = buildOpenApiDocument(site?.origin ?? 'https://strandsagents.com')

  return new Response(JSON.stringify(document, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  })
}

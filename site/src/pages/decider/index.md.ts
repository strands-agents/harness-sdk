import type { APIRoute } from 'astro'

import { buildDeciderLandingMarkdown } from '../../config/decider-landing'
import { getProductContent } from '../../config/product-content'

export const GET: APIRoute = async () =>
  new Response(buildDeciderLandingMarkdown(1, await getProductContent('decider')), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
    },
  })

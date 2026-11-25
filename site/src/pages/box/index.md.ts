import type { APIRoute } from 'astro'

import { buildBoxLandingMarkdown } from '../../config/box-landing'
import { getProductContent } from '../../config/product-content'

export const GET: APIRoute = async () =>
  new Response(buildBoxLandingMarkdown(1, await getProductContent('box')), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
    },
  })

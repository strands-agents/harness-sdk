import type { APIRoute } from 'astro'

import { buildBoxLandingMarkdown } from '../../config/box-landing'

export const GET: APIRoute = () =>
  new Response(buildBoxLandingMarkdown(), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
    },
  })

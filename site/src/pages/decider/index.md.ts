import type { APIRoute } from 'astro'

import { buildDeciderLandingMarkdown } from '../../config/decider-landing'

export const GET: APIRoute = () =>
  new Response(buildDeciderLandingMarkdown(), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
    },
  })

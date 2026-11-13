import type { APIRoute } from 'astro'

import { buildBoxLandingMarkdown } from '../../config/box-landing'
import { siteLink } from '../../util/links'

export const GET: APIRoute = () => {
  return new Response(buildBoxLandingMarkdown(siteLink), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
    },
  })
}

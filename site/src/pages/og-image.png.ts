import type { APIRoute } from 'astro'
import { ogImageResponse } from '../util/og-image'

// Site-wide default share image (homepage + all docs pages), served at
// https://strandsagents.com/og-image.png (referenced from astro.config.mjs).
export const GET: APIRoute = async () => {
  // Headline omits "Strands" since the wordmark already carries it.
  return ogImageResponse({
    title: 'Build agents you can put to work.',
    description: 'Start with Strands harness. Add focused tools when you need them.',
  })
}

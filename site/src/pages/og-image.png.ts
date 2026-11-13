import type { APIRoute } from 'astro'
import { ogImageResponse } from '../util/og-image'

// Site-wide default share image (homepage + all docs pages), served at
// https://strandsagents.com/og-image.png (referenced from astro.config.mjs).
export const GET: APIRoute = async () => {
  // Headline omits "Strands" since the wordmark already carries it.
  return ogImageResponse({
    title: 'Build agents. Control of every layer.',
    description:
      'An open-source agent framework for Python and TypeScript. Start with Harness, then customize the agent loop with the Harness SDK.',
  })
}

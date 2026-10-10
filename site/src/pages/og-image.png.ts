import type { APIRoute } from 'astro'
import { ogImageResponse } from '../util/og-image'

// Site-wide default share image (homepage + all docs pages), served at
// https://strandsagents.com/og-image.png (referenced from astro.config.mjs).
export const GET: APIRoute = async () => {
  // Headline omits "Strands" since the wordmark already carries it.
  return ogImageResponse({
    title: 'The open source toolkit for production agents.',
    description: 'An agent harness and SDK, sandboxed shell, evals, and research labs — in Python and TypeScript.',
  })
}

import type { APIRoute } from 'astro'
import { ogImageResponse } from '../util/og-image'

// Site-wide default share image (homepage + all docs pages), served at
// https://strandsagents.com/og-image.png (referenced from astro.config.mjs).
export const GET: APIRoute = async () => {
  // Headline omits "Strands" since the wordmark already carries it.
  return ogImageResponse({
    title: 'Build production AI agents with open source tools.',
    description: 'Start complete, compose the agent loop, or add focused tools in Python and TypeScript.',
  })
}

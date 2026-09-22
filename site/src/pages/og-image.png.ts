import type { APIRoute } from 'astro'
import { renderOgImage } from '../util/og-image'

// Site-wide default share image (homepage + all docs pages), served at
// https://strandsagents.com/og-image.png (referenced from astro.config.mjs).
export const GET: APIRoute = async () => {
  // Headline omits "Strands" since the wordmark already carries it.
  const png = await renderOgImage({
    title: 'The toolkit for building production agents.',
    description:
      'Lifecycle controls, tools, MCP, multi-agent, memory, streaming, guardrails, and evals — in Python and TypeScript.',
  })
  return new Response(png, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
  })
}

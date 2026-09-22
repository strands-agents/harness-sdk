import type { APIRoute } from 'astro'
import { renderOgImage } from '../util/og-image'

// Site-wide default share image (homepage + all docs pages). Referenced from
// astro.config.mjs as https://strandsagents.com/og-image.png. Replaces the
// former static public/og-image.png so it stays in sync with the blog cards.
export const GET: APIRoute = async () => {
  const png = await renderOgImage({
    title: 'Strands Agents',
    description: 'The open source toolkit for building production agents.',
  })
  return new Response(png, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
  })
}

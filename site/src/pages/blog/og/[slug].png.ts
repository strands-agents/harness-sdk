import type { APIRoute, GetStaticPaths } from 'astro'
import { getCollection } from 'astro:content'
import { renderOgImage } from '../../../util/og-image'

export const getStaticPaths: GetStaticPaths = async () => {
  const posts = await getCollection('blog', ({ data }) => (import.meta.env.PROD ? !data.draft : true))
  return posts.map((post) => ({
    params: { slug: post.id },
    props: { title: post.data.title, description: post.data.description },
  }))
}

export const GET: APIRoute = async ({ props }) => {
  const png = await renderOgImage({ title: props.title as string, description: props.description as string })
  return new Response(png, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
  })
}

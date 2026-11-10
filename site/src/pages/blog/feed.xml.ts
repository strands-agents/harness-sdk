import type { APIRoute } from 'astro'
import rss from '@astrojs/rss'
import { getPublishedPosts } from '../../util/blog'
import { pathWithBase } from '../../util/links'

export const GET: APIRoute = async (context) => {
  const posts = await getPublishedPosts()

  return rss({
    title: 'Strands Agents Blog',
    description: 'Tutorials, architecture deep-dives, and production insights from the Strands Agents team.',
    site: context.site!,
    items: posts.map((post) => ({
      title: post.data.title,
      pubDate: post.data.date,
      description: post.data.description,
      link: pathWithBase(`/blog/${post.id}/`),
      categories: post.data.tags,
    })),
    customData: '<language>en-us</language>',
  })
}

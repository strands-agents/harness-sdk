import type { APIRoute, GetStaticPaths } from 'astro'
import rss from '@astrojs/rss'
import { getAllTags, getPostsByTag, tagToSlug } from '../../../util/blog'
import { pathWithBase } from '../../../util/links'

export const getStaticPaths: GetStaticPaths = async () => {
  const tags = await getAllTags()
  return tags.map((tag) => ({
    params: { tag: tagToSlug(tag) },
    props: { tag },
  }))
}

export const GET: APIRoute = async (context) => {
  const { tag } = context.props as { tag: string }
  const posts = await getPostsByTag(tag)

  return rss({
    title: `Strands Agents Blog - ${tag}`,
    description: `Posts tagged with "${tag}" from the Strands Agents blog.`,
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

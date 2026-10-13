import { getCollection, getEntry, type CollectionEntry } from 'astro:content'

export type BlogPost = CollectionEntry<'blog'>
export type Author = CollectionEntry<'authors'>

/**
 * Get all published blog posts, sorted by date descending.
 * In production, excludes drafts. In dev, includes everything.
 */
export async function getPublishedPosts(): Promise<BlogPost[]> {
  const posts = await getCollection('blog', ({ data }) => {
    return import.meta.env.PROD ? !data.draft : true
  })
  return posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime())
}

/**
 * Get all unique tags across published posts.
 */
export async function getAllTags(): Promise<string[]> {
  const posts = await getPublishedPosts()
  const tagSet = new Set<string>()
  for (const post of posts) {
    for (const tag of post.data.tags) {
      tagSet.add(tag)
    }
  }
  return Array.from(tagSet).sort()
}

/**
 * Get posts filtered by tag.
 */
export async function getPostsByTag(tag: string): Promise<BlogPost[]> {
  const posts = await getPublishedPosts()
  return posts.filter((post) => post.data.tags.includes(tag))
}

/**
 * Get posts by author ID.
 */
export async function getPostsByAuthor(authorId: string): Promise<BlogPost[]> {
  const posts = await getPublishedPosts()
  return posts.filter((post) => post.data.authors.includes(authorId))
}

/**
 * Resolve author IDs to full author entries.
 */
export async function resolveAuthors(authorIds: string[]): Promise<Author[]> {
  const authors: Author[] = []
  for (const id of authorIds) {
    const author = await getEntry('authors', id)
    if (!author) {
      throw new Error(`[blog] Unknown author ID: "${id}" — check authors.yaml and blog post frontmatter`)
    }
    authors.push(author)
  }
  return authors
}

/**
 * Convert a tag name to a URL-safe slug.
 */
export function tagToSlug(tag: string): string {
  return tag.toLowerCase().replace(/\s+/g, '-')
}

/**
 * Convert a URL slug back to the original tag name.
 */
export function slugToTag(slug: string, allTags: string[]): string | undefined {
  return allTags.find((tag) => tagToSlug(tag) === slug)
}

/**
 * Format a date for display.
 */
export function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

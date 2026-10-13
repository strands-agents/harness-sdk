import { getCollection, getEntry, type CollectionEntry } from 'astro:content'

export type BlogPost = CollectionEntry<'blog'>
export type Author = CollectionEntry<'authors'>

export const BLOG_PUBLISH_TIME_ZONE = 'America/New_York'

const BLOG_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: BLOG_PUBLISH_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

type PublishableBlogData = Pick<BlogPost['data'], 'date' | 'draft'>

function calendarDateInPublishTimeZone(date: Date): string {
  const parts = BLOG_DATE_FORMATTER.formatToParts(date)
  const value = (type: 'year' | 'month' | 'day') => {
    const part = parts.find((candidate) => candidate.type === type)
    if (!part) throw new Error(`[blog] Could not resolve ${type} for publication date`)
    return part.value
  }
  return `${value('year')}-${value('month')}-${value('day')}`
}

/** Whether a non-draft post has reached its publication date. */
export function isBlogPostPublished(data: PublishableBlogData, now: Date): boolean {
  return !data.draft && data.date.toISOString().slice(0, 10) <= calendarDateInPublishTimeZone(now)
}

/**
 * Get all published blog posts, sorted by date descending.
 * Production excludes drafts and future-dated posts. Development includes everything.
 */
export async function getPublishedPosts(now: Date = new Date()): Promise<BlogPost[]> {
  const includeFuturePosts = process.env.INCLUDE_FUTURE_BLOG_POSTS === 'true'
  const posts = await getCollection('blog', ({ data }) => {
    if (!import.meta.env.PROD) return true
    if (includeFuturePosts) return !data.draft
    return isBlogPostPublished(data, now)
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

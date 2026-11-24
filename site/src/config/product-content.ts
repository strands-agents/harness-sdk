import { formatDate, getPostsByTag } from '../util/blog'
import { siteLink } from '../util/links'

export const PRODUCT_CONTENT_PROJECTS = {
  box: {
    label: 'Box',
    blogTag: 'Strands Box',
    accent: 'purple',
  },
  decider: {
    label: 'Decider',
    blogTag: 'Strands Decider',
    accent: 'red',
  },
} as const

export type ProductContentProject = keyof typeof PRODUCT_CONTENT_PROJECTS
export type ProductContentKind = 'article' | 'video'

export interface ProductContentItem {
  id: string
  projects: readonly ProductContentProject[]
  kind: ProductContentKind
  title: string
  description: string
  href: string
  source: string
  date: Date
  external: boolean
  duration?: string
  image?: string
}

interface ProductVideo {
  id: string
  projects: readonly ProductContentProject[]
  title: string
  description: string
  source: 'AWS Developers'
  publishedOn: string
  duration: string
}

const DEFAULT_PRODUCT_CONTENT_LIMIT = 3
const YOUTUBE_WATCH_URL = 'https://www.youtube.com/watch?v='
const YOUTUBE_THUMBNAIL_URL = 'https://i.ytimg.com/vi'

// Site maintainers add official AWS Developers videos here when they should appear on a product landing page.
export const PRODUCT_VIDEOS: readonly ProductVideo[] = [
  {
    id: 'Z18kFF3uhSA',
    projects: ['box'],
    title: 'Sandbox Your AI Agents in One Command with Strands Box',
    description:
      'See how Box limits files, websites, tools, and credentials while Claude Code, Codex, or Kiro CLI runs in a local sandbox.',
    source: 'AWS Developers',
    publishedOn: '2026-11-23',
    duration: '9:57',
  },
  {
    id: 'dIt_CFbBwjU',
    projects: ['decider'],
    title: 'Bidirectional Attention, System One: Jonathan Buck',
    description:
      'Hear how bidirectional attention and System One models support fast, focused decisions without generating open-ended text.',
    source: 'AWS Developers',
    publishedOn: '2026-11-18',
    duration: '39:07',
  },
] as const

function videoContent(project: ProductContentProject): ProductContentItem[] {
  return PRODUCT_VIDEOS.filter((video) => video.projects.includes(project)).map((video) => ({
    id: `youtube-${video.id}`,
    projects: video.projects,
    kind: 'video',
    title: video.title,
    description: video.description,
    href: `${YOUTUBE_WATCH_URL}${video.id}`,
    source: video.source,
    date: new Date(`${video.publishedOn}T00:00:00Z`),
    external: true,
    duration: video.duration,
    image: `${YOUTUBE_THUMBNAIL_URL}/${video.id}/hqdefault.jpg`,
  }))
}

function compareProductContent(left: ProductContentItem, right: ProductContentItem): number {
  return right.date.getTime() - left.date.getTime() || left.title.localeCompare(right.title)
}

export function selectProductContent(
  items: readonly ProductContentItem[],
  limit = DEFAULT_PRODUCT_CONTENT_LIMIT
): ProductContentItem[] {
  const normalizedLimit = Math.max(0, Math.trunc(limit))
  const sortedItems = [...items].sort(compareProductContent)
  if (normalizedLimit < 2) return sortedItems.slice(0, normalizedLimit)

  const newestVideo = sortedItems.find((item) => item.kind === 'video')
  const newestArticle = sortedItems.find((item) => item.kind === 'article')
  if (!newestVideo || !newestArticle) return sortedItems.slice(0, normalizedLimit)

  const reservedIds = new Set([newestVideo.id, newestArticle.id])
  return [newestVideo, newestArticle, ...sortedItems.filter((item) => !reservedIds.has(item.id))]
    .slice(0, normalizedLimit)
    .sort(compareProductContent)
}

export async function getProductContent(
  project: ProductContentProject,
  limit = DEFAULT_PRODUCT_CONTENT_LIMIT
): Promise<ProductContentItem[]> {
  const projectConfig = PRODUCT_CONTENT_PROJECTS[project]
  const posts = await getPostsByTag(projectConfig.blogTag)
  const articles: ProductContentItem[] = posts.map((post) => ({
    id: `article-${post.id}`,
    projects: [project],
    kind: 'article',
    title: post.data.title,
    description: post.data.description,
    href: `/blog/${post.id}/`,
    source: 'Strands Blog',
    date: post.data.date,
    external: false,
    ...(post.data.coverImage && { image: post.data.coverImage }),
  }))

  return selectProductContent([...videoContent(project), ...articles], limit)
}

export function buildProductContentMarkdown(items: readonly ProductContentItem[], headingLevel: number): string[] {
  if (items.length === 0) return []

  const heading = `${'#'.repeat(Math.min(Math.max(Math.trunc(headingLevel), 1), 6))} Content`

  return [
    heading,
    '',
    ...items.map((item) => {
      const href = item.external ? item.href : siteLink(item.href)
      const source = item.kind === 'video' ? `Video from ${item.source}` : item.source
      const metadata = [source, formatDate(item.date), item.duration].filter(Boolean).join(', ')
      return `- [${item.title}](${href}) (${metadata}): ${item.description}`
    }),
    '',
  ]
}

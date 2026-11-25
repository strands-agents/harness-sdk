import { describe, expect, it } from 'vitest'

import {
  buildProductContentMarkdown,
  getProductContent,
  PRODUCT_CONTENT_PROJECTS,
  PRODUCT_VIDEOS,
  selectProductContent,
  type ProductContentItem,
  type ProductContentProject,
} from '../src/config/product-content'
import { formatDate, getPostsByTag } from '../src/util/blog'
import { siteLink } from '../src/util/links'

const projects = Object.keys(PRODUCT_CONTENT_PROJECTS) as ProductContentProject[]

describe('product content', () => {
  it('filters, sorts, and limits content by project', async () => {
    const limit = 3

    for (const project of projects) {
      const allItems = await getProductContent(project, Number.MAX_SAFE_INTEGER)
      const items = await getProductContent(project, limit)

      expect(items).toHaveLength(Math.min(limit, allItems.length))
      expect(items.every((item) => item.projects.includes(project))).toBe(true)
      expect(new Set(items.map((item) => item.id)).size).toBe(items.length)

      for (let index = 1; index < items.length; index += 1) {
        expect(items[index - 1]!.date.getTime()).toBeGreaterThanOrEqual(items[index]!.date.getTime())
      }

      if (allItems.some((item) => item.kind === 'video') && allItems.some((item) => item.kind === 'article')) {
        expect(items.some((item) => item.kind === 'video')).toBe(true)
        expect(items.some((item) => item.kind === 'article')).toBe(true)
      }
    }

    expect(await getProductContent('box', 0)).toEqual([])
  })

  it('uses the project blog tag to load articles', async () => {
    for (const project of projects) {
      const expectedIds = new Set(
        (await getPostsByTag(PRODUCT_CONTENT_PROJECTS[project].blogTag)).map((post) => `article-${post.id}`)
      )
      const articles = (await getProductContent(project, Number.MAX_SAFE_INTEGER)).filter(
        (item) => item.kind === 'article'
      )

      expect(new Set(articles.map((item) => item.id))).toEqual(expectedIds)
      expect(articles.every((item) => item.projects.length === 1 && item.projects[0] === project)).toBe(true)
      expect(articles.every((item) => item.source === 'Strands Blog')).toBe(true)
      expect(articles.every((item) => !item.external && /^\/blog\/[^/]+\/$/.test(item.href))).toBe(true)
    }
  })

  it('keeps a video and article when newer items exceed the limit', () => {
    const items: ProductContentItem[] = [
      {
        id: 'video',
        projects: ['box'],
        kind: 'video',
        title: 'Video',
        description: 'Video description',
        href: 'https://example.com/video',
        source: 'AWS Developers',
        date: new Date('2026-01-01T00:00:00Z'),
        external: true,
      },
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `article-${index}`,
        projects: ['box'] as const,
        kind: 'article' as const,
        title: `Article ${index}`,
        description: 'Article description',
        href: `/blog/article-${index}/`,
        source: 'Strands Blog',
        date: new Date(`2026-02-0${index + 1}T00:00:00Z`),
        external: false,
      })),
    ]

    expect(selectProductContent(items, 3).map((item) => item.id)).toEqual(['article-2', 'article-1', 'video'])
  })

  it('uses official AWS Developers videos with valid metadata', () => {
    expect(PRODUCT_VIDEOS.length).toBeGreaterThan(0)
    expect(new Set(PRODUCT_VIDEOS.map((video) => video.id)).size).toBe(PRODUCT_VIDEOS.length)

    for (const video of PRODUCT_VIDEOS) {
      expect(video.id).toMatch(/^[\w-]{11}$/)
      expect(video.projects.length).toBeGreaterThan(0)
      expect(video.title).not.toBe('')
      expect(video.description).not.toBe('')
      expect(video.source).toBe('AWS Developers')
      expect(video.duration).toMatch(/^\d+:\d{2}$/)
      expect(video.publishedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(Number.isNaN(new Date(`${video.publishedOn}T00:00:00Z`).getTime())).toBe(false)
    }
  })

  it('renders the filtered content in machine-readable output', async () => {
    const items = await getProductContent('decider')
    const markdown = buildProductContentMarkdown(items, 2).join('\n')

    expect(markdown).toContain('## Content')
    expect(markdown).not.toContain('See Decider in action')
    for (const item of items) {
      const href = item.external ? item.href : siteLink(item.href)
      expect(markdown).toContain(`[${item.title}](${href})`)
      expect(markdown).toContain(formatDate(item.date))
      if (item.duration) expect(markdown).toContain(item.duration)
    }
    expect(markdown).not.toContain('—')
  })
})

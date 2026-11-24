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
import { formatDate } from '../src/util/blog'
import { siteLink } from '../src/util/links'

const projects = Object.keys(PRODUCT_CONTENT_PROJECTS) as ProductContentProject[]
const expectedFeaturedArticles = {
  box: ['article-strands-box-cli', 'article-strands-box-linux-sandbox'],
  decider: [
    'article-introducing-strands-decider-v2',
    'article-amazon-saves-millions-replacing-sonnet-with-strands-decider',
  ],
} satisfies Record<ProductContentProject, string[]>
const expectedTaggedArticles = {
  box: [...expectedFeaturedArticles.box, 'article-strands-box-the-big-picture'],
  decider: [
    ...expectedFeaturedArticles.decider,
    'article-strands-decider-gemma-4-models',
    'article-introducing-strands-decider',
  ],
} satisfies Record<ProductContentProject, string[]>

describe('product content', () => {
  it('filters, sorts, and limits content by project', async () => {
    for (const project of projects) {
      const items = await getProductContent(project)

      expect(items).toHaveLength(3)
      expect(items.every((item) => item.projects.includes(project))).toBe(true)
      expect(new Set(items.map((item) => item.id)).size).toBe(items.length)
      expect(items.filter((item) => item.kind === 'article').map((item) => item.id)).toEqual(
        expectedFeaturedArticles[project]
      )

      for (let index = 1; index < items.length; index += 1) {
        expect(items[index - 1]!.date.getTime()).toBeGreaterThanOrEqual(items[index]!.date.getTime())
      }
    }

    expect(await getProductContent('box', 0)).toEqual([])
  })

  it('uses the project blog tag to load articles', async () => {
    for (const project of projects) {
      const articles = (await getProductContent(project, 10))
        .filter((item) => item.kind === 'article')
        .map((item) => item.id)

      expect(new Set(articles)).toEqual(new Set(expectedTaggedArticles[project]))
    }
  })

  it('keeps each project isolated while supporting mixed content types', async () => {
    const box = await getProductContent('box')
    const decider = await getProductContent('decider')

    for (const items of [box, decider]) {
      expect(items.filter((item) => item.kind === 'video')).toHaveLength(1)
      expect(items.filter((item) => item.kind === 'article')).toHaveLength(2)
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

    expect(selectProductContent(items, 3).map((item) => item.kind)).toContain('video')
    expect(selectProductContent(items, 3).map((item) => item.kind)).toContain('article')
  })

  it('uses official AWS Developers videos with valid metadata', () => {
    expect(PRODUCT_VIDEOS).toHaveLength(2)

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

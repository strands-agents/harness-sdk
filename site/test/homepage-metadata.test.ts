import { readFileSync } from 'node:fs'

import { getCollection } from 'astro:content'
import { parse } from 'node-html-parser'
import { describe, expect, it } from 'vitest'

function configuredPathWithBase(value: string): string {
  const base = (process.env.ASTRO_BASE_PATH ?? '/').replace(/\/$/, '')
  const normalizedValue = value.startsWith('/') ? value : `/${value}`
  return `${base}${normalizedValue}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

describe('homepage machine-readable metadata', () => {
  const homepageHtml = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8')
  const homepage = parse(homepageHtml)

  it('keeps meaningful content near the start of a compact HTML response', () => {
    expect(Buffer.byteLength(homepageHtml)).toBeLessThan(1_000_000)
    expect(homepageHtml.indexOf('<h1')).toBeGreaterThan(-1)
    expect(homepageHtml.indexOf('<h1')).toBeLessThan(250_000)
  })

  it('loads the decorative halftone as an external asset', () => {
    const maskStyle = homepage.querySelector('.banner__halftone-mask')?.getAttribute('style')
    const maskUrl = maskStyle?.match(/--halftone-mask: url\("([^"]+)"\)/)?.[1]

    const assetPrefix = escapeRegExp(configuredPathWithBase('/_astro/halftone.'))
    expect(maskUrl).toMatch(new RegExp(`^${assetPrefix}[^/]+\\.svg$`))
    expect(homepage.querySelector('.banner__halftone svg')).toBeNull()
  })

  it('advertises the Markdown homepage', () => {
    const alternate = homepage.querySelector('link[rel="alternate"][type="text/markdown"]')

    expect(alternate?.getAttribute('href')).toBe(configuredPathWithBase('/index.md'))
  })

  it('includes the shared base schemas and product nodes as JSON-LD', () => {
    const script = homepage.querySelector('script[type="application/ld+json"]')
    const structuredData = JSON.parse(script?.innerHTML ?? '{}')

    expect(structuredData['@context']).toBe('https://schema.org')
    expect(structuredData['@graph'].map((schema: { '@type': string }) => schema['@type'])).toEqual([
      'Organization',
      'WebSite',
      'SoftwareApplication',
      'SoftwareApplication',
      'SoftwareApplication',
      'SoftwareApplication',
      'SoftwareApplication',
      'SoftwareApplication',
    ])
    expect(structuredData['@graph'][0].sameAs).toContain('https://github.com/strands-agents')
    expect(JSON.stringify(structuredData)).not.toContain('SearchAction')
  })

  it('keeps substantial static content headed by an H1', () => {
    const main = homepage.querySelector('main')
    const headings = main?.querySelectorAll('h1, h2, h3, h4, h5, h6') ?? []

    expect(main?.text.trim().length).toBeGreaterThan(500)
    expect(headings[0]?.tagName).toBe('H1')
    expect(main?.querySelectorAll('h1')).toHaveLength(1)
  })

  it('promotes distinct recent blog posts', async () => {
    const posts = await getCollection('blog', ({ data }) => !data.draft)
    posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime())

    const latestPost = posts[0]
    if (!latestPost) throw new Error('expected at least one published blog post')
    const communityPost = posts[1] ?? latestPost

    const announcement = homepage.querySelector('.announcement')
    const bannerLink = announcement?.querySelector('.announcement__link')
    const communityLink = homepage.querySelector('.community__blog-link')

    expect(bannerLink?.getAttribute('href')).toBe(configuredPathWithBase(`/blog/${latestPost.id}/`))
    expect(bannerLink?.querySelector('.announcement__title')?.text.trim()).toBe(latestPost.data.title)
    expect(announcement?.getAttribute('data-expires')).toBeUndefined()
    expect(announcement?.querySelector('.announcement__fallback')).toBeNull()
    expect(communityLink?.getAttribute('href')).toBe(configuredPathWithBase(`/blog/${communityPost.id}/`))
    expect(communityLink?.text.trim()).toBe(communityPost.data.title)
    if (posts.length > 1) expect(communityLink?.getAttribute('href')).not.toBe(bannerLink?.getAttribute('href'))
  })

  it('publishes a concise Markdown homepage with official resources', () => {
    const markdown = readFileSync(new URL('../dist/index.md', import.meta.url), 'utf8')

    expect(markdown).toContain('# Strands Agents')
    expect(markdown).toContain('/docs/user-guide/sdk/quickstart/overview/index.md')
    expect(markdown).toContain('/examples/')
    expect(markdown).toContain('https://pypi.org/project/strands-agents/')
    expect(markdown).toContain('https://www.npmjs.com/package/@strands-agents/sdk')
    expect(markdown).toContain('https://github.com/strands-agents/harness-sdk')
    expect(markdown).toContain('/llms.txt')
    expect(markdown.length).toBeLessThan(4_000)
  })
})

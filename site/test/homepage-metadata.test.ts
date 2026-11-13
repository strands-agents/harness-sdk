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

  it('places the agent foundations above the supporting toolkit products', () => {
    const toolkit = homepage.querySelector('.toolkit')
    const sections = toolkit?.querySelectorAll('.toolkit__section') ?? []

    expect(toolkit?.querySelector('.toolkit__cards-title')?.tagName).toBe('H2')
    expect(
      sections.map((section) => ({
        title: {
          tagName: section.querySelector('.toolkit__section-title')?.tagName,
          text: section.querySelector('.toolkit__section-title')?.text.trim(),
        },
        products: section.querySelectorAll('.toolkit__card').map((card) => {
          const heading = card.querySelector('.toolkit__card-slug')
          const docsLink = card.querySelector('.toolkit__card-read')
          return {
            tagName: heading?.tagName,
            text: heading?.text.trim(),
            docs: {
              text: docsLink?.text.trim(),
              href: docsLink?.getAttribute('href'),
              ariaLabel: docsLink?.getAttribute('aria-label'),
            },
          }
        }),
      }))
    ).toEqual([
      {
        title: { tagName: 'H3', text: 'Build an agent' },
        products: [
          {
            tagName: 'H4',
            text: '/harness',
            docs: {
              text: 'Read docs',
              href: configuredPathWithBase('/docs/user-guide/harness/'),
              ariaLabel: 'Read Strands harness docs',
            },
          },
          {
            tagName: 'H4',
            text: '/harness-sdk',
            docs: {
              text: 'Read docs',
              href: configuredPathWithBase('/docs/user-guide/sdk/'),
              ariaLabel: 'Read Strands Harness SDK docs',
            },
          },
        ],
      },
      {
        title: { tagName: 'H3', text: 'Control and improve your agent' },
        products: [
          {
            tagName: 'H4',
            text: '/box',
            docs: {
              text: 'Read docs',
              href: configuredPathWithBase('/docs/user-guide/box/'),
              ariaLabel: 'Read Strands Box docs',
            },
          },
          {
            tagName: 'H4',
            text: '/evals',
            docs: {
              text: 'Read docs',
              href: configuredPathWithBase('/docs/user-guide/evals-sdk/'),
              ariaLabel: 'Read Strands Evals docs',
            },
          },
          {
            tagName: 'H4',
            text: '/decider',
            docs: {
              text: 'Read docs',
              href: configuredPathWithBase('/docs/labs/strands-decider/overview/'),
              ariaLabel: 'Read Strands Decider docs',
            },
          },
        ],
      },
    ])

    expect(
      sections.map((section) =>
        section
          .querySelector('.toolkit__section-cards')
          ?.getAttribute('class')
          ?.split(/\s+/)
          .find((className) => className.startsWith('toolkit__section-cards--'))
      )
    ).toEqual(['toolkit__section-cards--build', 'toolkit__section-cards--tools'])
    expect(toolkit?.querySelectorAll('.toolkit__card-desc').map((item) => item.text.trim())).toEqual([
      'Use Strands harness when you want a complete agent with benchmarked defaults you can customize.',
      'Use the Strands Harness SDK when you want to assemble every part of the agent yourself.',
      'Run agents in an OS-enforced sandbox with policy checks for commands, network access, and MCP requests.',
      'Measure quality, diagnose failures, and simulate the users and tools your agent will meet in production.',
      'Use a small, fast model when you need a choice, a yes-or-no probability, or a score with calibrated confidence.',
    ])
    expect(sections[0]?.querySelectorAll('.toolkit__card-feature')).toHaveLength(0)
    expect(sections[0]?.querySelectorAll('.toolkit__card-tag')).toHaveLength(0)
    expect(toolkit?.querySelectorAll('[data-toggle]').map((toggle) => toggle.getAttribute('aria-controls'))).toEqual(
      toolkit?.querySelectorAll('.toolkit__card-expanded').map((details) => details.getAttribute('id'))
    )
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

  it('shows five FAQ previews and links to the standalone FAQ page', () => {
    const section = homepage.querySelector('.home-faq')
    const items = section?.querySelectorAll('.home-faq__item') ?? []
    const link = section?.querySelector('.home-faq__cta')

    expect(items).toHaveLength(5)
    expect(link?.getAttribute('href')).toBe(configuredPathWithBase('/faq/'))
  })

  it('publishes a concise Markdown homepage with official resources', () => {
    const markdown = readFileSync(new URL('../dist/index.md', import.meta.url), 'utf8')

    expect(markdown).toContain('# Strands Agents')
    expect(markdown).toContain('/docs/user-guide/sdk/quickstart/overview/index.md')
    expect(markdown).toContain('/examples/')
    expect(markdown).toContain('/faq/index.md')
    expect(markdown).toContain('https://pypi.org/project/strands-agents/')
    expect(markdown).toContain('https://www.npmjs.com/package/@strands-agents/sdk')
    expect(markdown).toContain('https://github.com/strands-agents/harness-sdk')
    expect(markdown).toContain('/llms.txt')
    expect(markdown.length).toBeLessThan(4_000)
  })
})

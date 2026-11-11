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
    ])
    expect(structuredData['@graph'][0].sameAs).toContain('https://github.com/strands-agents')
    expect(JSON.stringify(structuredData)).not.toContain('SearchAction')
  })

  it('keeps substantial static content headed by an H1', () => {
    const main = homepage.querySelector('main')
    const headings = main?.querySelectorAll('h1, h2, h3, h4, h5, h6') ?? []

    expect(main?.text.trim().length).toBeGreaterThan(500)
    expect(headings[0]?.tagName).toBe('H1')
    expect(headings[0]?.text.trim()).toBe('Build production AI agents with open source tools.')
    expect(main?.querySelectorAll('h1')).toHaveLength(1)
  })

  it('routes visitors to distinct harness and SDK quickstarts', () => {
    const primary = homepage.querySelector('.banner__action--primary')
    const secondary = homepage.querySelector('.banner__action--secondary')

    expect(primary?.text.trim()).toContain('Build your first agent')
    expect(primary?.getAttribute('href')).toBe(configuredPathWithBase('/docs/user-guide/harness/quickstart/'))
    expect(secondary?.text.trim()).toContain('Start from SDK primitives')
    expect(secondary?.getAttribute('href')).toBe(configuredPathWithBase('/docs/user-guide/sdk/quickstart/overview/'))
    expect(homepage.querySelector('.banner__explore')?.getAttribute('href')).toBe('#toolkit')
  })

  it('separates agent-building foundations from focused tools', () => {
    const toolkit = homepage.querySelector('.toolkit')
    const foundations = toolkit?.querySelectorAll('.foundation-card') ?? []
    const modules = toolkit?.querySelectorAll('.module-card') ?? []

    expect(toolkit?.getAttribute('id')).toBe('toolkit')
    expect(toolkit?.querySelector('.toolkit__title')?.tagName).toBe('H2')
    expect(toolkit?.querySelector('.toolkit__title')?.text.trim()).toBe('Choose your agent foundation.')
    expect(toolkit?.querySelector('.toolkit__lede')).toBeNull()
    expect(toolkit?.querySelector('.toolkit__modules-title')?.text.trim()).toBe(
      'Focused tools for the rest of the agent stack.'
    )
    expect(toolkit?.querySelector('.toolkit__modules-lede')).toBeNull()
    expect(homepage.querySelector('.banner__starter-features')).toBeNull()
    expect(homepage.querySelector('.banner__starter-slug')?.text.trim()).toBe('/harness')
    expect(
      foundations.map((card) => ({
        slug: card.querySelector('.foundation-card__slug')?.text.trim(),
        badge: card.querySelector('.foundation-card__badge')?.text.trim(),
        heading: {
          tagName: card.querySelector('.foundation-card__title')?.tagName,
          text: card.querySelector('.foundation-card__title')?.text.trim(),
        },
        install: {
          python: card.querySelector('[data-install-variant="Python"]')?.text.trim(),
          typescript: card.querySelector('[data-install-variant="TypeScript"]')?.text.trim(),
          copyLabel: card.querySelector('[data-install-copy]')?.getAttribute('aria-label'),
        },
        ctaLabel: card.querySelector('.foundation-card__cta')?.getAttribute('aria-label'),
        href: card.querySelector('.foundation-card__cta')?.getAttribute('href'),
      }))
    ).toEqual([
      {
        slug: '/harness',
        badge: 'Recommended',
        heading: { tagName: 'H3', text: 'Start with a complete agent.' },
        install: {
          python: 'pip install strands-harness',
          typescript: 'npm i @strands-agents/harness',
          copyLabel: 'Copy Strands harness install command',
        },
        ctaLabel: 'Start with Strands harness',
        href: configuredPathWithBase('/docs/user-guide/harness/quickstart/'),
      },
      {
        slug: '/harness-sdk',
        badge: 'Build from primitives',
        heading: { tagName: 'H3', text: 'Compose your own agent loop.' },
        install: {
          python: 'pip install strands-agents',
          typescript: 'npm i @strands-agents/sdk',
          copyLabel: 'Copy Strands Harness SDK install command',
        },
        ctaLabel: 'Build with SDK primitives',
        href: configuredPathWithBase('/docs/user-guide/sdk/quickstart/overview/'),
      },
    ])

    expect(
      modules.map((card) => ({
        slug: card.querySelector('.module-card__slug')?.text.trim(),
        heading: {
          tagName: card.querySelector('.module-card__title')?.tagName,
          text: card.querySelector('.module-card__title')?.text.trim(),
        },
        href: card.querySelector('.module-card__cta')?.getAttribute('href'),
      }))
    ).toEqual([
      {
        slug: '/stash',
        heading: { tagName: 'H3', text: 'Keep working context available.' },
        href: configuredPathWithBase('/docs/user-guide/sdk/context-management/'),
      },
      {
        slug: '/decider',
        heading: { tagName: 'H3', text: 'Make focused decisions faster.' },
        href: configuredPathWithBase('/docs/labs/strands-decider/'),
      },
      {
        slug: '/shell',
        heading: { tagName: 'H3', text: 'Give agents a constrained shell.' },
        href: configuredPathWithBase('/docs/user-guide/shell/'),
      },
      {
        slug: '/box',
        heading: { tagName: 'H3', text: 'Contain the whole agent.' },
        href: configuredPathWithBase('/docs/user-guide/box/'),
      },
      {
        slug: '/evals',
        heading: { tagName: 'H3', text: 'Validate behavior before you ship.' },
        href: configuredPathWithBase('/docs/user-guide/evals-sdk/'),
      },
    ])
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
    expect(markdown.indexOf('Harness quickstart')).toBeLessThan(markdown.indexOf('SDK quickstart'))
    expect(markdown).toContain('/docs/user-guide/sdk/quickstart/overview/index.md')
    expect(markdown).toContain('/docs/labs/strands-decider/inference/index.md')
    expect(markdown).toContain('/examples/')
    expect(markdown).toContain('https://pypi.org/project/strands-agents/')
    expect(markdown).toContain('https://www.npmjs.com/package/@strands-agents/sdk')
    expect(markdown).toContain('https://github.com/strands-agents/harness-sdk')
    expect(markdown).toContain('/llms.txt')
    expect(markdown.length).toBeLessThan(4_000)
  })
})

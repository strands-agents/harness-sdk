import { readFileSync } from 'node:fs'

import { getCollection } from 'astro:content'
import { parse } from 'node-html-parser'
import { describe, expect, it } from 'vitest'

import { homepageProducts } from '../src/config/navbar'

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

  it('keeps the hero focused on one recommended starting path', () => {
    const hero = homepage.querySelector('.banner')
    const primary = hero?.querySelector('.banner__action--primary')

    expect(hero?.querySelector('.banner__summary')?.text.trim().replace(/\s+/g, ' ')).toBe(
      'An open source framework for building production agents.'
    )
    expect(hero?.querySelector('.banner__harness')?.text.trim()).toBe('/harness')
    expect(hero?.querySelector('[data-install-variant="Python"]')?.text.trim()).toBe('pip install strands-harness')
    expect(hero?.querySelector('[data-install-variant="TypeScript"]')?.text.trim()).toBe(
      'npm i @strands-agents/harness'
    )
    expect(primary?.text.trim()).toContain('Quickstart')
    expect(primary?.getAttribute('href')).toBe(configuredPathWithBase('/docs/user-guide/harness/quickstart/'))
    expect(hero?.querySelectorAll('.banner__action')).toHaveLength(1)
  })

  it('loads the decorative halftone as an external asset', () => {
    const halftone = homepage.querySelector('.banner__halftone')
    const maskStyle = homepage.querySelector('.banner__halftone-mask')?.getAttribute('style')
    const maskUrl = maskStyle?.match(/--halftone-mask: url\("([^"]+)"\)/)?.[1]

    const assetPrefix = escapeRegExp(configuredPathWithBase('/_astro/halftone.'))
    expect(halftone?.getAttribute('aria-hidden')).toBe('true')
    expect(maskUrl).toMatch(new RegExp(`^${assetPrefix}[^/]+\\.svg$`))
    expect(halftone?.querySelector('svg')).toBeNull()
  })

  it('publishes concise homepage metadata', () => {
    expect(homepage.querySelector('title')?.text.trim()).toBe('Strands Agents | Build production AI agents')
    expect(homepage.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(
      'Build production agents with an open source framework, a ready-to-use harness, and focused tools for decisions, security, and evaluation.'
    )
    expect(homepage.querySelector('meta[property="og:image:alt"]')?.getAttribute('content')).toBe(
      'Strands Agents: build AI agents'
    )
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
    expect(
      structuredData['@graph']
        .filter((schema: { '@type': string }) => schema['@type'] === 'SoftwareApplication')
        .map((schema: { name: string }) => schema.name)
    ).toEqual(homepageProducts.map((product) => product.name))
    expect(structuredData['@graph'][0].sameAs).toContain('https://github.com/strands-agents')
    expect(JSON.stringify(structuredData)).not.toContain('SearchAction')
  })

  it('keeps substantial static content headed by an H1', () => {
    const main = homepage.querySelector('main')
    const headings = main?.querySelectorAll('h1, h2, h3, h4, h5, h6') ?? []

    expect(main?.text.trim().length).toBeGreaterThan(500)
    expect(headings[0]?.tagName).toBe('H1')
    expect(headings[0]?.text.trim()).toBe('Build AI agents.')
    expect(main?.querySelectorAll('h1')).toHaveLength(1)
  })

  it('presents focused tools as a distinct section after the hero', () => {
    const toolkit = homepage.querySelector('.toolkit')
    const modules = toolkit?.querySelectorAll('.module-card') ?? []

    expect(toolkit?.getAttribute('id')).toBe('tools')
    expect(toolkit?.querySelector('.toolkit__title')?.tagName).toBe('H2')
    expect(toolkit?.querySelector('.toolkit__title')?.text.trim()).toBe('Extend your agent.')

    expect(
      modules.map((card) => ({
        slug: card.querySelector('.module-card__slug')?.text.trim(),
        category: card.querySelector('.product-category')?.text.trim(),
        heading: {
          tagName: card.querySelector('.module-card__title')?.tagName,
          text: card.querySelector('.module-card__title')?.text.trim(),
        },
        href: card.querySelector('.card-action--text')?.getAttribute('href'),
        accent: card.getAttribute('style'),
      }))
    ).toEqual([
      {
        slug: '/box',
        category: 'Agent sandbox',
        heading: { tagName: 'H3', text: 'Contain the agent.' },
        href: configuredPathWithBase('/docs/user-guide/box/'),
        accent: '--accent: var(--card-accent-purple);',
      },
      {
        slug: '/decider',
        category: 'Decision model',
        heading: { tagName: 'H3', text: 'Make focused decisions.' },
        href: configuredPathWithBase('/docs/labs/strands-decider/overview/'),
        accent: '--accent: var(--card-accent-red);',
      },
      {
        slug: '/evals',
        category: 'Evaluation toolkit',
        heading: { tagName: 'H3', text: 'Find failures before deployment.' },
        href: configuredPathWithBase('/docs/user-guide/evals-sdk/'),
        accent: '--accent: var(--card-accent-pink);',
      },
    ])
  })

  it('keeps concise code examples available on demand', () => {
    const cards = homepage.querySelectorAll('[data-example-card]')
    const panelIds = cards.map((card) => card.querySelector('[data-example-toggle]')?.getAttribute('aria-controls'))

    expect(cards).toHaveLength(4)
    expect(panelIds.every(Boolean)).toBe(true)
    expect(new Set(panelIds).size).toBe(cards.length)

    for (const card of cards) {
      const toggle = card.querySelector('[data-example-toggle]')
      const panelId = toggle?.getAttribute('aria-controls')
      const panel = panelId ? homepage.querySelector(`#${panelId}`) : null

      expect(toggle?.getAttribute('aria-expanded')).toBe('false')
      expect(panel?.hasAttribute('hidden')).toBe(true)
      expect(panel?.querySelector('[data-code-copy]')).not.toBeNull()
      expect(panel?.querySelector('[data-code-copy-label]')?.getAttribute('aria-live')).toBe('polite')
      expect(panel?.querySelector('pre')?.text.trim().length).toBeGreaterThan(30)
    }

    const harnessExamples = homepage.querySelectorAll('#harness-code-example [data-example-language]')
    const moduleExamples = homepage.querySelectorAll('.module-card [data-code-value]')

    expect(harnessExamples).toHaveLength(2)
    expect(harnessExamples.map((example) => example.querySelector('pre')?.getAttribute('data-language'))).toEqual([
      'python',
      'typescript',
    ])
    expect(harnessExamples.every((example) => example.querySelector('pre')?.innerHTML.includes('--shiki-light:'))).toBe(
      true
    )

    expect(moduleExamples.map((example) => example.querySelector('pre')?.getAttribute('data-language'))).toEqual([
      'dogwood',
      'shellscript',
      'python',
    ])
    expect(moduleExamples.every((example) => example.querySelector('pre')?.innerHTML.includes('--shiki-light:'))).toBe(
      true
    )
    expect(moduleExamples[2]?.getAttribute('data-code-value')).toContain('.run_evaluations(get_response)')
    expect(moduleExamples[2]?.getAttribute('data-code-value')).toContain('report.display()')
  })

  it('labels the customer proof band', () => {
    const logoFarm = homepage.querySelector('.logo-farm')

    expect(logoFarm?.querySelector('.logo-farm__label')?.text.trim()).toBe('Used by')
    expect(logoFarm?.querySelectorAll('.logo-farm__cell')).toHaveLength(7)
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
    expect(markdown).toContain('Harness quickstart')
    expect(markdown).not.toContain('SDK quickstart')
    expect(markdown).toContain('/docs/labs/strands-decider/overview/index.md')
    expect(markdown).toContain('/examples/')
    expect(markdown).toContain('/faq/index.md')
    expect(markdown).toContain('https://pypi.org/project/strands-agents/')
    expect(markdown).toContain('https://www.npmjs.com/package/@strands-agents/sdk')
    expect(markdown).toContain('https://github.com/strands-agents/harness-sdk')
    expect(markdown).toContain('/llms.txt')
    expect(markdown.length).toBeLessThan(4_000)
  })
})

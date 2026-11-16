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

  it('makes Harness the primary build path and nests the SDK inside it', () => {
    const toolkit = homepage.querySelector('.toolkit')
    const sections = toolkit?.querySelectorAll('.toolkit__section') ?? []
    const buildCard = sections[0]?.querySelector('.toolkit__build-card')
    const harness = buildCard?.querySelector('[data-toolkit-product="harness"]')
    const sdk = buildCard?.querySelector('[data-toolkit-product="harness-sdk"]')

    expect(toolkit?.querySelector('.toolkit__cards-title')?.tagName).toBe('H2')
    expect(
      sections.map((section) => ({
        tagName: section.querySelector('.toolkit__section-title')?.tagName,
        text: section.querySelector('.toolkit__section-title')?.text.trim(),
      }))
    ).toEqual([
      { tagName: 'H3', text: 'Build an agent' },
      { tagName: 'H3', text: 'Control and improve your agent' },
    ])
    expect(buildCard).not.toBeNull()
    expect(harness?.querySelector('h4')?.text.trim()).toBe('/harness')
    expect(harness?.querySelector('.toolkit__build-headline')?.text.trim()).toBe('Start with a complete agent.')
    expect(harness?.querySelector('.toolkit__build-description')?.text.trim()).toBe(
      'Harness gives you tuned defaults for tools, memory, session management, and context management. Replace individual components as your application grows.'
    )
    expect(harness?.querySelector('.toolkit__build-action')?.text.trim()).toBe('Start with Harness')
    expect(harness?.querySelector('.toolkit__build-action')?.getAttribute('href')).toBe(
      configuredPathWithBase('/docs/user-guide/harness/')
    )
    expect(harness?.querySelector('.toolkit__build-action')?.getAttribute('aria-label')).toBe(
      'Start building with Strands harness'
    )

    expect(sdk?.querySelector('h4')?.text.trim()).toBe('/harness-sdk')
    expect(sdk?.querySelector('.toolkit__build-sdk-title')?.text.trim()).toBe('Build with primitives')
    expect(sdk?.querySelector('.toolkit__build-sdk-relation')?.text.trim()).toBe(
      'Harness is built on the Strands Harness SDK.'
    )
    expect(sdk?.querySelector('.toolkit__build-sdk-description')?.text.trim()).toBe(
      'Use the Strands Harness SDK directly when you need to wire the model, tools, memory, session management, and hooks yourself.'
    )
    expect(sdk?.querySelector('.toolkit__build-sdk-action')?.text.trim()).toBe('Explore the SDK')
    expect(sdk?.querySelector('.toolkit__build-sdk-action')?.getAttribute('href')).toBe(
      configuredPathWithBase('/docs/user-guide/sdk/')
    )
  })

  it('gives Harness the visible example while keeping both build install paths available', () => {
    const buildCard = homepage.querySelector('.toolkit__build-card')
    const harness = buildCard?.querySelector('[data-toolkit-product="harness"]')
    const sdk = buildCard?.querySelector('[data-toolkit-product="harness-sdk"]')

    expect(harness?.querySelectorAll('.toolkit__card-terminal')).toHaveLength(1)
    expect(sdk?.querySelectorAll('.toolkit__card-terminal')).toHaveLength(0)
    expect(buildCard?.querySelectorAll('[data-toggle]')).toHaveLength(0)
    expect(harness?.querySelector('[data-lang-code="typescript"]')?.hasAttribute('hidden')).toBe(false)
    expect(harness?.querySelector('[data-lang-code="python"]')?.hasAttribute('hidden')).toBe(true)
    expect(harness?.querySelector('.toolkit__card-terminal-copy')?.getAttribute('aria-label')).toBe(
      'Copy Strands harness example'
    )
    expect(
      buildCard?.querySelectorAll('[data-install]').map((install) => ({
        python: install.querySelector('[data-install-variant="Python"]')?.text.trim(),
        typescript: install.querySelector('[data-install-variant="TypeScript"]')?.text.trim(),
        copyLabel: install.querySelector('[data-install-copy]')?.getAttribute('aria-label'),
      }))
    ).toEqual([
      {
        python: 'pip install strands-harness',
        typescript: 'npm install @strands-agents/harness',
        copyLabel: 'Copy Strands harness install command',
      },
      {
        python: 'pip install strands-agents',
        typescript: 'npm install @strands-agents/sdk',
        copyLabel: 'Copy Strands Harness SDK install command',
      },
    ])
  })

  it('keeps the supporting products expandable and correctly labelled', () => {
    const toolsSection = homepage.querySelectorAll('.toolkit__section')[1]
    const products = toolsSection?.querySelectorAll('.toolkit__supporting-product') ?? []
    const cards = products.map((product) => product.querySelector('.toolkit__card'))

    expect(
      products.map((product) => ({
        role: product.querySelector('.toolkit__supporting-role')?.text.trim(),
        slug: product.querySelector('.toolkit__card-slug')?.text.trim(),
        description: product.querySelector('.toolkit__card-desc')?.text.trim(),
        action: product.querySelector('.toolkit__card-read')?.text.trim(),
      }))
    ).toEqual([
      {
        role: 'Sandbox agent work',
        slug: '/box',
        description: 'Run agent work in an OS-enforced sandbox with explicit filesystem, network, and policy controls.',
        action: 'Run in a sandbox',
      },
      {
        role: 'Validate agent behavior',
        slug: '/evals',
        description: 'Run evaluations, detect failures, and measure agent behavior before deployment.',
        action: 'Run an evaluation',
      },
      {
        role: 'Make fast decisions',
        slug: '/decider',
        description: 'Route, classify, or score known outcomes with a small decision model that reports confidence.',
        action: 'Make a decision',
      },
    ])
    expect(cards).toHaveLength(3)
    expect(toolsSection?.querySelectorAll('[data-install]')).toHaveLength(0)
    expect(toolsSection?.querySelectorAll('.toolkit__card.is-open')).toHaveLength(0)
    expect(
      cards.map((card) => {
        const toggle = card?.querySelector('[data-toggle]')
        const details = card?.querySelector('.toolkit__card-expanded')
        return {
          expanded: toggle?.getAttribute('aria-expanded'),
          controls: toggle?.getAttribute('aria-controls'),
          detailsId: details?.getAttribute('id'),
          toggleLabel: toggle?.getAttribute('aria-label'),
        }
      })
    ).toEqual([
      {
        expanded: 'false',
        controls: 'toolkit-card-box-details',
        detailsId: 'toolkit-card-box-details',
        toggleLabel: 'Toggle /box details',
      },
      {
        expanded: 'false',
        controls: 'toolkit-card-evals-details',
        detailsId: 'toolkit-card-evals-details',
        toggleLabel: 'Toggle /evals details',
      },
      {
        expanded: 'false',
        controls: 'toolkit-card-decider-details',
        detailsId: 'toolkit-card-decider-details',
        toggleLabel: 'Toggle /decider details',
      },
    ])
    expect(new Set(cards.map((card) => card?.querySelector('.toolkit__card-expanded')?.getAttribute('id'))).size).toBe(
      3
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

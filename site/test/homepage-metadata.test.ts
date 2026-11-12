import { readFileSync } from 'node:fs'

import { getCollection } from 'astro:content'
import { parse } from 'node-html-parser'
import { describe, expect, it } from 'vitest'

function configuredPathWithBase(value: string): string {
  const base = (process.env.ASTRO_BASE_PATH ?? '/').replace(/\/$/, '')
  const normalizedValue = value.startsWith('/') ? value : `/${value}`
  return `${base}${normalizedValue}`
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

    expect(homepage.querySelector('.banner__halftone')).toBeNull()
    expect(homepage.querySelector('.banner__starter')).toBeNull()
    expect(hero?.querySelector('[data-install-variant="Python"]')?.text.trim()).toBe('pip install strands-harness')
    expect(hero?.querySelector('[data-install-variant="TypeScript"]')?.text.trim()).toBe(
      'npm i @strands-agents/harness'
    )
  })

  it('publishes concise homepage metadata', () => {
    expect(homepage.querySelector('title')?.text.trim()).toBe('Strands Agents | Build production AI agents')
    expect(homepage.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(
      'Build production agents with an open source harness and SDK for Python and TypeScript, then add focused tools for decisions, security, and evaluation.'
    )
    expect(homepage.querySelector('meta[property="og:image:alt"]')?.getAttribute('content')).toBe(
      'Strands Agents: build agents you can put to work'
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
    ])
    expect(structuredData['@graph'][0].sameAs).toContain('https://github.com/strands-agents')
    expect(JSON.stringify(structuredData)).not.toContain('SearchAction')
  })

  it('keeps substantial static content headed by an H1', () => {
    const main = homepage.querySelector('main')
    const headings = main?.querySelectorAll('h1, h2, h3, h4, h5, h6') ?? []

    expect(main?.text.trim().length).toBeGreaterThan(500)
    expect(headings[0]?.tagName).toBe('H1')
    expect(headings[0]?.text.trim()).toBe('Build agents you can put to work.')
    expect(main?.querySelectorAll('h1')).toHaveLength(1)
  })

  it('routes visitors to the recommended harness quickstart and the tools section', () => {
    const primary = homepage.querySelector('.banner__action--primary')
    const secondary = homepage.querySelector('.banner__action--secondary')

    expect(primary?.text.trim()).toContain('Build your first agent')
    expect(primary?.getAttribute('href')).toBe(configuredPathWithBase('/docs/user-guide/harness/quickstart/'))
    expect(secondary?.text.trim()).toContain('Explore the tools')
    expect(secondary?.getAttribute('href')).toBe('#tools')
  })

  it('keeps the SDK secondary before presenting focused tools', () => {
    const toolkit = homepage.querySelector('.toolkit')
    const modules = toolkit?.querySelectorAll('.module-card') ?? []

    expect(toolkit?.getAttribute('id')).toBe('tools')
    expect(toolkit?.querySelector('.toolkit__title')?.tagName).toBe('H2')
    expect(toolkit?.querySelector('.toolkit__title')?.text.trim()).toBe('Add only what you need.')
    expect(toolkit?.querySelector('.start-card')).toBeNull()

    expect({
      text: homepage.querySelector('.banner__sdk-link')?.text.trim(),
      href: homepage.querySelector('.banner__sdk-link')?.getAttribute('href'),
    }).toEqual({
      text: 'Building from primitives? Explore the Strands Harness SDK',
      href: configuredPathWithBase('/docs/user-guide/sdk/quickstart/overview/'),
    })

    expect(
      modules.map((card) => ({
        slug: card.querySelector('.module-card__slug')?.text.trim(),
        badge: card.querySelector('.module-card__badge')?.text.trim(),
        heading: {
          tagName: card.querySelector('.module-card__title')?.tagName,
          text: card.querySelector('.module-card__title')?.text.trim(),
        },
        href: card.querySelector('.module-card__cta')?.getAttribute('href'),
      }))
    ).toEqual([
      {
        slug: '/box',
        badge: 'Open source',
        heading: { tagName: 'H3', text: 'Contain the agent.' },
        href: configuredPathWithBase('/docs/user-guide/box/quickstart/'),
      },
      {
        slug: '/decider',
        badge: 'Labs',
        heading: { tagName: 'H3', text: 'Make faster decisions.' },
        href: configuredPathWithBase('/docs/labs/strands-decider/inference/'),
      },
      {
        slug: '/evals',
        badge: 'Python',
        heading: { tagName: 'H3', text: 'Validate before deployment.' },
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

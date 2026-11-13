import { readFileSync } from 'node:fs'

import { getCollection } from 'astro:content'
import { parse } from 'node-html-parser'
import { describe, expect, it } from 'vitest'

import { products } from '../src/config/navbar'

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

  it('defines Strands clearly and keeps the hero focused on the open-source framework', () => {
    const banner = homepage.querySelector('.banner')

    expect(banner?.querySelectorAll('h1 > span').map((line) => line.text.trim())).toEqual([
      'Build agents.',
      'Control of every layer.',
    ])
    expect(banner?.querySelector('.banner__intro')?.text).toContain('open-source framework')
    expect(banner?.querySelector('.banner__intro')?.text).toContain('composable tools')
    expect(banner?.querySelector('.banner__intro')?.text).not.toContain('Start with Harness')
    expect(banner?.querySelector('h1')?.getAttribute('aria-label')).toBeUndefined()
    expect(banner?.querySelectorAll('.banner__cta')).toHaveLength(2)
    expect(banner?.querySelector('.banner__cta--primary')?.getAttribute('href')).toBe('#framework')
    expect(banner?.querySelector('.banner__cta--primary')?.text.trim()).toBe('Explore the framework')
    expect(banner?.querySelector('.banner__cta--secondary')?.getAttribute('href')).toBe(
      'https://github.com/strands-agents'
    )
    expect(banner?.querySelector('.banner__cta--secondary')?.text.trim()).toBe('View on GitHub')
    expect(banner?.querySelector('.banner__install')).toBeNull()
    expect(banner?.querySelector('.banner__dots')).not.toBeNull()
  })

  it('does not ship the rejected hero comparison controls', () => {
    expect(homepage.querySelector('.concept-switcher')).toBeNull()
    expect(homepageHtml).not.toContain('data-concept-id')
    expect(homepageHtml).not.toContain('applyHeroConceptFromSearch')
  })

  it('presents Strands as one connected framework rather than peer products', () => {
    const productFor = (slug: string) => products.find((product) => product.slug === slug)!
    const harness = productFor('/harness')
    const harnessQuickstart = harness.pages?.find((page) => page.label === 'Quickstart')
    const sdk = productFor('/harness-sdk')
    const capabilities = ['/box', '/shell', '/evals', '/decider'].map(productFor)
    const framework = homepage.querySelector('.framework')
    const layers = framework?.querySelectorAll('.framework__layer') ?? []
    const capabilityItems = framework?.querySelectorAll('.framework__capability') ?? []

    expect(framework?.getAttribute('id')).toBe('framework')
    expect(framework?.querySelector('.framework__intro h2')?.text.trim()).toBe('Build an Agent')
    expect(
      layers.map((layer) => ({
        marker: layer.querySelector('.framework__card-meta span')?.text.trim(),
        slug: layer.querySelector('.framework__card-meta strong')?.text.trim(),
        name: layer.querySelector('h3')?.text.trim(),
        href: layer.querySelector('.framework__card-link')?.getAttribute('href'),
      }))
    ).toEqual([
      {
        marker: 'Recommended',
        slug: harness.slug,
        name: harness.label,
        href: harnessQuickstart?.href,
      },
      {
        marker: 'Direct control',
        slug: sdk.slug,
        name: sdk.label,
        href: sdk.href,
      },
    ])
    expect(
      capabilityItems.map((item) => ({
        name: item.querySelector('h4')?.text.trim(),
        href: item.querySelector('a')?.getAttribute('href'),
      }))
    ).toEqual(capabilities.map((product) => ({ name: product.label, href: product.href })))
    expect(
      capabilityItems
        .find((item) => item.querySelector('h4')?.text.trim() === 'Decider')
        ?.querySelector('.framework__capability-meta span:last-child')
        ?.text.trim()
    ).toBe('/decider')
    expect(framework?.text).not.toContain('Experimental')
    expect(framework?.querySelector('.framework__labs')).toBeNull()
    expect(homepageHtml.indexOf('class="framework ')).toBeLessThan(homepageHtml.indexOf('class="logo-farm '))
    expect(homepageHtml.indexOf('class="logo-farm ')).toBeLessThan(homepageHtml.indexOf('class="use-cases '))
  })

  it('centers the customer proof label and leads with AWS', () => {
    const logoFarm = homepage.querySelector('.logo-farm')
    const logos = logoFarm?.querySelectorAll('.logo-farm__cell') ?? []

    expect(logoFarm?.querySelector('.logo-farm__label')?.text.trim()).toBe('Teams building agents with Strands')
    expect(logos).toHaveLength(8)
    expect(logos[0]?.getAttribute('data-logo')).toBe('AWS')
    expect(logos[0]?.getAttribute('href')).toBe('https://aws.amazon.com/')
  })

  it('ships four progressively enhanced use-case examples', () => {
    const useCases = homepage.querySelector('.use-cases')
    const cases = useCases?.querySelectorAll('[data-use-case]') ?? []
    const buttons = useCases?.querySelectorAll('[data-use-case-button]') ?? []
    const panels = useCases?.querySelectorAll('[data-use-case-panel]') ?? []
    const variants = useCases?.querySelectorAll('[data-code-variant]') ?? []

    expect(cases).toHaveLength(4)
    expect(cases.map((item) => item.querySelector('.use-cases__button-title')?.text.trim())).toEqual([
      'Automate workflows',
      'Build assistants',
      'Research the web',
      'Coordinate agents',
    ])
    expect(useCases?.querySelector('a')?.getAttribute('href')).toBe('https://github.com/strands-agents/samples')
    expect(buttons).toHaveLength(4)
    expect(buttons.map((button) => button.getAttribute('aria-expanded'))).toEqual(['true', 'false', 'false', 'false'])
    expect(panels).toHaveLength(4)
    expect(panels.map((panel) => panel.getAttribute('aria-hidden'))).toEqual(['false', 'true', 'true', 'true'])
    expect(panels.map((panel) => panel.hasAttribute('hidden'))).toEqual([false, true, true, true])
    expect(variants).toHaveLength(8)
    expect(variants.filter((variant) => variant.getAttribute('data-code-variant') === 'TypeScript')).toHaveLength(4)
    expect(variants.filter((variant) => variant.getAttribute('data-code-variant') === 'Python')).toHaveLength(4)
    expect(useCases?.querySelectorAll('pre')).toHaveLength(8)
  })

  it('keeps every testimonial available in the stable, automatic story browser', () => {
    const proof = homepage.querySelector('.prove')
    const stories = proof?.querySelectorAll('[data-testimonial-story]') ?? []

    expect(stories).toHaveLength(15)
    expect(stories.map((story) => story.getAttribute('aria-hidden'))).toEqual([
      'false',
      ...Array<string>(14).fill('true'),
    ])
    expect(stories.every((story) => !story.hasAttribute('hidden'))).toBe(true)
    expect(stories.map((story) => story.hasAttribute('inert'))).toEqual([false, ...Array<boolean>(14).fill(true)])
    expect(proof?.getAttribute('data-testimonial-interval')).toBe('9000')
    expect(proof?.querySelector('[data-testimonial-toggle]')?.getAttribute('aria-label')).toBe(
      'Pause automatic story rotation'
    )
    expect(proof?.querySelector('[data-testimonial-previous]')?.getAttribute('aria-label')).toBe('Previous story')
    expect(proof?.querySelector('[data-testimonial-next]')?.getAttribute('aria-label')).toBe('Next story')
    expect(proof?.querySelector('[data-testimonial-current]')?.text.trim()).toBe('01')
    expect(proof?.querySelector('.prove__counter')?.text.replace(/\s+/g, '')).toBe('01/15stories')
  })

  it('restores a compact FAQ before the final Harness call to action', () => {
    const faq = homepage.querySelector('.home-faq')
    const items = faq?.querySelectorAll('.home-faq__item') ?? []

    expect(faq?.querySelector('h2')?.text.trim()).toBe('Questions before you start.')
    expect(items).toHaveLength(5)
    expect(items.map((item) => item.hasAttribute('open'))).toEqual([true, false, false, false, false])
    expect(items.map((item) => item.querySelector('summary')?.text.trim())).toEqual([
      'What is Strands?',
      'Should I start with Harness or the Harness SDK?',
      'Can I customize Harness without starting over?',
      'How do Box, Shell, Evals, and Decider fit?',
      'Where can I run a Strands agent?',
    ])
    expect(faq?.querySelector('.home-faq__link')?.getAttribute('href')).toBe(configuredPathWithBase('/faq/'))
    expect(homepageHtml.indexOf('class="home-faq ')).toBeLessThan(homepageHtml.indexOf('class="next-steps '))
  })

  it('keeps other retired homepage sections removed', () => {
    expect(homepage.querySelector('.community')).toBeNull()
    expect(homepage.querySelector('.interactive-toolkit')).toBeNull()
  })

  it('returns to Harness once in the final call to action', () => {
    const nextSteps = homepage.querySelector('.next-steps')
    const footer = homepage.querySelector('.footer')

    expect(nextSteps?.querySelector('h2')?.text.trim()).toBe('Build your first agent.')
    expect(nextSteps?.querySelector('.next-steps__shape--desktop')).not.toBeNull()
    expect(nextSteps?.querySelector('.next-steps__shape--mobile')).not.toBeNull()
    expect(nextSteps?.querySelector('.next-steps__cta--primary')?.getAttribute('href')).toBe(
      configuredPathWithBase('/docs/user-guide/harness/quickstart/')
    )
    expect(nextSteps?.text).toContain('npm install @strands-agents/harness')
    expect(nextSteps?.querySelector('.next-steps__cta--secondary')?.getAttribute('href')).toBe(
      'https://github.com/strands-agents/harness-sdk'
    )
    expect(footer?.querySelector('.footer__get-started')).toBeNull()
    expect(footer?.querySelector('.footer__columns')).not.toBeNull()
  })

  it('promotes the latest blog post in the announcement', async () => {
    const posts = await getCollection('blog', ({ data }) => !data.draft)
    posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime())

    const latestPost = posts[0]
    if (!latestPost) throw new Error('expected at least one published blog post')

    const announcement = homepage.querySelector('.announcement')
    const bannerLink = announcement?.querySelector('.announcement__link')

    expect(bannerLink?.getAttribute('href')).toBe(configuredPathWithBase(`/blog/${latestPost.id}/`))
    expect(bannerLink?.querySelector('.announcement__title')?.text.trim()).toBe(latestPost.data.title)
    expect(announcement?.getAttribute('data-expires')).toBeUndefined()
    expect(announcement?.querySelector('.announcement__fallback')).toBeNull()
  })

  it('publishes a concise Markdown homepage with official resources', () => {
    const markdown = readFileSync(new URL('../dist/index.md', import.meta.url), 'utf8')
    const harnessQuickstart = markdown.indexOf('/docs/user-guide/harness/quickstart/index.md')
    const sdkQuickstart = markdown.indexOf('/docs/user-guide/sdk/quickstart/overview/index.md')

    expect(markdown).toContain('# Strands Agents')
    expect(harnessQuickstart).toBeGreaterThan(-1)
    expect(markdown).toContain('/docs/user-guide/sdk/quickstart/overview/index.md')
    expect(harnessQuickstart).toBeLessThan(sdkQuickstart)
    expect(markdown).toContain('/examples/')
    expect(markdown).toContain('/faq/index.md')
    expect(markdown).toContain('https://pypi.org/project/strands-agents/')
    expect(markdown).toContain('https://www.npmjs.com/package/@strands-agents/sdk')
    expect(markdown).toContain('https://github.com/strands-agents/harness-sdk')
    expect(markdown).toContain('/llms.txt')
    expect(markdown.length).toBeLessThan(4_000)
  })
})

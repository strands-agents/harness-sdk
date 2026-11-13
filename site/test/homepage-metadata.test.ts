import { existsSync, readFileSync } from 'node:fs'

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
  const homepage = parse(homepageHtml, { blockTextElements: { script: true, style: true, noscript: true } })

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

  it('defines Strands as an open-source toolkit and keeps the hero focused', () => {
    const banner = homepage.querySelector('.banner')

    expect(banner?.querySelectorAll('h1 > span').map((line) => line.text.trim())).toEqual([
      'The open source',
      'toolkit for',
      'production agents.',
    ])
    expect(banner?.querySelector('.banner__intro')).toBeNull()
    expect(banner?.querySelector('.banner__eyebrow')).toBeNull()
    expect(banner?.querySelector('h1')?.getAttribute('aria-label')).toBeUndefined()
    expect(banner?.querySelectorAll('.banner__cta')).toHaveLength(2)
    expect(banner?.querySelector('.banner__cta--primary')?.getAttribute('href')).toBe(
      configuredPathWithBase('/docs/user-guide/harness/')
    )
    expect(banner?.querySelector('.banner__cta--primary')?.text.trim()).toBe('Build an agent')
    expect(banner?.querySelector('.banner__cta--secondary')?.getAttribute('href')).toBe(
      'https://github.com/strands-agents/harness-sdk'
    )
    expect(banner?.querySelector('.banner__cta--secondary')?.text.trim()).toBe('GitHub')
    expect(
      banner?.querySelectorAll('.banner__install [data-install-variant]').map((command) => command.text.trim())
    ).toEqual(['pip install strands-harness', 'npm install @strands-agents/harness'])
    expect(banner?.querySelector('.banner__actions + .banner__install')).not.toBeNull()
    expect(banner?.querySelector('.banner__dots')).not.toBeNull()
    expect(homepage.querySelector('meta[property="og:image:alt"]')?.getAttribute('content')).toBe(
      'Strands Agents: The open source toolkit for production agents.'
    )
  })

  it('features Harness with visible code and expands supporting projects independently', () => {
    const framework = homepage.querySelector('.framework')
    const harness = framework?.querySelector('.framework__harness-feature')
    const capabilities = framework?.querySelectorAll('.framework__capability') ?? []

    expect(framework?.querySelector('#framework-build-title')?.text.trim()).toBe('Build an agent')
    expect(framework?.querySelectorAll('.framework__harness-feature')).toHaveLength(1)
    expect(harness?.querySelector('h3')?.text.trim()).toBe('Start with a complete agent.')
    expect(harness?.querySelector('.framework__card-link')?.getAttribute('href')).toBe(
      configuredPathWithBase('/docs/user-guide/harness/')
    )
    expect(harness?.querySelector('details')).toBeNull()
    expect(harness?.querySelector('[data-example-language="Python"] code')?.text).toContain('create_harness()')
    expect(harness?.querySelector('[data-example-language="TypeScript"] code')?.text).toContain('await createHarness()')
    expect(framework?.text).not.toContain('/harness-sdk')
    expect(framework?.querySelectorAll('.framework__branch > h2').map((heading) => heading.text.trim())).toEqual([
      'Sandbox agent work',
      'Validate agent behavior',
      'Make fast decisions',
    ])
    expect(
      capabilities.map((item) => ({
        title: item.querySelector('.framework__product-title')?.text.trim(),
        href: item.querySelector('a')?.getAttribute('href'),
      }))
    ).toEqual([
      { title: '/box', href: configuredPathWithBase('/docs/user-guide/box/') },
      { title: '/evals', href: configuredPathWithBase('/docs/user-guide/evals-sdk/') },
      { title: '/decider', href: configuredPathWithBase('/docs/labs/strands-decider/overview/') },
    ])
    for (const item of capabilities) {
      expect(item.querySelector('details')?.hasAttribute('open')).toBe(false)
      expect(item.querySelector('summary p')?.text.trim().length).toBeGreaterThan(20)
      expect(item.querySelector('details a')).toBeNull()
      expect(item.querySelector('details + a')).not.toBeNull()
    }
    expect(capabilities[0]?.querySelector('svg[role="img"] title')?.text).toContain('Example sandbox')
    expect(capabilities[1]?.querySelectorAll('[data-example-language]')).toHaveLength(1)
    expect(capabilities[1]?.querySelector('[data-example-language="Python"]')?.hasAttribute('hidden')).toBe(false)
    expect(capabilities[1]?.querySelector('code')?.text).toContain('.run_evaluations(task)')
    expect(capabilities[2]?.querySelector('summary')?.text).toContain('System One')
    expect(capabilities[2]?.querySelector('svg[role="img"] title')?.text).toContain('selects Billing')
    expect(homepageHtml.indexOf('class="framework ')).toBeLessThan(homepageHtml.indexOf('class="logo-farm '))
  })

  it('keeps every scrollable install command keyboard accessible', () => {
    const commands = homepage.querySelectorAll('.install__cmd')

    expect(commands.length).toBeGreaterThan(0)
    expect(commands.every((command) => command.getAttribute('role') === 'region')).toBe(true)
    expect(commands.every((command) => command.getAttribute('tabindex') === '0')).toBe(true)
    expect(commands.every((command) => command.getAttribute('aria-label') === 'Install command')).toBe(true)
  })

  it('centers the customer proof label and leads with AWS', () => {
    const logoFarm = homepage.querySelector('.logo-farm')
    const logos = logoFarm?.querySelectorAll('.logo-farm__cell') ?? []

    expect(logoFarm?.querySelector('.logo-farm__label')?.text.trim()).toBe('Build with')
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
    const icons = useCases?.querySelectorAll('.use-cases__icon') ?? []

    expect(cases).toHaveLength(4)
    expect(cases.map((item) => item.querySelector('.use-cases__button-title')?.text.trim())).toEqual([
      'Automate workflows',
      'Build assistants',
      'Research the web',
      'Coordinate agents',
    ])
    const examplesLink = useCases?.querySelector('.use-cases__link')
    expect(examplesLink?.getAttribute('href')).toBe('https://github.com/strands-agents/samples')
    expect(useCases?.text).not.toContain('Choose a use case to see a complete Harness example')
    expect(homepageHtml.indexOf('use-cases__demo')).toBeLessThan(homepageHtml.indexOf('use-cases__footer'))
    expect(buttons).toHaveLength(4)
    expect(icons).toHaveLength(4)
    expect(buttons.map((button) => button.querySelector('.use-cases__button-meta')?.text.trim())).toEqual([
      '',
      '',
      '',
      '',
    ])
    expect(buttons.map((button) => button.getAttribute('aria-expanded'))).toEqual(['true', 'false', 'false', 'false'])
    expect(panels).toHaveLength(4)
    expect(panels.map((panel) => panel.getAttribute('aria-hidden'))).toEqual(['false', 'true', 'true', 'true'])
    expect(panels.map((panel) => panel.hasAttribute('hidden'))).toEqual([false, true, true, true])
    expect(variants).toHaveLength(8)
    expect(variants.filter((variant) => variant.getAttribute('data-code-variant') === 'TypeScript')).toHaveLength(4)
    expect(variants.filter((variant) => variant.getAttribute('data-code-variant') === 'Python')).toHaveLength(4)
    expect(variants.every((variant) => variant.getAttribute('role') === 'region')).toBe(true)
    expect(variants.every((variant) => variant.getAttribute('tabindex') === '0')).toBe(true)
    expect(variants.every((variant) => variant.hasAttribute('aria-label'))).toBe(true)
    const codeBlocks = useCases?.querySelectorAll('pre') ?? []
    expect(codeBlocks).toHaveLength(8)
    expect(codeBlocks.every((block) => block.getAttribute('tabindex') === '-1')).toBe(true)
    expect(codeBlocks.every((block) => block.classList.contains('astro-code-themes'))).toBe(true)
    expect(codeBlocks.every((block) => block.classList.contains('github-light'))).toBe(true)
    expect(codeBlocks.every((block) => block.classList.contains('github-dark'))).toBe(true)
    expect(codeBlocks.every((block) => block.getAttribute('style')?.includes('--shiki-light:'))).toBe(true)
    expect(codeBlocks.every((block) => block.getAttribute('style')?.includes('--shiki-dark:'))).toBe(true)
  })

  it('keeps every testimonial available before enhancing the story browser', async () => {
    const testimonialEntries = await getCollection('testimonials')
    const proof = homepage.querySelector('.prove')
    const stories = proof?.querySelectorAll('[data-testimonial-story]') ?? []
    const total = String(testimonialEntries.length).padStart(2, '0')

    expect(stories).toHaveLength(testimonialEntries.length)
    expect(stories.every((story) => !story.hasAttribute('hidden'))).toBe(true)
    expect(stories.every((story) => !story.hasAttribute('aria-hidden'))).toBe(true)
    expect(stories.every((story) => !story.hasAttribute('inert'))).toBe(true)
    expect(proof?.getAttribute('data-testimonial-interval')).toBe('9000')
    expect(proof?.querySelector('[data-testimonial-toggle]')?.getAttribute('aria-label')).toBe(
      'Pause automatic story rotation'
    )
    expect(proof?.querySelector('[data-testimonial-previous]')?.getAttribute('aria-label')).toBe('Previous story')
    expect(proof?.querySelector('[data-testimonial-next]')?.getAttribute('aria-label')).toBe('Next story')
    expect(proof?.querySelector('[data-testimonial-current]')?.text.trim()).toBe('01')
    expect(proof?.querySelector('.prove__counter')?.text.replace(/\s+/g, '')).toBe(`01/${total}stories`)
  })

  it('restores a compact FAQ before the final Harness action and branded footer', () => {
    const faq = homepage.querySelector('.home-faq')
    const nextSteps = homepage.querySelector('.next-steps')
    const footer = homepage.querySelector('.footer')
    const items = faq?.querySelectorAll('.home-faq__item') ?? []

    expect(faq?.querySelector('h2')?.text.trim()).toBe('Questions before you start.')
    expect(items).toHaveLength(5)
    expect(items.map((item) => item.hasAttribute('open'))).toEqual([true, false, false, false, false])
    expect(items.map((item) => item.querySelector('summary')?.text.trim())).toEqual([
      'What is Strands?',
      'Should I use Harness or the Harness SDK?',
      'Can I customize Harness without starting over?',
      'How do Box, Shell, Evals, and Decider fit?',
      'Where can I run a Strands agent?',
    ])
    expect(faq?.querySelector('.home-faq__link')?.getAttribute('href')).toBe(configuredPathWithBase('/faq/'))
    expect(homepageHtml.indexOf('class="home-faq ')).toBeLessThan(homepageHtml.indexOf('class="next-steps '))
    expect(homepageHtml.indexOf('class="next-steps ')).toBeLessThan(homepageHtml.indexOf('class="footer '))
    expect(nextSteps?.querySelector('.next-steps__eyebrow')?.text.trim()).toBe('Start with Harness')
    expect(nextSteps?.querySelector('h2')?.text.trim()).toBe('Build your first agent.')
    expect(nextSteps?.text).toContain('pip install strands-harness')
    expect(nextSteps?.text).toContain('npm install @strands-agents/harness')
    expect(nextSteps?.querySelector('.next-steps__cta--primary')?.getAttribute('href')).toBe(
      configuredPathWithBase('/docs/user-guide/harness/quickstart/')
    )
    expect(nextSteps?.querySelector('.next-steps__cta--secondary')?.getAttribute('href')).toBe(
      'https://github.com/strands-agents/harness-sdk'
    )
    expect(nextSteps?.querySelector('.next-steps__ctas + .next-steps__install')).not.toBeNull()
    expect(homepage.querySelector('.footer__transition')).toBeNull()
    expect(footer?.querySelector('.footer__get-started')).toBeNull()
    expect(footer?.querySelector('.footer__columns')).not.toBeNull()
    expect(footer?.classList.contains('footer--theme')).toBe(false)
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
    const harnessOverview = markdown.indexOf('/docs/user-guide/harness/index.md')
    const sdkQuickstart = markdown.indexOf('/docs/user-guide/sdk/quickstart/overview/index.md')

    expect(markdown).toContain('# Strands Agents')
    expect(markdown).toContain('open-source toolkit')
    expect(harnessOverview).toBeGreaterThan(-1)
    expect(markdown).toContain('/docs/user-guide/sdk/quickstart/overview/index.md')
    expect(harnessOverview).toBeLessThan(sdkQuickstart)
    expect(markdown).not.toContain('/docs/user-guide/shell/index.md')
    expect(markdown).toContain('/examples/')
    expect(markdown).toContain('/faq/index.md')
    expect(markdown).toContain('https://pypi.org/project/strands-agents/')
    expect(markdown).toContain('https://www.npmjs.com/package/@strands-agents/sdk')
    expect(markdown).toContain('https://github.com/strands-agents/harness-sdk')
    expect(markdown).toContain('/llms.txt')
    expect(markdown.length).toBeLessThan(4_000)
  })

  it('publishes only internal Markdown links that resolve in the built site', () => {
    const markdown = readFileSync(new URL('../dist/index.md', import.meta.url), 'utf8')
    const siteOrigin = process.env.SITE_DOMAIN?.replace(/\/$/, '')
    const links = [...markdown.matchAll(/\]\(([^)]+)\)/g)]
      .map((match) => match[1]!)
      .flatMap((link) => {
        if (link.startsWith('/')) return [link]
        if (siteOrigin && link.startsWith(`${siteOrigin}/`)) return [link.slice(siteOrigin.length)]
        return []
      })
    const configuredBase = configuredPathWithBase('/')

    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      const path = link.split(/[?#]/, 1)[0]!
      const outputPath = configuredBase === '/' ? path : path.slice(configuredBase.length - 1)
      expect(existsSync(new URL(`../dist${outputPath}`, import.meta.url)), link).toBe(true)
    }
  })
})

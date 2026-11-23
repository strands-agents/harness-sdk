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

  it('offers a quickstart CTA and GitHub stars without duplicating the harness install command in the hero', () => {
    const banner = homepage.querySelector('.banner')
    const primaryCta = banner?.querySelector('.banner__link--primary')
    const githubCta = banner?.querySelector('.banner__link--github')
    const githubStars = githubCta?.querySelector('.banner__github-stars')?.text.trim()

    expect({
      primary: {
        text: primaryCta?.text.trim(),
        href: primaryCta?.getAttribute('href'),
      },
      github: {
        text: githubCta?.text.trim(),
        href: githubCta?.getAttribute('href'),
        ariaLabel: githubCta?.getAttribute('aria-label'),
        hasIcon: Boolean(githubCta?.querySelector('.banner__github-icon svg')),
        stars: githubStars,
      },
      navigation: {
        hasGithubLink: Boolean(homepage.querySelector('.strands-nav__github')),
        hasStarCount: Boolean(homepage.querySelector('.strands-nav__github-stars')),
      },
      hasInstallCommand: Boolean(banner?.querySelector('[data-install], [data-install-copy]')),
    }).toEqual({
      primary: {
        text: 'Build an agent',
        href: configuredPathWithBase('/docs/user-guide/harness/quickstart/'),
      },
      github: {
        text: githubStars,
        href: 'https://github.com/strands-agents',
        ariaLabel: `View Strands on GitHub, ${githubStars} stars`,
        hasIcon: true,
        stars: expect.stringMatching(/^\d{1,3}(,\d{3})*\+$/),
      },
      navigation: {
        hasGithubLink: true,
        hasStarCount: false,
      },
      hasInstallCommand: false,
    })
  })

  it('advertises the Markdown homepage', () => {
    const alternate = homepage.querySelector('link[rel="alternate"][type="text/markdown"]')

    expect(alternate?.getAttribute('href')).toBe(configuredPathWithBase('/index.md'))
  })

  it('advertises the OpenAPI description', () => {
    const serviceDescription = homepage.querySelector('link[rel="service-desc"][type="application/json"]')

    expect(serviceDescription?.getAttribute('href')).toBe(configuredPathWithBase('/openapi.json'))
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

  it('keeps harness and the SDK in one split card with distinct starting points', () => {
    const toolkit = homepage.querySelector('.toolkit')
    const sections = toolkit?.querySelectorAll('.toolkit__section') ?? []
    const buildCard = sections[0]?.querySelector('.toolkit__build-card')
    const harness = buildCard?.querySelector('[data-toolkit-product="harness"]')
    const sdk = sections[0]?.querySelector('.toolkit__sdk-option [data-toolkit-product="harness-sdk"]')

    expect({
      label: toolkit?.getAttribute('aria-label'),
      buildSection: {
        id: sections[0]?.getAttribute('id'),
        labelledBy: sections[0]?.getAttribute('aria-labelledby'),
      },
      supportingSection: {
        labelledBy: sections[1]?.getAttribute('aria-labelledby'),
        heading: {
          tag: sections[1]?.querySelector('#toolkit-supporting-title')?.tagName,
          text: sections[1]?.querySelector('#toolkit-supporting-title')?.text.trim(),
        },
      },
      hasBuildCard: Boolean(buildCard),
      harness: {
        heading: {
          id: harness?.querySelector('h2')?.getAttribute('id'),
          text: harness?.querySelector('h2')?.text.trim(),
        },
        headline: sections[0]?.querySelector(':scope > .toolkit__build-headline')?.text.trim(),
        description: harness?.querySelector('.toolkit__build-description')?.text.trim(),
        action: {
          text: harness?.querySelector('.toolkit__build-action')?.text.trim(),
          href: harness?.querySelector('.toolkit__build-action')?.getAttribute('href'),
          ariaLabel: harness?.querySelector('.toolkit__build-action')?.getAttribute('aria-label'),
        },
      },
      sdk: {
        heading: sdk?.querySelector('h3')?.text.trim(),
        relation: sections[0]?.querySelector('.toolkit__build-sdk-relation')?.text.trim(),
        labelledBy: sdk?.getAttribute('aria-labelledby'),
        insideHarnessCard: Boolean(buildCard?.querySelector('[data-toolkit-product="harness-sdk"]')),
        description: sdk?.querySelector('.toolkit__build-sdk-description')?.text.trim() ?? null,
        action: {
          text: sdk?.querySelector('.toolkit__build-sdk-action')?.text.trim(),
          href: sdk?.querySelector('.toolkit__build-sdk-action')?.getAttribute('href'),
          ariaLabel: sdk?.querySelector('.toolkit__build-sdk-action')?.getAttribute('aria-label'),
        },
      },
    }).toEqual({
      label: 'Strands toolkit',
      buildSection: {
        id: undefined,
        labelledBy: 'toolkit-harness-title',
      },
      supportingSection: {
        labelledBy: 'toolkit-supporting-title',
        heading: {
          tag: 'H2',
          text: 'Control and improve your agent',
        },
      },
      hasBuildCard: true,
      harness: {
        heading: {
          id: 'toolkit-harness-title',
          text: '/harness',
        },
        headline: 'Start with a complete agent.',
        description:
          'Strands harness gives you an agent with tools, memory, session management, and context management already configured. Replace individual components to fit your use case.',
        action: {
          text: 'Build an agent',
          href: configuredPathWithBase('/docs/user-guide/harness/quickstart/'),
          ariaLabel: 'Build an agent with Strands harness',
        },
      },
      sdk: {
        heading: '/harness-sdk',
        relation: 'Built on',
        labelledBy: 'toolkit-sdk-relation toolkit-sdk-title',
        insideHarnessCard: true,
        description: null,
        action: {
          text: 'Explore the SDK',
          href: configuredPathWithBase('/docs/user-guide/sdk/'),
          ariaLabel: 'Explore the Harness SDK',
        },
      },
    })
  })

  it('keeps the harness example and install in the upper card section', () => {
    const buildCard = homepage.querySelector('.toolkit__section--build')
    const harness = buildCard?.querySelector('[data-toolkit-product="harness"]')
    const sdk = homepage.querySelector('[data-toolkit-product="harness-sdk"]')

    expect({
      harnessTerminalCount: harness?.querySelectorAll('.toolkit__card-terminal').length,
      sdkTerminalCount: sdk?.querySelectorAll('.toolkit__card-terminal').length,
      toggleCount: buildCard?.querySelectorAll('[data-toggle]').length,
      visibleLanguage: harness?.querySelector('[data-lang-code]:not([hidden])')?.getAttribute('data-lang-code'),
      languageLabel: harness?.querySelector('.toolkit__card-terminal-language')?.text.trim(),
      copyLabel: harness?.querySelector('.toolkit__card-terminal-copy')?.getAttribute('aria-label'),
      sdkHasInstall: Boolean(sdk?.querySelector('[data-install]')),
    }).toEqual({
      harnessTerminalCount: 1,
      sdkTerminalCount: 0,
      toggleCount: 0,
      visibleLanguage: 'typescript',
      languageLabel: 'TypeScript',
      copyLabel: 'Copy Strands harness example',
      sdkHasInstall: false,
    })
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
    ])
  })

  it('keeps the supporting products expandable and correctly labelled', () => {
    const toolsSection = homepage.querySelectorAll('.toolkit__section')[1]
    const products = toolsSection?.querySelectorAll('.toolkit__supporting-product') ?? []
    const cards = products.map((product) => product.querySelector('.toolkit__card'))
    const connectors = toolsSection?.querySelector('.toolkit__supporting-connectors')

    expect(connectors?.getAttribute('aria-hidden')).toBe('true')
    expect(connectors?.querySelectorAll('.toolkit__supporting-connector')).toHaveLength(3)

    expect(
      products.map((product) => ({
        tag: product.tagName,
        labelledBy: product.getAttribute('aria-labelledby'),
        role: {
          tag: product.querySelector(':scope > .toolkit__supporting-role')?.tagName,
          id: product.querySelector(':scope > .toolkit__supporting-role')?.getAttribute('id'),
          text: product.querySelector(':scope > .toolkit__supporting-role')?.text.trim(),
        },
        slug: {
          tag: product.querySelector('.toolkit__card-slug')?.tagName,
          text: product.querySelector('.toolkit__card-slug')?.text.trim(),
        },
        description: product.querySelector('.toolkit__card-desc')?.text.trim(),
        action: {
          text: product.querySelector('.toolkit__card-read')?.text.trim(),
          href: product.querySelector('.toolkit__card-read')?.getAttribute('href'),
          ariaLabel: product.querySelector('.toolkit__card-read')?.getAttribute('aria-label'),
        },
      }))
    ).toEqual([
      {
        tag: 'ARTICLE',
        labelledBy: 'toolkit-box-role',
        role: {
          tag: 'H3',
          id: 'toolkit-box-role',
          text: 'Sandbox agent work',
        },
        slug: {
          tag: 'H4',
          text: '/box',
        },
        description:
          'Run coding agents like Claude Code in an OS-enforced sandbox. Choose which files, programs, and hosts they reach, and keep your keys out of their reach.',
        action: {
          text: 'Explore Strands Box',
          href: configuredPathWithBase('/box/'),
          ariaLabel: 'Explore Strands Box',
        },
      },
      {
        tag: 'ARTICLE',
        labelledBy: 'toolkit-evals-role',
        role: {
          tag: 'H3',
          id: 'toolkit-evals-role',
          text: 'Validate agent behavior',
        },
        slug: {
          tag: 'H4',
          text: '/evals',
        },
        description: 'Run evaluations, detect failures, and measure agent behavior before deployment.',
        action: {
          text: 'Run an evaluation',
          href: configuredPathWithBase('/docs/user-guide/evals-sdk/'),
          ariaLabel: 'Run an evaluation with Strands Evals',
        },
      },
      {
        tag: 'ARTICLE',
        labelledBy: 'toolkit-decider-role',
        role: {
          tag: 'H3',
          id: 'toolkit-decider-role',
          text: 'Make fast decisions',
        },
        slug: {
          tag: 'H4',
          text: '/decider',
        },
        description: 'Route, classify, or score known outcomes with a small decision model that reports confidence.',
        action: {
          text: 'Explore the models',
          href: configuredPathWithBase('/docs/labs/strands-decider/overview/'),
          ariaLabel: 'Explore the Strands Decider models',
        },
      },
    ])
    expect(cards).toHaveLength(3)
    expect(toolsSection?.querySelectorAll('[data-install]')).toHaveLength(0)
    expect(toolsSection?.querySelectorAll('.toolkit__card.is-open')).toHaveLength(0)
    expect(
      cards.map((card) => {
        const details = card?.querySelector('.toolkit__card-expanded')
        return {
          languages: details?.querySelectorAll('[data-lang-code]').map((panel) => panel.getAttribute('data-lang-code')),
          languageLabel: details?.querySelector('.toolkit__card-terminal-language')?.text.trim(),
          copyLabel: details?.querySelector('.toolkit__card-terminal-copy')?.getAttribute('aria-label'),
          extraContent: details?.querySelector(
            '.toolkit__card-slug, .toolkit__card-expanded-text, .toolkit__card-view-more'
          ),
          hasCodeIcon: Boolean(card?.querySelector('.toolkit__card-open-icon svg')),
        }
      })
    ).toEqual([
      {
        languages: ['policy'],
        languageLabel: 'Policy',
        copyLabel: 'Copy /box code',
        extraContent: null,
        hasCodeIcon: true,
      },
      {
        languages: ['python'],
        languageLabel: 'Python',
        copyLabel: 'Copy /evals code',
        extraContent: null,
        hasCodeIcon: true,
      },
      {
        languages: ['shell'],
        languageLabel: 'Shell',
        copyLabel: 'Copy /decider code',
        extraContent: null,
        hasCodeIcon: true,
      },
    ])
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
        toggleLabel: 'Show /box code example',
      },
      {
        expanded: 'false',
        controls: 'toolkit-card-evals-details',
        detailsId: 'toolkit-card-evals-details',
        toggleLabel: 'Show /evals code example',
      },
      {
        expanded: 'false',
        controls: 'toolkit-card-decider-details',
        detailsId: 'toolkit-card-decider-details',
        toggleLabel: 'Show /decider code example',
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
    expect(markdown).toContain('/box/index.md')
    expect(markdown).toContain('/examples/')
    expect(markdown).toContain('/faq/index.md')
    expect(markdown).toContain('https://pypi.org/project/strands-agents/')
    expect(markdown).toContain('https://www.npmjs.com/package/@strands-agents/sdk')
    expect(markdown).toContain('https://github.com/strands-agents/harness-sdk')
    expect(markdown).toContain('/llms.txt')
    expect(markdown.length).toBeLessThan(4_000)
  })
})

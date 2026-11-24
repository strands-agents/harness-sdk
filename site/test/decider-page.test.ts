import { existsSync, readFileSync } from 'node:fs'

import { parse } from 'node-html-parser'
import { describe, expect, it } from 'vitest'

import {
  DECIDER_DECISION_EXAMPLES,
  DECIDER_HERO_TITLE,
  DECIDER_INSTALL_COMMAND,
  DECIDER_LANDING_DESCRIPTION,
  DECIDER_LANDING_TITLE,
  DECIDER_LINKS,
  DECIDER_OVERVIEW_DESCRIPTION,
  DECIDER_QUESTION_TYPES,
  DECIDER_RECORDED_EXAMPLE,
  DECIDER_REPOSITORY_URL,
  buildDeciderLandingMarkdown,
} from '../src/config/decider-landing'
import { getProductContent } from '../src/config/product-content'

function configuredPathWithBase(value: string): string {
  const base = (process.env.ASTRO_BASE_PATH ?? '/').replace(/\/$/, '')
  const normalizedValue = value.startsWith('/') ? value : `/${value}`
  return `${base}${normalizedValue}`
}

function configuredCanonical(value: string): string {
  const origin = (process.env.SITE_DOMAIN ?? 'https://strandsagents.com').replace(/\/$/, '')
  return `${origin}${configuredPathWithBase(value)}`
}

function builtOutputForHref(href: string): URL {
  const basePath = configuredPathWithBase('/')
  const path = href.split('#')[0]
  const relativePath = path.slice(basePath.length).replace(/^\/+/, '')
  const outputPath = relativePath.endsWith('.md') ? relativePath : `${relativePath.replace(/\/?$/, '/')}index.html`

  return new URL(`../dist/${outputPath}`, import.meta.url)
}

describe('Decider landing page', () => {
  const html = readFileSync(new URL('../dist/decider/index.html', import.meta.url), 'utf8')
  const page = parse(html)

  it('renders one standalone product story', () => {
    const main = page.querySelector('main')
    const headings = main?.querySelectorAll('h1, h2, h3, h4, h5, h6') ?? []

    expect(main?.getAttribute('data-pagefind-body')).not.toBeNull()
    expect(headings[0]?.tagName).toBe('H1')
    expect(main?.querySelectorAll('h1')).toHaveLength(1)
    expect(main?.querySelector('h1')?.text.replace(/\s+/g, ' ').trim()).toBe(DECIDER_HERO_TITLE)
    expect(main?.querySelectorAll('[data-decider-main-section]')).toHaveLength(1)
    expect(main?.querySelector('.decider-shapes__summary')?.text.trim()).toBe(DECIDER_OVERVIEW_DESCRIPTION)
    expect(main?.querySelector('#decider-overview-title')?.getAttribute('aria-label')).toBe('How Strands Decider works')
    expect(main?.querySelector('[data-decider-example-connectors]')?.getAttribute('aria-hidden')).toBe('true')
    expect(main?.querySelectorAll('[data-decider-example-connectors] span')).toHaveLength(2)
    expect(page.querySelector('.sidebar')).toBeNull()
    expect(page.querySelector('starlight-menu-button')).toBeNull()
  })

  it('shows a bounded decision with accessible probabilities and answer types', () => {
    const examples = page.querySelectorAll('[data-decider-example]')
    const questionTypes = page.querySelectorAll('[data-decider-question-type]')

    expect(examples).toHaveLength(DECIDER_DECISION_EXAMPLES.length)
    expect(questionTypes).toHaveLength(DECIDER_QUESTION_TYPES.length)

    for (const questionType of DECIDER_QUESTION_TYPES) {
      const link = page.querySelector(`[data-decider-question-type="${questionType.id}"]`)
      const example = page.querySelector(`[data-decider-example-type="${questionType.id}"]`)
      const configuredExample = DECIDER_DECISION_EXAMPLES.find((item) => item.id === questionType.id)

      expect(link?.tagName).toBe('A')
      expect(link?.text).toContain(questionType.label)
      expect(link?.getAttribute('href')).toBe(`#decider-example-${questionType.id}`)
      expect(link?.getAttribute('aria-controls')).toBe(example?.getAttribute('id'))
      expect(link?.getAttribute('aria-current')).toBeUndefined()
      expect(example?.getAttribute('role')).toBe('region')
      expect(example?.getAttribute('aria-labelledby')).toBe(link?.getAttribute('id'))
      expect(example?.hasAttribute('hidden')).toBe(false)
      expect(example?.querySelector('.decider-request')?.getAttribute('aria-labelledby')).toBe(
        `decider-request-label-${questionType.id}`
      )
      expect(example?.querySelector('.decider-response')?.getAttribute('aria-labelledby')).toBe(
        `decider-response-label-${questionType.id}`
      )
      expect(
        example?.querySelectorAll('.decider-example__panel-label').map((label) => label.childNodes[0]?.text.trim())
      ).toEqual(['Request', 'Response'])
      expect(example?.querySelector('[data-decider-example-state]')?.text).toContain(configuredExample?.state ?? '')
      expect(example?.querySelector('[data-decider-example-answer]')?.text).toContain(configuredExample?.answer ?? '')
      expect(example?.querySelector(`#decider-response-label-${questionType.id}`)?.text).toContain(
        configuredExample?.responseLabel ?? ''
      )
      const probabilities = example?.querySelectorAll('[data-decider-probability]') ?? []
      expect(probabilities).toHaveLength(configuredExample?.probabilities.length ?? 0)

      for (const probability of configuredExample?.probabilities ?? []) {
        const row = example?.querySelector(`[data-decider-probability="${probability.id}"]`)
        const accessibleLabel = row?.getAttribute('aria-label') ?? ''

        expect(accessibleLabel).toContain(probability.label)
        expect(accessibleLabel).toContain('%')
      }
    }

    const ids = page
      .querySelectorAll('[data-decider-example-selector] [id]')
      .map((element) => element.getAttribute('id'))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps the visual examples aligned with one recorded model run', () => {
    const choice = DECIDER_DECISION_EXAMPLES.find((example) => example.id === 'choice')
    const noul = DECIDER_DECISION_EXAMPLES.find((example) => example.id === 'noul')
    const score = DECIDER_DECISION_EXAMPLES.find((example) => example.id === 'score')

    expect(choice).toMatchObject({
      state: DECIDER_RECORDED_EXAMPLE.state,
      question: DECIDER_RECORDED_EXAMPLE.choice.question,
      answer: DECIDER_RECORDED_EXAMPLE.choice.answer,
      detailLabel: 'confidence',
      detailValue: DECIDER_RECORDED_EXAMPLE.choice.confidence.toFixed(3),
    })
    expect(choice?.probabilities).toEqual(DECIDER_RECORDED_EXAMPLE.choice.probabilities)

    expect(noul).toMatchObject({
      state: DECIDER_RECORDED_EXAMPLE.state,
      question: DECIDER_RECORDED_EXAMPLE.noul.question,
      answer: DECIDER_RECORDED_EXAMPLE.noul.answer.toFixed(3),
    })

    expect(score).toMatchObject({
      state: DECIDER_RECORDED_EXAMPLE.state,
      question: DECIDER_RECORDED_EXAMPLE.score.question,
      answer: DECIDER_RECORDED_EXAMPLE.score.answer.toFixed(2),
      detailLabel: 'confidence',
      detailValue: DECIDER_RECORDED_EXAMPLE.score.confidence.toFixed(3),
    })
    expect(score?.probabilities).toEqual(DECIDER_RECORDED_EXAMPLE.score.probabilities)
    expect(score?.probabilities).toHaveLength(score?.criteria.length ?? 0)

    const expectedScore =
      score?.probabilities.reduce((total, probability, index) => total + probability.value * index, 0) ?? Number.NaN
    expect(expectedScore.toFixed(2)).toBe(score?.answer)
  })

  it('uses public, valid destinations for every rendered link', () => {
    const configuredExternalLinks = [DECIDER_REPOSITORY_URL, ...Object.values(DECIDER_LINKS)].filter((href) =>
      href.startsWith('http')
    )

    expect(DECIDER_INSTALL_COMMAND).toContain('pip install strands-decider')

    for (const href of configuredExternalLinks) {
      expect(() => new URL(href)).not.toThrow()
      expect(href).not.toContain('staging-')
    }

    for (const link of page.querySelectorAll<HTMLAnchorElement>('main a')) {
      const href = link.getAttribute('href')
      if (!href || href.startsWith('#')) continue

      if (href.startsWith('http')) {
        expect(() => new URL(href)).not.toThrow()
        expect(href).not.toContain('staging-')
        continue
      }

      expect(href.startsWith(configuredPathWithBase('/'))).toBe(true)
      expect(existsSync(builtOutputForHref(href)), href).toBe(true)
    }
  })

  it('publishes canonical metadata and Decider product structured data', () => {
    const canonical = configuredCanonical('/decider/')
    const structuredData = JSON.parse(page.querySelector('script[type="application/ld+json"]')?.textContent ?? '{}')
    const nodes = structuredData['@graph'] as Array<Record<string, unknown>>
    const product = nodes.find((node) => node['@type'] === 'SoftwareApplication')

    expect(page.querySelector('title')?.text).toBe(DECIDER_LANDING_TITLE)
    expect(page.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(DECIDER_LANDING_DESCRIPTION)
    expect(page.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(canonical)
    expect(page.querySelector('link[rel="alternate"][type="text/markdown"]')?.getAttribute('href')).toBe(
      configuredPathWithBase('/decider/index.md')
    )
    expect(page.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(canonical)
    expect(page.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(DECIDER_LANDING_TITLE)
    expect(page.querySelector('meta[property="og:description"]')?.getAttribute('content')).toBe(
      DECIDER_LANDING_DESCRIPTION
    )
    expect(page.querySelector('meta[name="twitter:card"]')?.getAttribute('content')).toBe('summary_large_image')
    expect(nodes.map((node) => node['@type'])).toEqual(['Organization', 'WebSite', 'SoftwareApplication'])
    expect(product).toMatchObject({
      name: 'Strands Decider',
      url: canonical,
      applicationCategory: 'DeveloperApplication',
      license: 'https://www.apache.org/licenses/LICENSE-2.0',
      isBasedOn: {
        codeRepository: DECIDER_REPOSITORY_URL,
        programmingLanguage: ['Python'],
      },
    })
  })

  it('publishes the configured product story as Markdown', async () => {
    const markdown = readFileSync(new URL('../dist/decider/index.md', import.meta.url), 'utf8')
    const content = await getProductContent('decider')

    expect(markdown).toBe(buildDeciderLandingMarkdown(1, content))
    expect(markdown).not.toContain('staging-')
    expect(markdown).toContain('--noul "Does this convey urgency?"')
    expect(markdown).toContain('--score "How frustrated is the writer?=calm,frustrated,depressed"')
    expect(markdown).toContain('- Score: `1.03` (confidence `0.509`)')
  })

  it('renders content filtered to Decider', async () => {
    const content = await getProductContent('decider')
    const section = page.querySelector('[data-product-content="decider"]')
    const links = section?.querySelectorAll('[data-product-content-link]') ?? []

    expect(section).not.toBeNull()
    expect(section?.querySelector('h2')?.text.trim()).toBe('Decider content')
    expect(section?.querySelector('h2')?.getAttribute('class')).toContain('product-content__visually-hidden')
    expect(section?.querySelector('[data-product-content-label]')?.text.trim()).toBe('Watch and read')
    expect(links).toHaveLength(content.length)
    expect(section?.querySelectorAll('[data-product-content-placeholder]')).toHaveLength(
      content.filter((item) => item.kind === 'article' && !item.image).length
    )

    for (const item of content) {
      const link = section?.querySelector(`[data-product-content-link="${item.id}"]`)
      const href = item.external ? item.href : configuredPathWithBase(item.href)

      expect(link?.getAttribute('href')).toBe(href)
      expect(link?.text).toContain(item.title)
      expect(link?.closest('[data-content-kind]')?.getAttribute('data-content-kind')).toBe(item.kind)
      expect(link?.getAttribute('target')).toBe(item.external ? '_blank' : undefined)
      expect(link?.getAttribute('rel')).toBe(item.external ? 'noopener' : undefined)
    }
  })
})

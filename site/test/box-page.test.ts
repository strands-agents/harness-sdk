import { existsSync, readFileSync } from 'node:fs'

import { parse } from 'node-html-parser'
import { describe, expect, it } from 'vitest'

import {
  BOX_AGENT_EXAMPLES,
  BOX_BOUNDARY_PANELS,
  BOX_CAPABILITIES,
  BOX_EXAMPLE_BOUNDARY,
  BOX_HERO_DESCRIPTION,
  BOX_HERO_TITLE,
  BOX_INSTALL_COMMAND,
  BOX_LANDING_DESCRIPTION,
  BOX_LANDING_TITLE,
  BOX_LINKS,
  BOX_RELEASE_STATUS,
  BOX_REPOSITORY_URL,
  buildBoxLandingMarkdown,
} from '../src/config/box-landing'
import { getProductContent } from '../src/config/product-content'

function configuredPathWithBase(value: string): string {
  const base = (process.env.ASTRO_BASE_PATH ?? '/').replace(/\/$/, '')
  const normalizedValue = value.startsWith('/') ? value : `/${value}`
  return `${base}${normalizedValue}`
}

function configuredHref(value: string): string {
  return value.startsWith('http') ? value : configuredPathWithBase(value)
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

describe('Box landing page', () => {
  const html = readFileSync(new URL('../dist/box/index.html', import.meta.url), 'utf8')
  const page = parse(html)

  it('renders one standalone product story', () => {
    const main = page.querySelector('main')
    const headings = main?.querySelectorAll('h1, h2, h3, h4, h5, h6') ?? []

    expect(main?.getAttribute('data-pagefind-body')).not.toBeNull()
    expect(headings[0]?.tagName).toBe('H1')
    expect(main?.querySelectorAll('h1')).toHaveLength(1)
    expect(main?.querySelector('h1')?.text.replace(/\s+/g, ' ').trim()).toBe(BOX_HERO_TITLE)
    expect(main?.querySelector('.box-hero__subtitle')?.text.replace(/\s+/g, ' ').trim()).toBe(BOX_HERO_DESCRIPTION)
    expect(main?.querySelector('#box-start-title')).toBeNull()
    expect(main?.querySelector('#box-start-product')?.tagName).toBe('H2')
    expect(main?.querySelector('#box-start-product')?.text.trim()).toBe('/box')
    expect(main?.querySelector('.box-hero__install-title')).toBeNull()
    expect(page.querySelector('.sidebar')).toBeNull()
    expect(page.querySelector('starlight-menu-button')).toBeNull()
  })

  it('makes the install command the primary hero action', () => {
    const actions = page.querySelector('.box-hero__actions')
    const markup = actions?.innerHTML ?? ''
    const commandIndex = markup.indexOf('data-command-pill')
    const linksIndex = markup.indexOf('box-hero__links')

    expect(commandIndex).toBeGreaterThanOrEqual(0)
    expect(linksIndex).toBeGreaterThan(commandIndex)
    expect(actions?.querySelector('[data-command-pill]')?.getAttribute('data-command')).toBe(BOX_INSTALL_COMMAND)
    expect(actions?.querySelector('[data-command-copy]')?.getAttribute('aria-label')).toBe(
      'Copy the Box install command'
    )
    expect(actions?.querySelector('.box-hero__link--primary')).toBeNull()
    expect(actions?.querySelector('.box-hero__meta')?.text).not.toContain(BOX_RELEASE_STATUS)
  })

  it('wires the agent selector and capability examples accessibly', () => {
    const tabs = page.querySelectorAll('[data-box-agent-tab]')
    const panels = page.querySelectorAll('[data-box-agent-panel]')

    expect(tabs).toHaveLength(BOX_AGENT_EXAMPLES.length)
    expect(panels).toHaveLength(BOX_AGENT_EXAMPLES.length)

    for (const [index, example] of BOX_AGENT_EXAMPLES.entries()) {
      const tab = page.querySelector(`[data-box-agent-tab="${example.id}"]`)
      const panel = page.querySelector(`[data-box-agent-panel="${example.id}"]`)

      expect(tab?.getAttribute('id')).toBe(`box-agent-tab-${example.id}`)
      expect(tab?.getAttribute('href')).toBe(configuredHref(example.href))
      expect(tab?.getAttribute('data-box-agent-panel-id')).toBe(`box-agent-panel-${example.id}`)
      expect(panel?.getAttribute('id')).toBe(`box-agent-panel-${example.id}`)
      expect(panel?.getAttribute('aria-labelledby')).toBe(`box-agent-tab-${example.id}`)
      expect(panel?.hasAttribute('hidden')).toBe(index !== 0)
    }

    for (const [index, capability] of BOX_CAPABILITIES.entries()) {
      const panel = BOX_BOUNDARY_PANELS[index]
      if (!panel) throw new Error(`Missing boundary panel for ${capability.id}`)

      const card = page.querySelector(`[data-box-capability="${capability.id}"]`)
      const toggle = card?.querySelector(`[data-box-capability-toggle="${capability.id}"]`)
      const details = card?.querySelector(`[data-box-capability-code="${capability.id}"]`)
      const action = card?.querySelector(`[data-box-capability-action="${capability.id}"]`)

      expect(details?.getAttribute('id')).toBe(`box-capability-${capability.id}-details`)
      expect(toggle?.tagName).toBe('BUTTON')
      expect(toggle?.getAttribute('aria-controls')).toBe(`box-capability-${capability.id}-details`)
      expect(toggle?.getAttribute('aria-expanded')).toBe('false')
      expect(action?.getAttribute('href')).toBe(configuredHref(panel.href))
    }

    expect(page.querySelectorAll('[data-box-boundary-decision]')).toHaveLength(BOX_EXAMPLE_BOUNDARY.length)
  })

  it('uses public, valid destinations for every rendered link', () => {
    const configuredExternalLinks = [
      BOX_REPOSITORY_URL,
      ...Object.values(BOX_LINKS),
      ...BOX_AGENT_EXAMPLES.map((example) => example.href),
    ].filter((href) => href.startsWith('http'))

    expect(BOX_INSTALL_COMMAND).toBe(
      'curl -fsSL https://raw.githubusercontent.com/strands-agents/box/main/install.sh | sh'
    )
    expect(BOX_INSTALL_COMMAND).not.toContain('BOX_VERSION')

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

  it('publishes canonical metadata and Box product structured data', () => {
    const canonical = configuredCanonical('/box/')
    const structuredData = JSON.parse(page.querySelector('script[type="application/ld+json"]')?.textContent ?? '{}')
    const nodes = structuredData['@graph'] as Array<Record<string, unknown>>
    const product = nodes.find((node) => node['@type'] === 'SoftwareApplication')

    expect(page.querySelector('title')?.text).toBe(BOX_LANDING_TITLE)
    expect(page.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(BOX_LANDING_DESCRIPTION)
    expect(page.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(canonical)
    expect(page.querySelector('link[rel="alternate"][type="text/markdown"]')?.getAttribute('href')).toBe(
      configuredPathWithBase('/box/index.md')
    )
    expect(page.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(canonical)
    expect(page.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(BOX_LANDING_TITLE)
    expect(page.querySelector('meta[property="og:description"]')?.getAttribute('content')).toBe(BOX_LANDING_DESCRIPTION)
    expect(page.querySelector('meta[name="twitter:card"]')?.getAttribute('content')).toBe('summary_large_image')
    expect(nodes.map((node) => node['@type'])).toEqual(['Organization', 'WebSite', 'SoftwareApplication'])
    expect(product).toMatchObject({
      name: 'Strands Box',
      url: canonical,
      applicationCategory: 'DeveloperApplication',
      license: 'https://www.apache.org/licenses/LICENSE-2.0',
      isBasedOn: {
        codeRepository: BOX_REPOSITORY_URL,
        programmingLanguage: ['Rust'],
      },
    })
  })

  it('publishes the configured product story as Markdown', async () => {
    const markdown = readFileSync(new URL('../dist/box/index.md', import.meta.url), 'utf8')
    const content = await getProductContent('box')

    expect(markdown).toBe(buildBoxLandingMarkdown(1, content))
    expect(markdown).not.toContain('staging-')
  })

  it('renders content filtered to Box', async () => {
    const content = await getProductContent('box')
    const section = page.querySelector('[data-product-content="box"]')
    const links = section?.querySelectorAll('[data-product-content-link]') ?? []

    expect(section).not.toBeNull()
    expect(section?.querySelector('h2')?.text.trim()).toBe('Box content')
    expect(section?.querySelector('h2')?.getAttribute('class')).toContain('product-content__visually-hidden')
    expect(section?.querySelector('[data-product-content-label]')?.text.trim()).toBe('Watch and read')
    expect(links).toHaveLength(content.length)
    expect(section?.querySelectorAll('[data-product-content-placeholder]')).toHaveLength(
      content.filter((item) => item.kind === 'article' && !item.image).length
    )

    for (const item of content) {
      const link = section?.querySelector(`[data-product-content-link="${item.id}"]`)

      expect(link?.getAttribute('href')).toBe(configuredHref(item.href))
      expect(link?.text).toContain(item.title)
      expect(link?.closest('[data-content-kind]')?.getAttribute('data-content-kind')).toBe(item.kind)
      expect(link?.getAttribute('target')).toBe(item.external ? '_blank' : undefined)
      expect(link?.getAttribute('rel')).toBe(item.external ? 'noopener' : undefined)
    }
  })
})

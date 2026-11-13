import { readFileSync } from 'node:fs'

import { parse } from 'node-html-parser'
import { describe, expect, it } from 'vitest'

import {
  BOX_CONFIG_SNIPPET,
  BOX_DOWNLOAD_COMMAND,
  BOX_EXAMPLES,
  BOX_PAGE_DESCRIPTION,
  BOX_PAGE_TITLE,
  BOX_POLICY_SNIPPET,
} from '../src/config/box-landing'

function configuredPathWithBase(value: string): string {
  const base = (process.env.ASTRO_BASE_PATH ?? '/').replace(/\/$/, '')
  const normalizedValue = value.startsWith('/') ? value : `/${value}`
  return `${base}${normalizedValue}`
}

describe('Box product landing page', () => {
  const html = readFileSync(new URL('../dist/box/index.html', import.meta.url), 'utf8')
  const page = parse(html)

  it('renders a focused product overview in the shared marketing shell', () => {
    const main = page.querySelector('main[data-pagefind-body]')
    const h1 = main?.querySelector('h1')

    expect(page.querySelector('.strands-nav')).not.toBeNull()
    expect(page.querySelector('.strands-nav--purple')).not.toBeNull()
    expect(page.querySelector('body.project-landing--purple')).not.toBeNull()
    expect(page.querySelector('.announcement--purple')).not.toBeNull()
    expect(page.querySelector('.footer--purple')).not.toBeNull()
    expect(page.querySelector('.footer__transition--purple')).not.toBeNull()
    expect(page.querySelector('.footer__shape--desktop')).not.toBeNull()
    expect(page.querySelector('.footer__shape--mobile')).not.toBeNull()
    expect(page.querySelector('.sidebar')).toBeNull()
    expect(main?.querySelectorAll('section')).toHaveLength(3)
    expect(main?.querySelectorAll('h1')).toHaveLength(1)
    expect(h1?.text.trim()).toBe('/box')
    expect(
      main
        ?.querySelector('.box-hero__tagline')
        ?.querySelectorAll('span')
        .map((line) => line.text.trim())
    ).toEqual(['Run agents.', 'Set the boundary.'])
    expect(main?.text.trim().length).toBeGreaterThan(600)
  })

  it('links the hero to the Box quickstart and repository', () => {
    const hero = page.querySelector('.box-hero')
    const hrefs = hero?.querySelectorAll('a').map((link) => link.getAttribute('href')) ?? []

    expect(hrefs).toContain(configuredPathWithBase('/docs/user-guide/box/quickstart/'))
    expect(hrefs).toContain('https://github.com/strands-agents/box')
    expect(hero?.querySelector('[data-copy-command]')?.getAttribute('data-copy-command')).toBe(BOX_DOWNLOAD_COMMAND)
    expect(hero?.querySelector('[data-copy-command-button]')?.getAttribute('aria-label')).toBe(
      'Copy the Box download command'
    )
    expect(hero?.querySelector('.box-hero__actions + .box-hero__command')).not.toBeNull()
    expect(hero?.text).toContain('Apple silicon macOS · ARM64 Linux')
  })

  it('presents both boundary files and runnable examples for three agents', () => {
    const boundaryLayers = page.querySelectorAll('.box-how__layer')

    expect(boundaryLayers).toHaveLength(2)
    expect(page.querySelectorAll('.box-how__example')).toHaveLength(2)
    expect(page.querySelector('.box-how')?.text).toContain('box.toml')
    expect(page.querySelector('.box-how')?.text).toContain('policy.dw')
    expect(boundaryLayers[0]?.querySelector('pre')?.getAttribute('data-language')).toBe('toml')
    expect(boundaryLayers[1]?.querySelector('pre')?.getAttribute('data-language')).toBe('text')
    expect(page.querySelectorAll('.box-running__steps article')).toHaveLength(3)
    expect(page.querySelector('.box-running [data-copy-command]')).toBeNull()

    const examples = page.querySelectorAll('[data-box-example]')
    const buttons = page.querySelectorAll('[data-box-example-button]')
    const panels = page.querySelectorAll('[data-box-example-panel]')

    expect(examples).toHaveLength(BOX_EXAMPLES.length)
    expect(buttons.map((button) => button.querySelector('.box-examples__name')?.text.trim())).toEqual(
      BOX_EXAMPLES.map((example) => example.label)
    )
    expect(panels).toHaveLength(BOX_EXAMPLES.length)
    expect(panels[0]?.hasAttribute('hidden')).toBe(false)
    expect(panels.slice(1).every((panel) => panel.hasAttribute('hidden'))).toBe(true)
    expect(panels.every((panel) => panel.querySelector('pre')?.getAttribute('data-language') === 'bash')).toBe(true)
    expect(
      panels
        .map((panel) => panel.getAttribute('data-box-example-command'))
        .every((command, index) => {
          return command === BOX_EXAMPLES[index]?.command
        })
    ).toBe(true)
  })

  it('announces copy-command feedback to assistive technology', () => {
    const status = page.querySelector('.box-hero [data-copy-command-status]')

    expect(status?.getAttribute('aria-live')).toBe('polite')
    expect(status?.getAttribute('aria-atomic')).toBe('true')
  })

  it('publishes complete standalone metadata and a Markdown alternate', () => {
    const site = (process.env.SITE_DOMAIN || 'https://strandsagents.com').replace(/\/$/, '')

    expect(page.querySelector('title')?.text).toBe(BOX_PAGE_TITLE)
    expect(page.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(BOX_PAGE_DESCRIPTION)
    expect(page.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
      `${site}${configuredPathWithBase('/box/')}`
    )
    expect(page.querySelector('link[rel="alternate"][type="text/markdown"]')?.getAttribute('href')).toBe(
      configuredPathWithBase('/box/index.md')
    )
    expect(page.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(BOX_PAGE_TITLE)
    expect(page.querySelector('meta[name="twitter:card"]')?.getAttribute('content')).toBe('summary_large_image')
  })

  it('publishes the same overview as Markdown', () => {
    const markdown = readFileSync(new URL('../dist/box/index.md', import.meta.url), 'utf8')

    expect(markdown).toContain('# Strands Box')
    expect(markdown).toContain('## Two files define the boundary')
    expect(markdown).toContain('## Box the agent you already use')
    expect(markdown).toContain(BOX_DOWNLOAD_COMMAND)
    expect(markdown).toContain(`\`\`\`toml\n${BOX_CONFIG_SNIPPET}\n\`\`\``)
    expect(markdown).toContain(`\`\`\`text\n${BOX_POLICY_SNIPPET}\n\`\`\``)
    expect(markdown).toContain(configuredPathWithBase('/docs/user-guide/box/quickstart/'))
  })
})

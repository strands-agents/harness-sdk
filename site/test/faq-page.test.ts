import { readFileSync } from 'node:fs'

import { parse } from 'node-html-parser'
import { describe, expect, it } from 'vitest'

import { faqItems, featuredFaqItems } from '../src/config/faq'

function configuredPathWithBase(value: string): string {
  const base = (process.env.ASTRO_BASE_PATH ?? '/').replace(/\/$/, '')
  const normalizedValue = value.startsWith('/') ? value : `/${value}`
  return `${base}${normalizedValue}`
}

describe('standalone FAQ page', () => {
  const html = readFileSync(new URL('../dist/faq/index.html', import.meta.url), 'utf8')
  const page = parse(html)

  it('renders every curated question outside the docs sidebar', () => {
    expect(page.querySelectorAll('.faq-item')).toHaveLength(faqItems.length)
    expect(page.querySelectorAll('.faq-group')).toHaveLength(3)
    expect(page.querySelector('.sidebar')).toBeNull()
  })

  it('uses base-aware links to the supporting guides', () => {
    const hrefs = page.querySelectorAll('.faq-item__answer a').map((link) => link.getAttribute('href'))

    expect(hrefs).toContain(configuredPathWithBase('/docs/user-guide/harness/'))
    expect(hrefs).toContain(configuredPathWithBase('/docs/user-guide/sdk/safety-security/'))
    expect(hrefs.every((href) => href?.startsWith(configuredPathWithBase('/docs/')))).toBe(true)
  })

  it('publishes the same FAQ as Markdown', () => {
    const markdown = readFileSync(new URL('../dist/faq/index.md', import.meta.url), 'utf8')

    for (const item of faqItems) expect(markdown).toContain(`### ${item.question}`)
    expect(markdown).toContain(configuredPathWithBase('/docs/user-guide/sdk/model-providers/index.md'))
  })
})

describe('homepage FAQ selection', () => {
  it('keeps the preview focused on five questions', () => {
    expect(featuredFaqItems).toHaveLength(5)
  })
})

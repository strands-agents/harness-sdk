import { readFileSync } from 'node:fs'

import { parse } from 'node-html-parser'
import { describe, expect, it } from 'vitest'

import { faqCategories, faqItems, featuredFaqItems } from '../src/config/faq'

function configuredPathWithBase(value: string): string {
  const base = (process.env.ASTRO_BASE_PATH ?? '/').replace(/\/$/, '')
  const normalizedValue = value.startsWith('/') ? value : `/${value}`
  return `${base}${normalizedValue}`
}

describe('standalone FAQ page', () => {
  const html = readFileSync(new URL('../dist/faq/index.html', import.meta.url), 'utf8')
  const page = parse(html)

  it('renders every curated question outside the docs sidebar', () => {
    expect(
      faqCategories.map((category) => [
        category.id,
        faqItems.filter((item) => item.category === category.id).map((item) => item.id),
      ])
    ).toEqual([
      [
        'choose',
        [
          'harness-or-sdk',
          'keep-current-model',
          'python-or-typescript',
          'bidirectional-or-standard-streaming',
          'strands-labs-projects',
          'simulated-or-physical-robots',
          'strands-for-cosmos',
          'benchmark-harnesses-or-evals',
          'ai-functions-or-regular-code',
        ],
      ],
      [
        'build',
        [
          'custom-or-mcp-tool',
          'multi-agent-pattern',
          'sessions-memory-context',
          'automatic-or-agentic-context',
          'structured-output-validation',
          'hooks-plugins-middleware-interventions',
          'agent-configuration',
          'harness-optimizer',
          'voice-agent-speaker-echo',
        ],
      ],
      [
        'run',
        [
          'approval-for-risky-tools',
          'retries-or-invocation-limits',
          'evaluate-before-production',
          'deploy-strands-agent',
          'strands-shell-isolation',
          'production-observability',
          'production-security',
        ],
      ],
    ])
    expect(page.querySelectorAll('.faq-item')).toHaveLength(faqItems.length)
    expect(page.querySelectorAll('.faq-group')).toHaveLength(3)
    expect(page.querySelectorAll('details.faq-item')).toHaveLength(0)
    expect(page.querySelector('.sidebar')).toBeNull()
  })

  it('provides visible targets for every table-of-contents link', () => {
    for (const category of faqCategories) {
      expect(page.querySelector(`#${category.id}`)).not.toBeNull()
    }
    for (const item of faqItems) {
      expect(page.querySelector(`#${item.id}`)).not.toBeNull()
    }
  })

  it('uses base-aware links to the supporting guides', () => {
    const hrefs = page.querySelectorAll('.faq-item__answer a').map((link) => link.getAttribute('href'))

    expect(hrefs).toContain(configuredPathWithBase('/docs/user-guide/harness/'))
    expect(hrefs).toContain(configuredPathWithBase('/docs/user-guide/sdk/safety-security/'))
    expect(hrefs).toContain('https://github.com/strands-labs/robots')
    expect(
      hrefs.every(
        (href) =>
          href?.startsWith(configuredPathWithBase('/docs/')) || href?.startsWith('https://github.com/strands-labs')
      )
    ).toBe(true)
  })

  it('publishes the same FAQ as Markdown', () => {
    const markdown = readFileSync(new URL('../dist/faq/index.md', import.meta.url), 'utf8')

    for (const item of faqItems) expect(markdown).toContain(`### ${item.question}`)
    expect(markdown).toContain(configuredPathWithBase('/docs/user-guide/sdk/model-providers/index.md'))
    expect(markdown).toContain('https://github.com/strands-labs/robots')
  })
})

describe('homepage FAQ selection', () => {
  it('keeps the preview focused on five questions', () => {
    expect(featuredFaqItems.map((item) => item.id)).toEqual([
      'harness-or-sdk',
      'python-or-typescript',
      'custom-or-mcp-tool',
      'evaluate-before-production',
      'deploy-strands-agent',
    ])
  })
})

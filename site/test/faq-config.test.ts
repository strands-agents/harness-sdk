import { describe, expect, it } from 'vitest'

import { faqMarkdownHref } from '../src/config/faq'

describe('faqMarkdownHref', () => {
  it('rewrites a trailing-slash page URL to its Markdown endpoint', () => {
    expect(faqMarkdownHref('/docs/user-guide/sdk/tools/')).toBe('/docs/user-guide/sdk/tools/index.md')
  })

  it('keeps fragments after the Markdown filename', () => {
    expect(faqMarkdownHref('/docs/user-guide/sdk/agents/structured-output-behavior/#limit-attempts')).toBe(
      '/docs/user-guide/sdk/agents/structured-output-behavior/index.md#limit-attempts'
    )
  })

  it('keeps external URLs unchanged', () => {
    expect(faqMarkdownHref('https://github.com/strands-labs/robots')).toBe('https://github.com/strands-labs/robots')
  })
})

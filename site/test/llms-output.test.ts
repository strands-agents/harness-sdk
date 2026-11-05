import { readFileSync } from 'node:fs'

import { getCollection } from 'astro:content'
import { describe, expect, it } from 'vitest'

const llms = readFileSync(new URL('../dist/llms.txt', import.meta.url), 'utf8')

describe('llms.txt output', () => {
  it('omits sidebar sections whose pages are all excluded from publication', () => {
    expect(llms).not.toMatch(/^## Box$/m)
    expect(llms).not.toContain('/docs/user-guide/box/')
  })

  it('lists every published integration guide once, with its description', async () => {
    const integrations = await getCollection(
      'docs',
      ({ id, data }) => id.startsWith('docs/integrations/') && !data.draft && data.externalDocs?.status !== 'preview'
    )
    const section = llms.split(/^## /m).find((s) => s.startsWith('Integrations\n')) ?? ''

    expect(integrations.length).toBeGreaterThan(0)
    for (const doc of integrations) {
      const url = `/${doc.id}/index.md)`
      expect(section.split(url).length - 1, doc.id).toBe(1)
      const entry = section.split('\n').find((line) => line.includes(url))
      expect(entry, doc.id).toContain(`[${doc.data.title}]`)
      expect(entry, doc.id).toContain(': ')
    }
    expect(llms.match(/\/docs\/integrations\/[^)]*\/index\.md\)/g)).toHaveLength(integrations.length)
  })
})

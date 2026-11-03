import { readFileSync } from 'node:fs'

import { getCollection } from 'astro:content'
import { describe, expect, it } from 'vitest'

describe('llms.txt output', () => {
  it('publishes every live documentation page in llms.txt automatically', async () => {
    const llms = readFileSync(new URL('../dist/llms.txt', import.meta.url), 'utf8')
    const docs = await getCollection(
      'docs',
      ({ id, data }) => id !== '404' && !data.draft && data.externalDocs?.status !== 'preview'
    )
    const missing = docs.filter((doc) => !llms.includes(`/${doc.id}/index.md`)).map((doc) => doc.id)

    expect(missing).toEqual([])
  })

  it('publishes every Box page on indexed documentation surfaces', () => {
    const llms = readFileSync(new URL('../dist/llms.txt', import.meta.url), 'utf8')
    const llmsFull = readFileSync(new URL('../dist/llms-full.txt', import.meta.url), 'utf8')
    const sitemap = readFileSync(new URL('../dist/sitemap-0.xml', import.meta.url), 'utf8')
    const navigation = JSON.parse(
      readFileSync(new URL('../.build/external-docs/strands-box/navigation.json', import.meta.url), 'utf8')
    ) as {
      groups: Array<{ items: Array<{ label: string; slug: string }> }>
    }

    expect(llms).toMatch(/^## Box$/m)
    for (const item of navigation.groups.flatMap((group) => group.items)) {
      const markdownPath = `/${item.slug}/index.md`
      const html = readFileSync(new URL(`../dist/${item.slug}/index.html`, import.meta.url), 'utf8')

      expect(html, item.slug).not.toContain('noindex, nofollow')
      expect(html, item.slug).toContain('data-pagefind-body')
      expect(sitemap, item.slug).toMatch(new RegExp(`<loc>[^<]*/${item.slug}/</loc>`))
      expect(llms, item.slug).toContain(`[${item.label}](`)
      expect(llms, item.slug).toContain(markdownPath)
      expect(llmsFull, item.slug).toContain(`## ${item.label}`)
      expect(llmsFull, item.slug).toContain(markdownPath)
    }
  })
})

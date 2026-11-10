import { existsSync, readFileSync } from 'node:fs'

import { getCollection } from 'astro:content'
import { describe, expect, it } from 'vitest'
import { parseExternalDocsConfig } from '../scripts/external-docs/schema'
import { buildLlmsTxt } from '../src/pages/llms.txt'
import type { CollectionEntry } from 'astro:content'
import type { GeneratedExternalDocsNavigation } from '../src/external-docs-navigation'
import type { StarlightSidebarItem } from '../src/sidebar'

function doc(id: string, title: string, status?: 'preview' | 'stable'): CollectionEntry<'docs'> {
  return {
    id,
    collection: 'docs',
    data: {
      title,
      description: `${title} description`,
      draft: false,
      ...(status && {
        externalDocs: {
          product: 'Fixture',
          productId: 'fixture',
          status,
          repository: 'https://github.com/example/fixture',
          ref: 'main',
          revision: '1234567890abcdef1234567890abcdef12345678',
          source: `docs/user/${id.split('/').pop()}.md`,
        },
      }),
    },
  } as unknown as CollectionEntry<'docs'>
}

function occurrences(content: string, value: string): number {
  return content.split(value).length - 1
}

describe('llms.txt builder', () => {
  it('excludes preview docs from sidebar and fallback sections', () => {
    const sidebarDoc = doc('docs/preview/sidebar', 'Sidebar preview', 'preview')
    const unlistedDoc = doc('docs/preview/unlisted', 'Unlisted preview', 'preview')
    const sidebar: StarlightSidebarItem[] = [
      {
        label: 'Preview product',
        items: [{ label: 'Sidebar preview', slug: sidebarDoc.id }],
      },
    ]

    const content = buildLlmsTxt([sidebarDoc, unlistedDoc], sidebar, [], [], [])

    expect(content).not.toContain(`/${sidebarDoc.id}/index.md`)
    expect(content).not.toContain(`/${unlistedDoc.id}/index.md`)
    expect(content).not.toContain('## Preview product')
    expect(content).not.toContain('## Additional documentation')
  })

  it('appends an unlisted live doc exactly once', () => {
    const unlistedDoc = doc('docs/live/unlisted', 'Unlisted')
    const path = `/${unlistedDoc.id}/index.md`
    const content = buildLlmsTxt([unlistedDoc], [], [], [], [])

    expect(content).toContain('## Additional documentation')
    expect(occurrences(content, path)).toBe(1)
  })

  it('does not duplicate sidebar or API docs in the fallback section', () => {
    const sidebarDoc = doc('docs/live/sidebar', 'Sidebar')
    const apiDoc = doc('docs/api/python/example', 'API')
    const sidebar: StarlightSidebarItem[] = [
      {
        label: 'Product',
        items: [{ label: 'Sidebar', slug: sidebarDoc.id }],
      },
    ]

    const content = buildLlmsTxt([sidebarDoc, apiDoc], sidebar, [], [], [])

    expect(occurrences(content, `/${sidebarDoc.id}/index.md`)).toBe(1)
    expect(occurrences(content, `/${apiDoc.id}/index.md`)).toBe(1)
    expect(content).not.toContain('## Additional documentation')
  })
})

describe('llms.txt output', () => {
  it('publishes every live documentation page in llms.txt automatically', async () => {
    const llms = readFileSync(new URL('../dist/llms.txt', import.meta.url), 'utf8')
    const docs = await getCollection('docs', ({ id, data }) => id !== '404' && !data.draft)
    const missing = docs
      .filter((entry) => existsSync(new URL(`../dist/${entry.id}/index.md`, import.meta.url)))
      .filter((entry) => !llms.includes(`/${entry.id}/index.md`))
      .map((entry) => entry.id)

    expect(missing).toEqual([])
  })

  it('matches each external product publication status on indexed surfaces', () => {
    const config = parseExternalDocsConfig(
      JSON.parse(readFileSync(new URL('../external-docs.config.json', import.meta.url), 'utf8'))
    )
    const llms = readFileSync(new URL('../dist/llms.txt', import.meta.url), 'utf8')
    const llmsFull = readFileSync(new URL('../dist/llms-full.txt', import.meta.url), 'utf8')
    const sitemap = readFileSync(new URL('../dist/sitemap-0.xml', import.meta.url), 'utf8')

    for (const product of config.products) {
      const navigation = JSON.parse(
        readFileSync(new URL(`../.build/external-docs/${product.id}/navigation.json`, import.meta.url), 'utf8')
      ) as GeneratedExternalDocsNavigation
      const published = product.publicationStatus === 'stable'

      expect(navigation.product.status, product.id).toBe(product.publicationStatus)
      for (const item of navigation.groups.flatMap((group) => group.items)) {
        const markdownPath = `/${item.slug}/index.md`
        const html = readFileSync(new URL(`../dist/${item.slug}/index.html`, import.meta.url), 'utf8')

        expect(html.includes('noindex, nofollow'), item.slug).toBe(!published)
        expect(html.includes('data-pagefind-body'), item.slug).toBe(published)
        expect(new RegExp(`<loc>[^<]*/${item.slug}/</loc>`).test(sitemap), item.slug).toBe(published)
        expect(llms.includes(markdownPath), item.slug).toBe(published)
        expect(llmsFull.includes(markdownPath), item.slug).toBe(published)
        expect(existsSync(new URL(`../dist/${item.slug}/index.md`, import.meta.url)), item.slug).toBe(published)
      }
    }
  })
})

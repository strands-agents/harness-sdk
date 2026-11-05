import { readFileSync } from 'node:fs'

import { siteLink } from '@util/links'
import { isPublishedDoc } from '@util/published-docs'
import { getCollection } from 'astro:content'
import { describe, expect, it } from 'vitest'

const llms = readFileSync(new URL('../dist/llms.txt', import.meta.url), 'utf8')

describe('llms.txt output', () => {
  it('omits sidebar sections whose pages are all excluded from publication', () => {
    expect(llms).not.toMatch(/^## Box$/m)
    expect(llms).not.toContain('/docs/user-guide/box/')
  })

  it('lists every published integration guide once, grouped by category, with its description', async () => {
    const integrations = await getCollection(
      'docs',
      (doc) => doc.id.startsWith('docs/integrations/') && isPublishedDoc(doc)
    )
    const entry = (doc: (typeof integrations)[number], indent: string) =>
      `${indent}- [${doc.data.title}](${siteLink(`/${doc.id}/index.md`)}): ${doc.data.description!.replace(/\s+/g, ' ').trim()}`
    const segments = (doc: (typeof integrations)[number]) => doc.id.slice('docs/integrations/'.length).split('/')
    const sorted = [...integrations].sort((a, b) => a.id.localeCompare(b.id))
    const rootPages = sorted.filter((doc) => segments(doc).length === 1)
    const labels: Record<string, string> = {
      'agent-extensions': 'Agent Extensions',
      integrations: 'Integrations',
      interventions: 'Interventions',
      'memory-stores': 'Memory Stores',
      'model-providers': 'Model Providers',
      plugins: 'Plugins',
      'session-managers': 'Session Managers',
      storage: 'Storage',
      tools: 'Tools',
    }

    const expected = [
      ...rootPages.map((doc) => entry(doc, '')),
      ...Object.entries(labels).flatMap(([directory, label]) => [
        `- ${label}`,
        ...sorted
          .filter((doc) => segments(doc).length > 1 && segments(doc)[0] === directory)
          .map((doc) => entry(doc, '  ')),
      ]),
    ]
    const section = llms.split(/^## /m).find((s) => s.startsWith('Integrations\n')) ?? ''
    const lines = section.trim().split('\n').slice(1).filter(Boolean)

    expect(integrations.length).toBeGreaterThan(0)
    expect(lines).toEqual(expected)
  })
})

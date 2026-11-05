import { readdirSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { getCollection } from 'astro:content'
import {
  buildCatalogFeed,
  buildCatalogFeedJsonSchema,
  catalogFeedEntrySchema,
  catalogFeedSchema,
} from '../src/util/catalog-feed'
import type { CatalogEntryData } from '../src/content.config'

const ORIGIN = 'https://strandsagents.com'

function entry(overrides: Partial<CatalogEntryData> = {}): CatalogEntryData {
  return {
    name: 'strands-example',
    description: 'Example integration',
    integrationType: 'tool',
    sdk: 'agents',
    maintainedBy: 'community',
    languages: { python: { package: 'strands-example' } },
    github: 'https://github.com/example/strands-example',
    featured: true,
    badges: ['verified'],
    addedDate: new Date('2026-01-01'),
    ...overrides,
  }
}

describe('buildCatalogFeed', () => {
  it('publishes public fields only, with derived registry URLs', () => {
    const feed = buildCatalogFeed([{ id: 'strands-example', data: entry() }], ORIGIN)

    expect(feed.integrations).toEqual([
      {
        id: 'strands-example',
        name: 'strands-example',
        description: 'Example integration',
        integrationType: 'tool',
        sdk: 'agents',
        languages: {
          python: { package: 'strands-example', registryUrl: 'https://pypi.org/project/strands-example/' },
        },
        github: 'https://github.com/example/strands-example',
        maintainedBy: 'community',
        addedDate: '2026-01-01',
      },
    ])
  })

  it('prefers the on-site docs page over an external docsUrl', () => {
    const data = entry({ docsPage: 'docs/integrations/tools/strands-example', docsUrl: 'https://example.com/docs' })
    const [item] = buildCatalogFeed([{ id: 'strands-example', data }], ORIGIN).integrations

    expect(item!.docsUrl).toBe(`${ORIGIN}/docs/integrations/tools/strands-example/`)
  })

  it('keeps guide-only languages without a package', () => {
    const data = entry({ languages: { python: {}, typescript: { package: '@example/strands' } } })
    const [item] = buildCatalogFeed([{ id: 'strands-example', data }], ORIGIN).integrations

    expect(item!.languages).toEqual({
      python: {},
      typescript: { package: '@example/strands', registryUrl: 'https://www.npmjs.com/package/@example/strands' },
    })
  })
})

describe('integrations feed from the catalog collection', () => {
  it('includes every catalog entry and validates against the published schema', async () => {
    const yamlCount = readdirSync(new URL('../src/content/catalog/', import.meta.url)).filter((f) =>
      f.endsWith('.yaml')
    ).length
    const feed = buildCatalogFeed(await getCollection('catalog'), ORIGIN)

    expect(feed.integrations).toHaveLength(yamlCount)
    expect(catalogFeedSchema.safeParse(feed).success).toBe(true)
    const publishedKeys = Object.keys(catalogFeedEntrySchema.shape)
    expect(feed.integrations.every((e) => Object.keys(e).every((key) => publishedKeys.includes(key)))).toBe(true)
    expect(feed.integrations.find((e) => e.id === 'strands-deepgram')).toMatchObject({
      integrationType: 'tool',
      languages: { python: { package: 'strands-deepgram', registryUrl: 'https://pypi.org/project/strands-deepgram/' } },
      docsUrl: `${ORIGIN}/docs/integrations/tools/strands-deepgram/`,
      maintainedBy: 'community',
    })
  })

  it('pins schemaVersion in the JSON Schema and leaves room for additive fields', () => {
    const schema = buildCatalogFeedJsonSchema(ORIGIN) as Record<string, any>

    expect(schema.properties.schemaVersion.const).toBe(1)
    expect(schema.additionalProperties).toBeUndefined()
    expect(schema.properties.integrations.items.additionalProperties).toBeUndefined()
  })
})

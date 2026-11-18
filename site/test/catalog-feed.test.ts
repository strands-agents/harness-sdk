import { readdirSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { getCollection } from 'astro:content'
import { buildCatalogFeed, buildCatalogFeedJsonSchema, catalogFeedSchema } from '../src/util/catalog-feed'
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

const expectedEntry = {
  id: 'strands-example',
  name: 'strands-example',
  description: 'Example integration',
  integrationType: 'tool',
  sdk: 'agents',
  maintainedBy: 'community',
  languages: {
    python: { package: 'strands-example', registryUrl: 'https://pypi.org/project/strands-example/' },
  },
  github: 'https://github.com/example/strands-example',
  addedDate: '2026-01-01',
}

function feedEntries(data: CatalogEntryData) {
  return buildCatalogFeed([{ id: 'strands-example', data }], ORIGIN).integrations
}

describe('buildCatalogFeed', () => {
  it('publishes public fields only, with derived registry URLs', () => {
    expect(buildCatalogFeed([{ id: 'strands-example', data: entry() }], ORIGIN)).toEqual({
      $schema: `${ORIGIN}/integrations.schema.json`,
      schemaVersion: 1,
      integrations: [expectedEntry],
    })
  })

  it('prefers the on-site docs page over an external docsUrl', () => {
    const data = entry({ docsPage: 'docs/integrations/tools/strands-example', docsUrl: 'https://example.com/docs' })

    expect(feedEntries(data)).toEqual([
      { ...expectedEntry, docsUrl: `${ORIGIN}/docs/integrations/tools/strands-example/` },
    ])
  })

  it('keeps an external docsUrl when there is no on-site docs page', () => {
    const data = entry({ docsUrl: 'https://example.com/docs' })

    expect(feedEntries(data)).toEqual([{ ...expectedEntry, docsUrl: 'https://example.com/docs' }])
  })

  it('keeps guide-only languages and resolves PyPI extras and scoped npm packages', () => {
    const data = entry({
      sdk: 'evals',
      languages: { python: { package: 'temporalio[strands-agents]' }, typescript: { package: '@example/strands' } },
    })

    expect(feedEntries(data)).toEqual([
      {
        ...expectedEntry,
        sdk: 'evals',
        languages: {
          python: { package: 'temporalio[strands-agents]', registryUrl: 'https://pypi.org/project/temporalio/' },
          typescript: { package: '@example/strands', registryUrl: 'https://www.npmjs.com/package/@example/strands' },
        },
      },
    ])
    expect(feedEntries(entry({ languages: { python: {} } }))).toEqual([{ ...expectedEntry, languages: { python: {} } }])
  })
})

describe('integrations feed from the catalog collection', () => {
  it('includes every catalog entry and only fields the schema publishes', async () => {
    const yamlCount = readdirSync(new URL('../src/content/catalog/', import.meta.url)).filter((f) =>
      f.endsWith('.yaml')
    ).length
    const feed = buildCatalogFeed(await getCollection('catalog'), ORIGIN)

    expect(feed.integrations).toHaveLength(yamlCount)
    // Parsing strips undeclared keys, so equality also rules out unpublished fields.
    expect(catalogFeedSchema.parse(feed)).toEqual(feed)
  })

  it('publishes the JSON Schema contract unchanged', async () => {
    const schema = buildCatalogFeedJsonSchema(ORIGIN)

    expect(JSON.stringify(schema)).not.toContain('additionalProperties')
    await expect(JSON.stringify(schema, null, 2) + '\n').toMatchFileSnapshot(
      './snapshots/catalog-feed/integrations.schema.json'
    )
  })
})

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { getCollection } from 'astro:content'
import { catalogEntrySchema } from '../src/content.config'
import { CATALOG_TYPES } from '../src/components/catalog/types'
import stats from '../src/data/catalog-stats.json'

describe('catalog content collection', () => {
  it('loads catalog entries with validated data', async () => {
    const entries = await getCollection('catalog')
    expect(entries.length).toBeGreaterThan(0)

    const deepgram = entries.find((e) => e.id === 'strands-deepgram')
    expect(deepgram).toBeDefined()
    expect(deepgram!.data.name).toBe('strands-deepgram')
    expect(deepgram!.data.integrationType).toBe('tool')
    expect(deepgram!.data.sdk).toBe('agents')
    expect(deepgram!.data.languages.python?.package).toBe('strands-deepgram')
    expect(deepgram!.data.languages.typescript).toBeUndefined()
    expect(deepgram!.data.featured).toBe(false)
    expect(deepgram!.data.badges).toEqual([])
  })

  it('rejects an entry with no language blocks', () => {
    const result = catalogEntrySchema.safeParse({
      name: 'bad-entry',
      description: 'missing languages',
      integrationType: 'tool',
      languages: {},
      github: 'https://github.com/example/bad-entry',
      addedDate: '2026-07-17',
    })
    expect(result.success).toBe(false)
  })

  it('accepts an empty language block for guide-only integrations', () => {
    const result = catalogEntrySchema.safeParse({
      name: 'guide-entry',
      description: 'vendor-guide integration without a package',
      integrationType: 'plugin',
      languages: { python: {} },
      github: 'https://github.com/example/guide-entry',
      docsUrl: 'https://example.com/docs/strands',
      addedDate: '2026-07-21',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a language block that declares a registry URL', () => {
    // Registry links derive from the package name at build time. The block is
    // .strict() so a submitted registry (or any stray key) fails the build
    // loudly instead of being silently ignored.
    const base = {
      name: 'declared-registry',
      description: 'registry links derive from the package name',
      integrationType: 'tool',
      github: 'https://github.com/example/declared-registry',
      addedDate: '2026-07-21',
    }
    expect(
      catalogEntrySchema.safeParse({
        ...base,
        languages: { python: { package: 'x', registry: 'https://pypi.org/project/x/' } },
      }).success
    ).toBe(false)
    expect(
      catalogEntrySchema.safeParse({
        ...base,
        languages: { typescript: { package: 'x', registry: 'https://www.npmjs.com/package/x' } },
      }).success
    ).toBe(false)
  })

  it('accepts every maintainer tier and defaults to community', () => {
    const base = {
      name: 'tiered-entry',
      description: 'maintainer tier probe',
      integrationType: 'model-provider',
      languages: { python: {} },
      github: 'https://github.com/strands-agents/harness-sdk',
      addedDate: '2025-12-01',
    }
    for (const maintainedBy of ['strands', 'aws', 'partner', 'community']) {
      expect(catalogEntrySchema.safeParse({ ...base, maintainedBy }).success, maintainedBy).toBe(true)
    }
    const parsed = catalogEntrySchema.safeParse(base)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.maintainedBy).toBe('community')
    expect(catalogEntrySchema.safeParse({ ...base, maintainedBy: 'official' }).success).toBe(false)
  })

  it('rejects an unknown language key', () => {
    // The languages container is .strict() so a misspelled key
    // (`typeScript:`) fails the build instead of silently dropping the
    // language from the entry's facets.
    const result = catalogEntrySchema.safeParse({
      name: 'typo-language',
      description: 'misspelled language key',
      integrationType: 'tool',
      // python is valid, so only the strict check can reject this entry —
      // the at-least-one-language refinement is already satisfied.
      languages: { python: { package: 'x' }, typeScript: { package: 'x' } },
      github: 'https://github.com/example/x',
      addedDate: '2026-07-21',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an entry that declares a maintainer', () => {
    // The displayed maintainer derives from the github URL's owner segment;
    // a self-declared maintainer field fails the build loudly.
    const result = catalogEntrySchema.safeParse({
      name: 'declared-maintainer',
      description: 'maintainer derives from the github owner',
      integrationType: 'tool',
      languages: { python: { package: 'x' } },
      github: 'https://github.com/example/x',
      maintainer: 'someone-else',
      addedDate: '2026-07-21',
    })
    expect(result.success).toBe(false)
  })

  it('rejects github urls outside the expected host', () => {
    const base = {
      name: 'bad-urls',
      description: 'url smuggling',
      integrationType: 'tool',
      languages: { python: { package: 'x' } },
      github: 'https://github.com/example/x',
      addedDate: '2026-07-17',
    }
    // javascript: scheme in github
    expect(catalogEntrySchema.safeParse({ ...base, github: 'javascript:alert(1)' }).success).toBe(false)
    // https but wrong host
    expect(catalogEntrySchema.safeParse({ ...base, github: 'https://evil.example/x' }).success).toBe(false)
  })

  it('rejects an unknown integrationType', () => {
    const result = catalogEntrySchema.safeParse({
      name: 'bad-type',
      description: 'bad type',
      integrationType: 'widget',
      languages: { python: { package: 'x' } },
      github: 'https://github.com/example/x',
      addedDate: '2026-07-17',
    })
    expect(result.success).toBe(false)
  })

  it('accepts every type in the CATALOG_TYPES registry', () => {
    // The zod enum and CATALOG_TYPES are cross-referenced by comment only;
    // this fails loudly when a type is added to the registry but not the schema.
    for (const { value } of CATALOG_TYPES) {
      const result = catalogEntrySchema.safeParse({
        name: `probe-${value}`,
        description: 'registry/schema sync probe',
        integrationType: value,
        languages: { python: { package: 'x' } },
        github: 'https://github.com/example/x',
        addedDate: '2026-07-17',
      })
      expect(result.success, `type ${value} is in CATALOG_TYPES but rejected by the schema`).toBe(true)
    }
  })

  it('loads built-in SDK entries', async () => {
    const entries = await getCollection('catalog')
    const anthropic = entries.find((e) => e.id === 'anthropic')
    expect(anthropic).toBeDefined()
    expect(anthropic!.data.maintainedBy).toBe('strands')
    expect(anthropic!.data.docsPage).toBe('docs/user-guide/sdk/model-providers/anthropic')
    // The content layer silently drops entries whose YAML fails to parse;
    // matching loaded ids against the on-disk files catches that and names
    // the dropped entry, without pinning counts.
    const fileIds = readdirSync('src/content/catalog', { recursive: true })
      .map((f) => String(f).replaceAll('\\', '/'))
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => f.slice(0, -'.yaml'.length))
      .sort()
    expect(entries.map((e) => e.id).sort()).toEqual(fileIds)
    const byTier = Map.groupBy(entries, (e) => e.data.maintainedBy)
    expect(byTier.get('strands')?.length).toBeGreaterThan(0)
    expect(byTier.get('aws')?.length).toBeGreaterThan(0)
    expect(byTier.get('partner')?.length).toBeGreaterThan(0)
    // Built-ins point at their source path in the SDK monorepo and always
    // have on-site docs.
    for (const e of byTier.get('strands') ?? []) {
      expect(e.data.github, e.id).toMatch(/^https:\/\/github\.com\/strands-agents\/harness-sdk\//)
      expect(e.data.docsPage, e.id).toBeDefined()
    }
  })

  it('built-in github links resolve to real monorepo paths', async () => {
    // Built-ins deep-link their source (blob/tree under main); unlike docsPage
    // nothing else validates them, so a repo restructure would rot the links
    // silently without this.
    const entries = await getCollection('catalog')
    for (const e of entries.filter((x) => x.data.maintainedBy === 'strands')) {
      const m = /^https:\/\/github\.com\/strands-agents\/harness-sdk\/(?:blob|tree)\/main\/(.+)$/.exec(e.data.github)
      expect(m, `${e.id}: ${e.data.github}`).not.toBeNull()
      expect(existsSync(join('..', m![1])), `${e.id}: ${m![1]} missing from the repo`).toBe(true)
    }
  })

  it('has no catalog-stats keys for removed integrations', async () => {
    // The refresh-stats workflow prunes removed entries only on its weekly
    // run; a key left behind by a removed integration otherwise lingers.
    const entries = await getCollection('catalog')
    const ids = new Set(entries.map((e) => e.id))
    expect(Object.keys(stats).filter((k) => !ids.has(k))).toEqual([])
  })

  it('every docsPage points at a real docs collection entry', async () => {
    const [entries, docs] = await Promise.all([getCollection('catalog'), getCollection('docs')])
    const docIds = new Set(docs.map((d) => d.id))
    for (const e of entries) {
      if (e.data.docsPage) {
        expect(docIds.has(e.data.docsPage), `catalog entry ${e.id} docsPage ${e.data.docsPage} not found in docs`).toBe(
          true
        )
      }
    }
  })

  it('every community docs page with an integrationType has a catalog entry', async () => {
    const [entries, docs] = await Promise.all([getCollection('catalog'), getCollection('docs')])
    const cataloged = new Set(entries.map((e) => e.data.docsPage).filter(Boolean))
    const communityPages = docs.filter(
      (d) => d.id.startsWith('docs/integrations/') && d.data.community === true && d.data.integrationType
    )
    for (const page of communityPages) {
      expect(cataloged.has(page.id), `community page ${page.id} has no catalog entry`).toBe(true)
    }
  })
})

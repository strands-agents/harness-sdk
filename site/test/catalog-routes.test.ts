import { describe, expect, it } from 'vitest'
import { CATALOG_TYPES } from '../src/components/catalog/types'
import {
  catalogTypePath,
  catalogTypePaths,
  integrationPageType,
  isCatalogPath,
  legacyCatalogRedirect,
} from '../src/util/catalog-routes'

describe('catalogTypePath', () => {
  it('puts each type under /docs/integrations/ with its slug', () => {
    expect(catalogTypePath('storage')).toBe('/docs/integrations/storage/')
    expect(catalogTypePath('model-provider')).toBe('/docs/integrations/model-providers/')
  })

  it('gives every type its own path', () => {
    const paths = Object.values(catalogTypePaths())
    expect(paths).toHaveLength(CATALOG_TYPES.length)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('rejects an unknown type', () => {
    expect(() => catalogTypePath('nope')).toThrow('Unknown catalog type: nope')
  })
})

describe('isCatalogPath', () => {
  it('matches the catalog and the type pages, with or without the trailing slash', () => {
    expect(isCatalogPath('/integrations/')).toBe(true)
    expect(isCatalogPath('/integrations')).toBe(true)
    expect(isCatalogPath('/docs/integrations/storage/')).toBe(true)
    expect(isCatalogPath('/docs/integrations/storage')).toBe(true)
  })

  it('leaves integration docs pages alone', () => {
    expect(isCatalogPath('/docs/integrations/storage/overview/')).toBe(false)
    expect(isCatalogPath('/docs/integrations/get-featured/')).toBe(false)
    expect(isCatalogPath('/docs/integrations/')).toBe(false)
  })
})

describe('integrationPageType', () => {
  it('reads the type from the folder a docs page sits in', () => {
    expect(integrationPageType('docs/integrations/storage/github')).toBe('storage')
    expect(integrationPageType('docs/integrations/model-providers/cohere')).toBe('model-provider')
    expect(integrationPageType('docs/integrations/storage/overview')).toBe('storage')
  })

  it('leaves pages outside a type folder alone', () => {
    expect(integrationPageType('docs/integrations/get-featured')).toBeUndefined()
    expect(integrationPageType('docs/integrations/storage')).toBeUndefined()
    expect(integrationPageType('docs/integrations/unknown/page')).toBeUndefined()
    expect(integrationPageType('docs/user-guide/sdk/tools/overview')).toBeUndefined()
  })
})

describe('legacyCatalogRedirect', () => {
  const types = catalogTypePaths()
  const entries = { 'strands-github-storage': '/docs/integrations/storage/github/' }

  it('moves a single type to its page', () => {
    expect(legacyCatalogRedirect('?type=storage', types, entries)).toBe('/docs/integrations/storage/')
  })

  it('moves an open docs drawer to the entry page, keeping the filters', () => {
    expect(legacyCatalogRedirect('?type=storage&entry=strands-github-storage&q=git', types, entries)).toBe(
      '/docs/integrations/storage/github/?q=git'
    )
  })

  it('falls back to the type for an unknown entry', () => {
    expect(legacyCatalogRedirect('?type=storage&entry=gone', types, entries)).toBe('/docs/integrations/storage/')
  })

  it('stays on the catalog for several types, an unknown type, or none', () => {
    expect(legacyCatalogRedirect('?type=storage,tool', types, entries)).toBeNull()
    expect(legacyCatalogRedirect('?type=nope', types, entries)).toBeNull()
    expect(legacyCatalogRedirect('?type=toString', types, entries)).toBeNull()
    expect(legacyCatalogRedirect('?entry=toString', types, entries)).toBeNull()
    expect(legacyCatalogRedirect('?q=git', types, entries)).toBeNull()
    expect(legacyCatalogRedirect('', types, entries)).toBeNull()
  })

  it('runs from its own source, as catalog pages inline it', () => {
    const inlined = new Function(`return (${legacyCatalogRedirect.toString()})`)() as typeof legacyCatalogRedirect
    expect(inlined('?entry=strands-github-storage', types, entries)).toBe('/docs/integrations/storage/github/')
  })
})

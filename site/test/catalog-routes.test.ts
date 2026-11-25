import { describe, expect, it } from 'vitest'
import { CATALOG_TYPES } from '../src/components/catalog/types'
import { catalogTypePath, catalogTypePaths, isCatalogPath, legacyTypeRedirect } from '../src/util/catalog-routes'

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

describe('legacyTypeRedirect', () => {
  const paths = catalogTypePaths()

  it('moves a single type to its page', () => {
    expect(legacyTypeRedirect('?type=storage', paths)).toBe('/docs/integrations/storage/')
  })

  it('keeps the other parameters, including an open docs drawer', () => {
    expect(legacyTypeRedirect('?type=storage&entry=strands-github-storage&q=git', paths)).toBe(
      '/docs/integrations/storage/?entry=strands-github-storage&q=git'
    )
  })

  it('stays on the catalog for several types, an unknown type, or none', () => {
    expect(legacyTypeRedirect('?type=storage,tool', paths)).toBeNull()
    expect(legacyTypeRedirect('?type=nope', paths)).toBeNull()
    expect(legacyTypeRedirect('?type=toString', paths)).toBeNull()
    expect(legacyTypeRedirect('?q=git', paths)).toBeNull()
    expect(legacyTypeRedirect('', paths)).toBeNull()
  })

  it('runs from its own source, as the catalog page inlines it', () => {
    const inlined = new Function(`return (${legacyTypeRedirect.toString()})`)() as typeof legacyTypeRedirect
    expect(inlined('?type=storage&q=git', paths)).toBe('/docs/integrations/storage/?q=git')
  })
})

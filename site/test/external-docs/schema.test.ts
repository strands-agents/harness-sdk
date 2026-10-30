import { describe, expect, it } from 'vitest'
import { parseExternalDocsConfig, parseExternalDocsManifest } from '../../scripts/external-docs/schema'

function manifest() {
  return {
    schemaVersion: 1,
    product: {
      id: 'strands-box',
      name: 'Strands Box',
      status: 'preview',
    },
    pages: [
      {
        id: 'getting-started',
        source: 'docs/user/getting-started.md',
        slug: 'quickstart',
        title: 'Getting started',
        description: 'Install and run Box.',
        nav: {
          group: 'Overview',
          order: 1,
        },
      },
    ],
  }
}

describe('external docs schema', () => {
  it('accepts the versioned upstream manifest contract', () => {
    expect(parseExternalDocsManifest(manifest())).toEqual(manifest())
  })

  it('rejects unknown fields and unsupported product status', () => {
    const withUnknown = { ...manifest(), owner: 'site' }
    expect(() => parseExternalDocsManifest(withUnknown)).toThrow(/must contain exactly/)

    const withStatus = manifest()
    withStatus.product.status = 'draft'
    expect(() => parseExternalDocsManifest(withStatus)).toThrow(/preview.*stable/)
  })

  it('rejects duplicate routes and navigation positions', () => {
    const duplicate = manifest()
    duplicate.pages.push({
      ...duplicate.pages[0]!,
      id: 'configuration',
      source: 'docs/user/configuration.md',
    })
    expect(() => parseExternalDocsManifest(duplicate)).toThrow(/page slug "quickstart" is duplicated/)

    duplicate.pages[1]!.slug = 'configuration'
    expect(() => parseExternalDocsManifest(duplicate)).toThrow(/navigation group\/order/)
  })

  it.each([
    '/docs/user/getting-started.md',
    'docs/user/../design/architecture.md',
    'docs/user\\getting-started.md',
    '../docs/user/getting-started.md',
    'docs/design/architecture.md',
  ])('rejects unsafe or unpublished source path %s', (source) => {
    const invalid = manifest()
    invalid.pages[0]!.source = source
    expect(() => parseExternalDocsManifest(invalid)).toThrow()
  })

  it('requires unique site-owned route prefixes', () => {
    const config = {
      schemaVersion: 1,
      products: [
        {
          id: 'strands-box',
          repository: 'https://github.com/strands-agents/box',
          ref: 'main',
          manifest: 'docs/site-manifest.json',
          routePrefix: 'docs/user-guide/box/source',
          navLabel: 'Upstream docs preview',
        },
        {
          id: 'other-product',
          repository: 'https://github.com/example/other-product',
          ref: 'main',
          manifest: 'docs/site-manifest.json',
          routePrefix: 'docs/user-guide/box/source',
          navLabel: 'Other docs',
        },
      ],
    }
    expect(() => parseExternalDocsConfig(config)).toThrow(/route prefix/)

    config.products[1]!.routePrefix = 'docs/user-guide/box/source/nested'
    expect(() => parseExternalDocsConfig(config)).toThrow(/route prefixes.*overlap/)
  })
})

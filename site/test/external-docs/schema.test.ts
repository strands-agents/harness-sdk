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
        source: 'docs/getting-started.md',
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

  it('accepts manifests without the deprecated upstream status', () => {
    const input = manifest()
    const withoutStatus = {
      ...input,
      product: {
        id: input.product.id,
        name: input.product.name,
      },
    }

    expect(parseExternalDocsManifest(withoutStatus)).toEqual(withoutStatus)
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
      source: 'docs/configuration.md',
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
    'README.md',
  ])('rejects unsafe or non-docs source path %s', (source) => {
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
          publicationStatus: 'preview',
        },
        {
          id: 'other-product',
          repository: 'https://github.com/example/other-product',
          ref: 'main',
          manifest: 'docs/site-manifest.json',
          routePrefix: 'docs/user-guide/box/source',
          navLabel: 'Other docs',
          publicationStatus: 'preview',
        },
      ],
    }
    expect(() => parseExternalDocsConfig(config)).toThrow(/route prefix/)

    config.products[1]!.routePrefix = 'docs/user-guide/box/source/nested'
    expect(() => parseExternalDocsConfig(config)).toThrow(/route prefixes.*overlap/)
  })

  it('rejects repository URLs ending in .git', () => {
    expect(() =>
      parseExternalDocsConfig({
        schemaVersion: 1,
        products: [
          {
            id: 'strands-box',
            repository: 'https://github.com/strands-agents/box.git',
            ref: 'main',
            manifest: 'docs/site-manifest.json',
            routePrefix: 'docs/user-guide/box/source',
            navLabel: 'Upstream docs preview',
            publicationStatus: 'preview',
          },
        ],
      })
    ).toThrow(/without \.git/)
  })

  it('rejects an unsupported site publication status', () => {
    expect(() =>
      parseExternalDocsConfig({
        schemaVersion: 1,
        products: [
          {
            id: 'strands-box',
            repository: 'https://github.com/strands-agents/box',
            ref: 'main',
            manifest: 'docs/site-manifest.json',
            routePrefix: 'docs/user-guide/box/source',
            navLabel: 'Upstream docs preview',
            publicationStatus: 'draft',
          },
        ],
      })
    ).toThrow(/publicationStatus.*preview.*stable/)
  })
})

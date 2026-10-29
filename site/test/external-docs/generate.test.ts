import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildExternalDocsProduct,
  loadExternalDocsManifest,
  writeExternalDocsProduct,
} from '../../scripts/external-docs/generate'
import {
  parseExternalDocsConfig,
  parseExternalDocsLock,
  parseExternalDocsManifest,
} from '../../scripts/external-docs/schema'
import { loadPreviewExternalDocsRoutes } from '../../src/plugins/sitemap-lastmod'
import { loadSidebarFromConfig } from '../../src/sidebar'

const temporaryDirectories: string[] = []
const revision = '1234567890abcdef1234567890abcdef12345678'

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('external docs generation', () => {
  it('produces deterministic pages and ordered navigation', () => {
    const fixture = createFixture()
    const first = buildExternalDocsProduct(fixture)
    const second = buildExternalDocsProduct(fixture)

    expect([...first.files]).toEqual([...second.files])
    expect(first.navigation).toEqual(second.navigation)
    expect(first.navigation.groups.map((group) => group.label)).toEqual(['Guides', 'Overview'])
    expect(first.navigation.groups[0]?.items.map((item) => item.label)).toEqual(['First guide', 'Second guide'])

    const firstGuide = first.files.get('guides/first.md')
    expect(firstGuide).toContain(`slug: "docs/user-guide/example/source/guides/first"`)
    expect(firstGuide).toContain(`revision: "${revision}"`)
    expect(firstGuide).toContain('pagefind: false')
    expect(firstGuide).toContain('content: "noindex, nofollow"')
    expect(firstGuide).not.toContain('# First source heading')
    expect(firstGuide).toContain('[Second](/docs/user-guide/example/source/guides/second/)')
  })

  it('writes generated navigation that expands from one sidebar placeholder', () => {
    const fixture = createFixture()
    const built = buildExternalDocsProduct(fixture)
    const root = temporaryDirectory()
    const outputRoot = path.join(root, 'external-docs')
    const contentRoot = path.join(root, 'content')
    const navigationPath = path.join(root, 'navigation.yml')

    writeExternalDocsProduct(outputRoot, built)
    expect(loadPreviewExternalDocsRoutes(outputRoot)).toEqual(['docs/user-guide/example/source/'])
    for (const item of built.navigation.groups.flatMap((group) => group.items)) {
      const contentPath = path.join(contentRoot, `${item.slug}.md`)
      fs.mkdirSync(path.dirname(contentPath), { recursive: true })
      fs.writeFileSync(contentPath, 'generated')
    }
    fs.writeFileSync(
      navigationPath,
      `navbar: []
sidebar:
  - label: Example
    items:
      - externalDocs: example
github:
  sections: []
`
    )

    const sidebar = loadSidebarFromConfig(navigationPath, contentRoot, new Date('2026-10-29T00:00:00Z'), outputRoot)

    expect(sidebar).toEqual([
      {
        label: 'Example',
        items: [
          {
            label: 'Upstream docs preview',
            items: [
              {
                label: 'Guides',
                items: [
                  { label: 'First guide', slug: 'docs/user-guide/example/source/guides/first' },
                  { label: 'Second guide', slug: 'docs/user-guide/example/source/guides/second' },
                ],
              },
              {
                label: 'Overview',
                items: [{ label: 'Overview', slug: 'docs/user-guide/example/source/overview' }],
              },
            ],
          },
        ],
      },
    ])
  })

  it('rejects source symlinks even when they point to a regular file', () => {
    const fixture = createFixture()
    const outside = path.join(temporaryDirectory(), 'outside.md')
    fs.writeFileSync(outside, '# Outside\n')
    fs.rmSync(path.join(fixture.sourceRoot, 'docs/user/first.md'))
    fs.symlinkSync(outside, path.join(fixture.sourceRoot, 'docs/user/first.md'))

    expect(() => buildExternalDocsProduct(fixture)).toThrow(/regular files/)
  })

  it('loads and validates the manifest from the configured checkout path', () => {
    const fixture = createFixture()
    const loaded = loadExternalDocsManifest(fixture.sourceRoot, fixture.config)
    expect(loaded).toEqual(fixture.manifest)
  })
})

function createFixture() {
  const sourceRoot = temporaryDirectory()
  fs.mkdirSync(path.join(sourceRoot, 'docs/user'), { recursive: true })
  fs.writeFileSync(
    path.join(sourceRoot, 'docs/user/first.md'),
    '# First source heading\n\nRead [Second](./second.md).\n'
  )
  fs.writeFileSync(path.join(sourceRoot, 'docs/user/second.md'), '# Second source heading\n\nSecond.\n')
  fs.writeFileSync(path.join(sourceRoot, 'docs/user/overview.md'), '# Overview source heading\n\nOverview.\n')

  const manifest = parseExternalDocsManifest({
    schemaVersion: 1,
    product: { id: 'example', name: 'Example', status: 'preview' },
    pages: [
      page('second', 'docs/user/second.md', 'guides/second', 'Second guide', 'Guides', 2),
      page('overview', 'docs/user/overview.md', 'overview', 'Overview', 'Overview', 1),
      page('first', 'docs/user/first.md', 'guides/first', 'First guide', 'Guides', 1),
    ],
  })
  fs.mkdirSync(path.join(sourceRoot, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(sourceRoot, 'docs/site-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const config = parseExternalDocsConfig({
    schemaVersion: 1,
    products: [
      {
        id: 'example',
        repository: 'https://github.com/example/docs',
        ref: 'main',
        manifest: 'docs/site-manifest.json',
        routePrefix: 'docs/user-guide/example/source',
        navLabel: 'Upstream docs preview',
      },
    ],
  }).products[0]!
  const lock = parseExternalDocsLock({
    schemaVersion: 1,
    products: [
      {
        id: 'example',
        revision,
      },
    ],
  }).products[0]!

  return { sourceRoot, config, lock, manifest, revision }
}

function page(id: string, source: string, slug: string, title: string, group: string, order: number) {
  return {
    id,
    source,
    slug,
    title,
    description: `${title} description.`,
    nav: { group, order },
  }
}

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'external-docs-'))
  temporaryDirectories.push(directory)
  return directory
}

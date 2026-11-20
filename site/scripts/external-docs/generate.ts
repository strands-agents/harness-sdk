import fs from 'node:fs'
import path from 'node:path'
import { transformExternalMarkdown } from './markdown'
import { parseExternalDocsManifest } from './schema'
import type { ExternalDocsManifest, ExternalDocsManifestPage, ExternalDocsProductConfig } from './schema'
import type { GeneratedExternalDocsNavigation } from '../../src/external-docs-navigation'

export interface BuiltExternalDocsProduct {
  productId: string
  files: Map<string, string>
  navigation: GeneratedExternalDocsNavigation
}

export function loadExternalDocsManifest(sourceRoot: string, config: ExternalDocsProductConfig): ExternalDocsManifest {
  const manifestPath = readSourcePath(sourceRoot, config.manifest)
  const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  const manifest = parseExternalDocsManifest(parsed, manifestPath)
  assertManifestCompatibleWithConfig(manifest, config, manifestPath)
  return manifest
}

export function buildExternalDocsProduct(options: {
  sourceRoot: string
  config: ExternalDocsProductConfig
  manifest: ExternalDocsManifest
  revision: string
  editRef: string | null
}): BuiltExternalDocsProduct {
  const { sourceRoot, config, manifest, revision, editRef } = options
  assertManifestCompatibleWithConfig(manifest, config)

  const publishedRoutes = new Map(manifest.pages.map((page) => [page.source, `${config.routePrefix}/${page.slug}`]))
  const files = new Map<string, string>()

  for (const page of manifest.pages) {
    const sourcePath = readSourcePath(sourceRoot, page.source)
    const markdown = fs.readFileSync(sourcePath, 'utf-8')
    const currentRoute = `${config.routePrefix}/${page.slug}`
    const content = transformExternalMarkdown(markdown, {
      sourcePath: page.source,
      currentRoute,
      repository: config.repository,
      revision,
      editRef,
      publishedRoutes,
    })
    files.set(`${page.slug}.mdx`, renderPage(page, manifest, config, revision, editRef, content))
  }

  return {
    productId: config.id,
    files,
    navigation: buildNavigation(manifest, config, revision),
  }
}

export function writeExternalDocsProduct(outputRoot: string, built: BuiltExternalDocsProduct): void {
  const productOutput = path.join(outputRoot, built.productId)
  fs.rmSync(productOutput, { recursive: true, force: true })

  const contentOutput = path.join(productOutput, 'content')
  for (const [relativePath, content] of built.files) {
    const outputPath = path.join(contentOutput, relativePath)
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, content, 'utf-8')
  }

  fs.mkdirSync(productOutput, { recursive: true })
  fs.writeFileSync(
    path.join(productOutput, 'navigation.json'),
    `${JSON.stringify(built.navigation, null, 2)}\n`,
    'utf-8'
  )
}

function renderPage(
  page: ExternalDocsManifestPage,
  manifest: ExternalDocsManifest,
  config: ExternalDocsProductConfig,
  revision: string,
  editRef: string | null,
  content: string
): string {
  const route = `${config.routePrefix}/${page.slug}`
  const editUrl = editRef === null ? false : `${config.repository}/edit/${editRef}/${page.source}`
  const previewFrontmatter =
    config.publicationStatus === 'preview'
      ? [
          'pagefind: false',
          'head:',
          '  - tag: meta',
          '    attrs:',
          '      name: robots',
          '      content: "noindex, nofollow"',
        ]
      : []
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(page.title)}`,
    `description: ${JSON.stringify(page.description)}`,
    `slug: ${JSON.stringify(route)}`,
    `editUrl: ${JSON.stringify(editUrl)}`,
    ...previewFrontmatter,
    'externalDocs:',
    `  product: ${JSON.stringify(manifest.product.name)}`,
    `  productId: ${JSON.stringify(manifest.product.id)}`,
    `  status: ${JSON.stringify(config.publicationStatus)}`,
    `  repository: ${JSON.stringify(config.repository)}`,
    `  ref: ${JSON.stringify(config.ref)}`,
    `  revision: ${JSON.stringify(revision)}`,
    `  source: ${JSON.stringify(page.source)}`,
    '---',
    '',
  ].join('\n')

  return `${frontmatter}${content.trimEnd()}\n`
}

function buildNavigation(
  manifest: ExternalDocsManifest,
  config: ExternalDocsProductConfig,
  revision: string
): GeneratedExternalDocsNavigation {
  interface MutableNode {
    label: string
    children: Map<string, MutableNode>
    leaves: Array<{ label: string; slug: string; order: number }>
    firstOrder: number
  }

  const root: MutableNode = { label: '', children: new Map(), leaves: [], firstOrder: Number.POSITIVE_INFINITY }
  for (const page of manifest.pages) {
    let node = root
    for (const segment of page.nav.group) {
      let child = node.children.get(segment)
      if (child === undefined) {
        child = { label: segment, children: new Map(), leaves: [], firstOrder: Number.POSITIVE_INFINITY }
        node.children.set(segment, child)
      }
      child.firstOrder = Math.min(child.firstOrder, page.nav.order)
      node = child
    }
    node.leaves.push({
      label: page.title,
      slug: `${config.routePrefix}/${page.slug}`,
      order: page.nav.order,
    })
  }

  function toGroups(node: MutableNode): GeneratedExternalDocsNavigation['groups'] {
    const groups: GeneratedExternalDocsNavigation['groups'] = []
    const entries: Array<{ order: number; group: GeneratedExternalDocsNavigation['groups'][number] }> = []
    for (const child of node.children.values()) {
      entries.push({
        order: child.firstOrder,
        group: { label: child.label, items: toItems(child) },
      })
    }
    entries.sort((left, right) => left.order - right.order)
    for (const entry of entries) groups.push(entry.group)
    return groups
  }

  function toItems(node: MutableNode): GeneratedExternalDocsNavigation['groups'][number]['items'] {
    const items: Array<{ order: number; item: GeneratedExternalDocsNavigation['groups'][number]['items'][number] }> = []
    for (const child of node.children.values()) {
      items.push({
        order: child.firstOrder,
        item: { label: child.label, items: toItems(child) },
      })
    }
    for (const leaf of node.leaves) {
      items.push({ order: leaf.order, item: { label: leaf.label, slug: leaf.slug } })
    }
    items.sort((left, right) => left.order - right.order)
    return items.map((entry) => entry.item)
  }

  return {
    schemaVersion: 1,
    product: { ...manifest.product, status: config.publicationStatus },
    revision,
    routePrefix: config.routePrefix,
    label: config.navLabel,
    groups: toGroups(root),
  }
}

function assertManifestCompatibleWithConfig(
  manifest: ExternalDocsManifest,
  config: ExternalDocsProductConfig,
  label = 'external docs manifest'
): void {
  if (manifest.product.id !== config.id) {
    throw new Error(`${label}: product id "${manifest.product.id}" does not match configured id "${config.id}"`)
  }
}

function readSourcePath(sourceRoot: string, relativePath: string): string {
  const root = fs.realpathSync(sourceRoot)
  const candidate = path.join(root, ...relativePath.split('/'))
  const stat = fs.lstatSync(candidate)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${relativePath}: external docs sources must be regular files`)
  }

  const resolved = fs.realpathSync(candidate)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${relativePath}: external docs source escapes the checkout`)
  }
  return resolved
}

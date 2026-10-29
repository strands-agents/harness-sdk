import fs from 'node:fs'
import path from 'node:path'
import { transformExternalMarkdown } from './markdown'
import { parseExternalDocsManifest } from './schema'
import type {
  ExternalDocsManifest,
  ExternalDocsManifestPage,
  ExternalDocsProductConfig,
  ExternalDocsProductLock,
} from './schema'
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
  if (manifest.product.id !== config.id) {
    throw new Error(`${manifestPath}: product id "${manifest.product.id}" does not match configured id "${config.id}"`)
  }
  return manifest
}

export function buildExternalDocsProduct(options: {
  sourceRoot: string
  config: ExternalDocsProductConfig
  lock: ExternalDocsProductLock
  manifest: ExternalDocsManifest
  revision: string
}): BuiltExternalDocsProduct {
  const { sourceRoot, config, lock, manifest, revision } = options
  if (config.id !== lock.id || config.id !== manifest.product.id) {
    throw new Error('external docs product ids must match across config, lock, and manifest')
  }

  const publishedRoutes = new Map(manifest.pages.map((page) => [page.source, `${config.routePrefix}/${page.slug}`]))
  const files = new Map<string, string>()

  for (const page of manifest.pages) {
    const sourcePath = readSourcePath(sourceRoot, page.source)
    const markdown = fs.readFileSync(sourcePath, 'utf-8')
    const content = transformExternalMarkdown(markdown, {
      sourcePath: page.source,
      repository: config.repository,
      revision,
      publishedRoutes,
    })
    files.set(`${page.slug}.md`, renderPage(page, manifest, config, lock, revision, content))
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
  lock: ExternalDocsProductLock,
  revision: string,
  content: string
): string {
  const route = `${config.routePrefix}/${page.slug}`
  const editUrl = `${config.repository}/edit/${revision}/${page.source}`
  const previewFrontmatter =
    manifest.product.status === 'preview'
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
    `  status: ${JSON.stringify(manifest.product.status)}`,
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
  const grouped = new Map<string, ExternalDocsManifestPage[]>()
  for (const page of manifest.pages) {
    const pages = grouped.get(page.nav.group) ?? []
    pages.push(page)
    grouped.set(page.nav.group, pages)
  }

  return {
    schemaVersion: 1,
    product: manifest.product,
    revision,
    routePrefix: config.routePrefix,
    label: config.navLabel,
    groups: [...grouped].map(([label, pages]) => ({
      label,
      items: [...pages]
        .sort((left, right) => left.nav.order - right.nav.order)
        .map((page) => ({
          label: page.title,
          slug: `${config.routePrefix}/${page.slug}`,
        })),
    })),
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

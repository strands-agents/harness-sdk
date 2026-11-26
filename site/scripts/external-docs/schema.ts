import path from 'node:path'

export type ExternalDocsStatus = 'preview' | 'stable'

export interface ExternalDocsManifest {
  schemaVersion: 1
  product: {
    id: string
    name: string
    /** @deprecated Site publication is controlled by external-docs.config.json. */
    status?: ExternalDocsStatus
  }
  pages: ExternalDocsManifestPage[]
}

export interface ExternalDocsManifestPage {
  id: string
  source: string
  slug: string
  title: string
  description: string
  nav: {
    /** Path of nested sidebar groups, outermost first. A string manifest value is a one-segment path. */
    group: string[]
    order: number
  }
}

export interface ExternalDocsConfig {
  schemaVersion: 1
  products: ExternalDocsProductConfig[]
}

export interface ExternalDocsProductConfig {
  id: string
  repository: string
  ref: string
  manifest: string
  routePrefix: string
  navLabel: string
  publicationStatus: ExternalDocsStatus
}

type JsonObject = Record<string, unknown>

const SAFE_COMPONENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const GITHUB_REPOSITORY = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export function parseExternalDocsManifest(input: unknown, label = 'external docs manifest'): ExternalDocsManifest {
  const root = asObject(input, label)
  assertKeys(root, ['schemaVersion', 'product', 'pages'], label)
  assertSchemaVersion(root.schemaVersion, label)

  const product = parseProduct(root.product, `${label}.product`)
  const pages = asArray(root.pages, `${label}.pages`).map((page, index) => parsePage(page, `${label}.pages[${index}]`))
  if (pages.length === 0) fail(`${label}.pages must contain at least one page`)

  assertUnique(pages, (page) => page.id, `${label} page id`)
  assertUnique(pages, (page) => page.source, `${label} page source`)
  assertUnique(pages, (page) => page.slug, `${label} page slug`)
  assertUnique(
    pages,
    (page) => `${page.nav.group.join('\u001f')}\u0000${page.nav.order}`,
    `${label} navigation group/order`
  )

  return { schemaVersion: 1, product, pages }
}

export function parseExternalDocsConfig(input: unknown, label = 'external docs config'): ExternalDocsConfig {
  const root = asObject(input, label)
  assertKeys(root, ['schemaVersion', 'products'], label)
  assertSchemaVersion(root.schemaVersion, label)

  const products = asArray(root.products, `${label}.products`).map((product, index) =>
    parseConfigProduct(product, `${label}.products[${index}]`)
  )
  if (products.length === 0) fail(`${label}.products must contain at least one product`)
  assertUnique(products, (product) => product.id, `${label} product id`)
  assertUnique(products, (product) => product.routePrefix, `${label} route prefix`)
  assertNonOverlappingRoutePrefixes(products, label)

  return { schemaVersion: 1, products }
}

function parseProduct(input: unknown, label: string): ExternalDocsManifest['product'] {
  const product = asObject(input, label)
  assertKeys(product, product.status === undefined ? ['id', 'name'] : ['id', 'name', 'status'], label)

  const id = safeComponent(product.id, `${label}.id`)
  const name = nonEmptyString(product.name, `${label}.name`)
  if (product.status === undefined) return { id, name }
  return { id, name, status: externalDocsStatus(product.status, `${label}.status`) }
}

function parsePage(input: unknown, label: string): ExternalDocsManifestPage {
  const page = asObject(input, label)
  assertKeys(page, ['id', 'source', 'slug', 'title', 'description', 'nav'], label)

  const nav = asObject(page.nav, `${label}.nav`)
  assertKeys(nav, ['group', 'order'], `${label}.nav`)

  const order = nav.order
  if (!Number.isInteger(order) || (order as number) <= 0) {
    fail(`${label}.nav.order must be a positive integer`)
  }

  return {
    id: safeComponent(page.id, `${label}.id`),
    source: sourcePath(page.source, `${label}.source`),
    slug: safePath(page.slug, `${label}.slug`),
    title: nonEmptyString(page.title, `${label}.title`),
    description: nonEmptyString(page.description, `${label}.description`),
    nav: {
      group: parseNavGroup(nav.group, `${label}.nav.group`),
      order: order as number,
    },
  }
}

function parseNavGroup(input: unknown, label: string): string[] {
  if (typeof input === 'string') return [nonEmptyString(input, label)]
  if (!Array.isArray(input) || input.length === 0) {
    fail(`${label} must be a non-empty string or array of strings`)
  }
  return (input as unknown[]).map((segment, index) => nonEmptyString(segment, `${label}[${index}]`))
}

function parseConfigProduct(input: unknown, label: string): ExternalDocsProductConfig {
  const product = asObject(input, label)
  assertKeys(product, ['id', 'repository', 'ref', 'manifest', 'routePrefix', 'navLabel', 'publicationStatus'], label)

  const repository = nonEmptyString(product.repository, `${label}.repository`)
  if (!GITHUB_REPOSITORY.test(repository) || repository.endsWith('.git')) {
    fail(`${label}.repository must be an https://github.com/<owner>/<repo> URL without .git`)
  }
  const ref = nonEmptyString(product.ref, `${label}.ref`)
  if (ref !== 'main') fail(`${label}.ref must be "main"`)

  return {
    id: safeComponent(product.id, `${label}.id`),
    repository,
    ref,
    manifest: repositoryPath(product.manifest, `${label}.manifest`, '.json'),
    routePrefix: safePath(product.routePrefix, `${label}.routePrefix`),
    navLabel: nonEmptyString(product.navLabel, `${label}.navLabel`),
    publicationStatus: externalDocsStatus(product.publicationStatus, `${label}.publicationStatus`),
  }
}

function sourcePath(input: unknown, label: string): string {
  const source = repositoryPath(input, label, '.md')
  if (!source.startsWith('docs/')) fail(`${label} must be under docs/`)
  return source
}

function repositoryPath(input: unknown, label: string, extension: string): string {
  const value = nonEmptyString(input, label)
  if (value.includes('\\')) fail(`${label} must use forward slashes`)
  if (path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value.startsWith('../')) {
    fail(`${label} must be a normalized repository-relative path`)
  }
  if (!value.endsWith(extension)) fail(`${label} must end with ${extension}`)
  return value
}

function safePath(input: unknown, label: string): string {
  const value = nonEmptyString(input, label)
  if (value.startsWith('/') || value.endsWith('/') || value.includes('\\')) {
    fail(`${label} must be a relative path without leading or trailing slashes`)
  }
  const components = value.split('/')
  if (components.some((component) => !SAFE_COMPONENT.test(component))) {
    fail(`${label} must contain lowercase kebab-case path components`)
  }
  return value
}

function safeComponent(input: unknown, label: string): string {
  const value = nonEmptyString(input, label)
  if (!SAFE_COMPONENT.test(value)) fail(`${label} must be lowercase kebab-case`)
  return value
}

function nonEmptyString(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.trim() !== input || input.length === 0) {
    fail(`${label} must be a non-empty trimmed string`)
  }
  return input
}

function externalDocsStatus(input: unknown, label: string): ExternalDocsStatus {
  if (input !== 'preview' && input !== 'stable') {
    fail(`${label} must be "preview" or "stable"`)
  }
  return input
}

function asObject(input: unknown, label: string): JsonObject {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail(`${label} must be an object`)
  }
  return input as JsonObject
}

function asArray(input: unknown, label: string): unknown[] {
  if (!Array.isArray(input)) fail(`${label} must be an array`)
  return input
}

function assertSchemaVersion(input: unknown, label: string): void {
  if (input !== 1) fail(`${label}.schemaVersion must be 1`)
}

function assertKeys(input: JsonObject, expected: string[], label: string): void {
  const actual = Object.keys(input).sort()
  const wanted = [...expected].sort()
  if (actual.join('\0') !== wanted.join('\0')) {
    fail(`${label} must contain exactly: ${wanted.join(', ')}`)
  }
}

function assertUnique<T>(items: T[], key: (item: T) => string, label: string): void {
  const seen = new Set<string>()
  for (const item of items) {
    const value = key(item)
    if (seen.has(value)) fail(`${label} "${value.replace('\0', ' / ')}" is duplicated`)
    seen.add(value)
  }
}

function assertNonOverlappingRoutePrefixes(products: ExternalDocsProductConfig[], label: string): void {
  for (const [index, product] of products.entries()) {
    for (const other of products.slice(index + 1)) {
      if (
        product.routePrefix.startsWith(`${other.routePrefix}/`) ||
        other.routePrefix.startsWith(`${product.routePrefix}/`)
      ) {
        fail(`${label} route prefixes "${product.routePrefix}" and "${other.routePrefix}" overlap`)
      }
    }
  }
}

function fail(message: string): never {
  throw new Error(message)
}

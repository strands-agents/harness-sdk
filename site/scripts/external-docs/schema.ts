import path from 'node:path'

export interface ExternalDocsManifest {
  schemaVersion: 1
  product: {
    id: string
    name: string
    status: 'preview' | 'stable'
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
    group: string
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
}

export interface ExternalDocsLock {
  schemaVersion: 1
  products: ExternalDocsProductLock[]
}

export interface ExternalDocsProductLock {
  id: string
  revision: string
}

type JsonObject = Record<string, unknown>

const SAFE_COMPONENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const COMMIT_SHA = /^[0-9a-f]{40}$/
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
  assertUnique(pages, (page) => `${page.nav.group}\0${page.nav.order}`, `${label} navigation group/order`)

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

export function parseExternalDocsLock(input: unknown, label = 'external docs lock'): ExternalDocsLock {
  const root = asObject(input, label)
  assertKeys(root, ['schemaVersion', 'products'], label)
  assertSchemaVersion(root.schemaVersion, label)

  const products = asArray(root.products, `${label}.products`).map((product, index) =>
    parseLockProduct(product, `${label}.products[${index}]`)
  )
  if (products.length === 0) fail(`${label}.products must contain at least one product`)
  assertUnique(products, (product) => product.id, `${label} product id`)

  return { schemaVersion: 1, products }
}

export function validateConfigAndLock(config: ExternalDocsConfig, lock: ExternalDocsLock): void {
  const configIds = config.products.map((product) => product.id).sort()
  const lockIds = lock.products.map((product) => product.id).sort()
  if (configIds.join('\0') !== lockIds.join('\0')) {
    fail('external docs config and lock must contain the same product ids')
  }
}

function parseProduct(input: unknown, label: string): ExternalDocsManifest['product'] {
  const product = asObject(input, label)
  assertKeys(product, ['id', 'name', 'status'], label)

  const id = safeComponent(product.id, `${label}.id`)
  const name = nonEmptyString(product.name, `${label}.name`)
  const status = product.status
  if (status !== 'preview' && status !== 'stable') {
    fail(`${label}.status must be "preview" or "stable"`)
  }
  return { id, name, status }
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
      group: nonEmptyString(nav.group, `${label}.nav.group`),
      order: order as number,
    },
  }
}

function parseConfigProduct(input: unknown, label: string): ExternalDocsProductConfig {
  const product = asObject(input, label)
  assertKeys(product, ['id', 'repository', 'ref', 'manifest', 'routePrefix', 'navLabel'], label)

  const repository = nonEmptyString(product.repository, `${label}.repository`)
  if (!GITHUB_REPOSITORY.test(repository)) {
    fail(`${label}.repository must be an https://github.com/<owner>/<repo> URL without .git`)
  }

  return {
    id: safeComponent(product.id, `${label}.id`),
    repository,
    ref: nonEmptyString(product.ref, `${label}.ref`),
    manifest: repositoryPath(product.manifest, `${label}.manifest`, '.json'),
    routePrefix: safePath(product.routePrefix, `${label}.routePrefix`),
    navLabel: nonEmptyString(product.navLabel, `${label}.navLabel`),
  }
}

function parseLockProduct(input: unknown, label: string): ExternalDocsProductLock {
  const product = asObject(input, label)
  assertKeys(product, ['id', 'revision'], label)

  const revision = nonEmptyString(product.revision, `${label}.revision`)
  if (!COMMIT_SHA.test(revision)) fail(`${label}.revision must be a 40-character lowercase commit SHA`)

  return {
    id: safeComponent(product.id, `${label}.id`),
    revision,
  }
}

function sourcePath(input: unknown, label: string): string {
  const source = repositoryPath(input, label, '.md')
  if (!source.startsWith('docs/user/')) fail(`${label} must be under docs/user/`)
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

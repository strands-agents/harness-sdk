import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildExternalDocsProduct, loadExternalDocsManifest, writeExternalDocsProduct } from './generate'
import { parseExternalDocsConfig, type ExternalDocsProductConfig } from './schema'

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const configPath = path.join(siteRoot, 'external-docs.config.json')
const outputRoot = path.join(siteRoot, '.build/external-docs')
const checkoutRoot = path.join(siteRoot, '.build/external-docs-sources')
const COMMIT_SHA = /^[0-9a-f]{40}$/

function main(): void {
  const config = parseExternalDocsConfig(readJson(configPath), configPath)
  const sourceOverrides = parseSourceOverrides(process.argv.slice(2))
  const refOverrides = parseRefOverrides(
    process.env.EXTERNAL_DOCS_REF_OVERRIDES,
    config.products.map(({ id }) => id)
  )
  for (const product of config.products) {
    const localSource = sourceOverrides.get(product.id) ?? process.env[sourceEnvironmentVariable(product.id)]
    const ref = refOverrides.get(product.id) ?? product.ref
    const source = localSource ? resolveLocalSource(localSource) : resolveTrackedSource(product, checkoutRoot, ref)
    const effectiveConfig = source.local ? { ...product, ref: source.revision } : product
    const manifest = loadExternalDocsManifest(source.root, effectiveConfig)
    const built = buildExternalDocsProduct({
      sourceRoot: source.root,
      config: effectiveConfig,
      manifest,
      revision: source.revision,
      editRef: source.local ? null : product.ref,
    })
    writeExternalDocsProduct(outputRoot, built)
    console.log(
      `product=${product.id}, pages=${built.files.size}, revision=${source.revision} | generated external docs`
    )
  }
}

export interface ResolvedSource {
  root: string
  revision: string
  local: boolean
}

function resolveLocalSource(sourcePath: string): ResolvedSource {
  const root = fs.realpathSync(path.resolve(siteRoot, sourcePath))
  const revision = git(['-C', root, 'rev-parse', 'HEAD'])
  if (!COMMIT_SHA.test(revision)) throw new Error(`${root}: could not resolve a full commit SHA`)
  return { root, revision, local: true }
}

export function resolveTrackedSource(
  config: ExternalDocsProductConfig,
  sourcesRoot = checkoutRoot,
  ref = config.ref
): ResolvedSource {
  if (ref !== 'main' && !COMMIT_SHA.test(ref)) {
    throw new Error(`${config.id}: ref must be "main" or a 40-character lowercase commit SHA`)
  }

  const root = path.join(sourcesRoot, config.id)
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(root), { recursive: true })
  try {
    git(['init', root])
    git(['-C', root, 'remote', 'add', 'origin', `${config.repository}.git`])
    git(['-C', root, 'fetch', '--depth=1', 'origin', ref === 'main' ? 'refs/heads/main' : ref])

    const revision = git(['-C', root, 'rev-parse', 'FETCH_HEAD^{commit}'])
    if (!COMMIT_SHA.test(revision)) {
      throw new Error(`${config.id}: ref "${ref}" did not resolve to a full commit SHA`)
    }
    if (COMMIT_SHA.test(ref) && revision !== ref) {
      throw new Error(`${config.id}: fetched ${revision}, but the override requires ${ref}`)
    }

    git(['-C', root, 'checkout', '--detach', 'FETCH_HEAD'])
    return { root, revision, local: false }
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true })
    throw error
  }
}

export function parseRefOverrides(input: string | undefined, productIds: readonly string[]): Map<string, string> {
  const overrides = new Map<string, string>()
  if (!input) return overrides

  const knownProductIds = new Set(productIds)
  for (const rawEntry of input.split(',')) {
    const entry = rawEntry.trim()
    const separator = entry.indexOf('=')
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error('EXTERNAL_DOCS_REF_OVERRIDES must contain product-id=<40-character SHA> entries')
    }

    const productId = entry.slice(0, separator)
    const revision = entry.slice(separator + 1)
    if (!knownProductIds.has(productId)) {
      throw new Error(`EXTERNAL_DOCS_REF_OVERRIDES contains unknown product "${productId}"`)
    }
    if (overrides.has(productId)) {
      throw new Error(`EXTERNAL_DOCS_REF_OVERRIDES contains duplicate product "${productId}"`)
    }
    if (!COMMIT_SHA.test(revision)) {
      throw new Error(`EXTERNAL_DOCS_REF_OVERRIDES for "${productId}" must be a 40-character lowercase commit SHA`)
    }
    overrides.set(productId, revision)
  }
  return overrides
}

function parseSourceOverrides(args: string[]): Map<string, string> {
  const overrides = new Map<string, string>()
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    const value = argument === '--source' ? args[++index] : argument.startsWith('--source=') ? argument.slice(9) : null
    if (value === null) throw new Error(`unknown external docs argument: ${argument}`)
    if (!value) throw new Error('--source requires <product-id>=<checkout-path>')

    const separator = value.indexOf('=')
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error('--source requires <product-id>=<checkout-path>')
    }
    overrides.set(value.slice(0, separator), value.slice(separator + 1))
  }
  return overrides
}

function sourceEnvironmentVariable(productId: string): string {
  return `EXTERNAL_DOCS_${productId.replaceAll('-', '_').toUpperCase()}_SOURCE`
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) main()

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildExternalDocsProduct, loadExternalDocsManifest, writeExternalDocsProduct } from './generate'
import {
  parseExternalDocsConfig,
  parseExternalDocsLock,
  validateConfigAndLock,
  type ExternalDocsProductConfig,
  type ExternalDocsProductLock,
} from './schema'

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const configPath = path.join(siteRoot, 'external-docs.config.json')
const lockPath = path.join(siteRoot, 'external-docs.lock.json')
const outputRoot = path.join(siteRoot, '.build/external-docs')
const checkoutRoot = path.join(siteRoot, '.build/external-docs-sources')

const config = parseExternalDocsConfig(readJson(configPath), configPath)
const lock = parseExternalDocsLock(readJson(lockPath), lockPath)
validateConfigAndLock(config, lock)

const sourceOverrides = parseSourceOverrides(process.argv.slice(2))
for (const product of config.products) {
  const productLock = lock.products.find((entry) => entry.id === product.id)!
  const localSource = sourceOverrides.get(product.id) ?? process.env[sourceEnvironmentVariable(product.id)]
  const source = localSource ? resolveLocalSource(localSource) : resolvePinnedSource(product, productLock)
  const effectiveConfig = source.local ? { ...product, ref: source.revision } : product
  const manifest = loadExternalDocsManifest(source.root, effectiveConfig)
  const built = buildExternalDocsProduct({
    sourceRoot: source.root,
    config: effectiveConfig,
    lock: productLock,
    manifest,
    revision: source.revision,
  })
  writeExternalDocsProduct(outputRoot, built)
  console.log(`product=${product.id}, pages=${built.files.size}, revision=${source.revision} | generated external docs`)
}

interface ResolvedSource {
  root: string
  revision: string
  local: boolean
}

function resolveLocalSource(sourcePath: string): ResolvedSource {
  const root = fs.realpathSync(path.resolve(siteRoot, sourcePath))
  const revision = git(['-C', root, 'rev-parse', 'HEAD'])
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error(`${root}: could not resolve a full commit SHA`)
  return { root, revision, local: true }
}

function resolvePinnedSource(config: ExternalDocsProductConfig, lock: ExternalDocsProductLock): ResolvedSource {
  const root = path.join(checkoutRoot, lock.id, lock.revision)
  if (fs.existsSync(root)) {
    try {
      const revision = git(['-C', root, 'rev-parse', 'HEAD'])
      if (revision === lock.revision) return { root, revision, local: false }
    } catch {
      // Recreate interrupted or invalid cached checkouts below.
    }
    fs.rmSync(root, { recursive: true, force: true })
  }

  fs.mkdirSync(path.dirname(root), { recursive: true })
  try {
    git(['init', root])
    git(['-C', root, 'remote', 'add', 'origin', `${config.repository}.git`])
    git(['-C', root, 'fetch', '--depth=1', 'origin', lock.revision])

    const fetchedRevision = git(['-C', root, 'rev-parse', 'FETCH_HEAD^{commit}'])
    if (fetchedRevision !== lock.revision) {
      throw new Error(`${lock.id}: fetched ${fetchedRevision}, but the lock requires ${lock.revision}`)
    }

    git(['-C', root, 'checkout', '--detach', 'FETCH_HEAD'])
    return { root, revision: fetchedRevision, local: false }
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true })
    throw error
  }
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

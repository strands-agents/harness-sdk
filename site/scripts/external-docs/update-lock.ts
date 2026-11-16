import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseExternalDocsConfig, parseExternalDocsLock, validateConfigAndLock } from './schema'
import type { ExternalDocsConfig, ExternalDocsLock, ExternalDocsProductConfig } from './schema'

export interface ExternalDocsRevisionChange {
  id: string
  repository: string
  previousRevision: string
  revision: string
}

export async function updateExternalDocsLock(
  config: ExternalDocsConfig,
  lock: ExternalDocsLock,
  resolve: (product: ExternalDocsProductConfig) => Promise<string>
): Promise<{ lock: ExternalDocsLock; changed: boolean; changes: ExternalDocsRevisionChange[] }> {
  validateConfigAndLock(config, lock)
  const changes: ExternalDocsRevisionChange[] = []
  const products: ExternalDocsLock['products'] = []

  for (const lockedProduct of lock.products) {
    const product = config.products.find((entry) => entry.id === lockedProduct.id)!
    const revision = await resolve(product)
    if (!/^[0-9a-f]{40}$/.test(revision)) {
      throw new Error(`${product.id}: resolved revision is not a full lowercase commit SHA`)
    }
    if (revision !== lockedProduct.revision) {
      changes.push({
        id: product.id,
        repository: product.repository,
        previousRevision: lockedProduct.revision,
        revision,
      })
    }
    products.push({ ...lockedProduct, revision })
  }

  return {
    lock: { schemaVersion: 1, products },
    changed: changes.length > 0,
    changes,
  }
}

export function formatRevisionComparisons(changes: ExternalDocsRevisionChange[]): string {
  return changes
    .map(
      (change) =>
        `- [${change.id}: \`${change.previousRevision.slice(0, 7)}\` → \`${change.revision.slice(0, 7)}\`]` +
        `(${change.repository}/compare/${change.previousRevision}...${change.revision})`
    )
    .join('\n')
}

async function resolveGitHubRevision(product: ExternalDocsProductConfig): Promise<string> {
  const repositoryPath = new URL(product.repository).pathname.replace(/^\/|\/$/g, '')
  const response = await fetch(
    `https://api.github.com/repos/${repositoryPath}/commits/${encodeURIComponent(product.ref)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(process.env.GITHUB_TOKEN && { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }),
      },
    }
  )
  if (!response.ok) {
    throw new Error(`${product.id}: GitHub returned ${response.status} while resolving ref "${product.ref}"`)
  }

  const body = (await response.json()) as { sha?: unknown }
  if (typeof body.sha !== 'string') throw new Error(`${product.id}: GitHub response did not include a commit SHA`)
  return body.sha
}

async function main(): Promise<void> {
  const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const configPath = path.join(siteRoot, 'external-docs.config.json')
  const lockPath = path.join(siteRoot, 'external-docs.lock.json')
  const config = parseExternalDocsConfig(JSON.parse(fs.readFileSync(configPath, 'utf-8')), configPath)
  const lock = parseExternalDocsLock(JSON.parse(fs.readFileSync(lockPath, 'utf-8')), lockPath)
  const updated = await updateExternalDocsLock(config, lock, resolveGitHubRevision)

  if (updated.changed) {
    fs.writeFileSync(lockPath, `${JSON.stringify(updated.lock, null, 2)}\n`, 'utf-8')
    writeGitHubReviewOutput(formatRevisionComparisons(updated.changes))
    console.log('file=external-docs.lock.json | updated external docs revisions')
    return
  }
  console.log('file=external-docs.lock.json | external docs revisions are current')
}

function writeGitHubReviewOutput(comparisons: string): void {
  const outputPath = process.env.GITHUB_OUTPUT
  if (outputPath) {
    fs.appendFileSync(
      outputPath,
      `compare_links<<EXTERNAL_DOCS_COMPARISONS\n${comparisons}\nEXTERNAL_DOCS_COMPARISONS\n`,
      'utf-8'
    )
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    fs.appendFileSync(summaryPath, `## External documentation changes\n\n${comparisons}\n`, 'utf-8')
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) await main()

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseExternalDocsConfig } from './external-docs/schema'

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configPath = path.join(siteRoot, 'external-docs.config.json')
const COMMIT_SHA = /^[0-9a-f]{40}$/
const SAMPLES_SOURCE_ID = 'samples'

declare const exactCommitShaBrand: unique symbol
export type ExactCommitSha = string & { readonly [exactCommitShaBrand]: true }

export function isExactCommitSha(value: string): value is ExactCommitSha {
  return COMMIT_SHA.test(value)
}

export function parseExactShaOverrides(
  input: string | undefined,
  allowedIds: readonly string[],
  label: string
): Map<string, ExactCommitSha> {
  const overrides = new Map<string, ExactCommitSha>()
  if (!input) return overrides

  const knownIds = new Set(allowedIds)
  for (const rawEntry of input.split(',')) {
    const entry = rawEntry.trim()
    const separator = entry.indexOf('=')
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error(`${label} must contain source-id=<40-character SHA> entries`)
    }

    const sourceId = entry.slice(0, separator)
    const revision = entry.slice(separator + 1)
    if (!knownIds.has(sourceId)) {
      throw new Error(`${label} contains unknown source "${sourceId}"`)
    }
    if (overrides.has(sourceId)) {
      throw new Error(`${label} contains duplicate source "${sourceId}"`)
    }
    if (!isExactCommitSha(revision)) {
      throw new Error(`${label} for "${sourceId}" must be a 40-character lowercase commit SHA`)
    }
    overrides.set(sourceId, revision)
  }
  return overrides
}

export function serializeExactShaOverrides(
  overrides: ReadonlyMap<string, string>,
  orderedIds: readonly string[]
): string {
  return orderedIds
    .flatMap((id) => {
      const revision = overrides.get(id)
      if (revision === undefined) return []
      if (!isExactCommitSha(revision)) {
        throw new Error(`override for "${id}" must be a 40-character lowercase commit SHA`)
      }
      return [`${id}=${revision}`]
    })
    .join(',')
}

export function resolveProductionContentRefs(
  input: string | undefined,
  externalProductIds: readonly string[]
): { samplesRef: 'main' | ExactCommitSha; externalDocsRefOverrides: string } {
  if (externalProductIds.includes(SAMPLES_SOURCE_ID)) {
    throw new Error(`external docs product id "${SAMPLES_SOURCE_ID}" is reserved`)
  }

  const overrides = parseExactShaOverrides(input, [SAMPLES_SOURCE_ID, ...externalProductIds], 'CONTENT_REF_OVERRIDES')
  return {
    samplesRef: overrides.get(SAMPLES_SOURCE_ID) ?? 'main',
    externalDocsRefOverrides: serializeExactShaOverrides(overrides, externalProductIds),
  }
}

function main(): void {
  const config = parseExternalDocsConfig(JSON.parse(fs.readFileSync(configPath, 'utf-8')), configPath)
  const resolved = resolveProductionContentRefs(
    process.env.CONTENT_REF_OVERRIDES,
    config.products.map(({ id }) => id)
  )
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) throw new Error('GITHUB_OUTPUT is required to resolve production content refs')

  fs.appendFileSync(
    outputPath,
    `samples_ref=${resolved.samplesRef}\nexternal_docs_ref_overrides=${resolved.externalDocsRefOverrides}\n`,
    'utf-8'
  )
  console.log(
    `samples_ref=${resolved.samplesRef}, external_docs_ref_overrides=${resolved.externalDocsRefOverrides || '<none>'} | resolved production content refs`
  )
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) main()

#!/usr/bin/env tsx

import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSampleGuides } from './importer'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const siteDirectory = path.resolve(scriptDirectory, '../..')
const outputDir = path.join(siteDirectory, '.build/samples/pages')

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`)
  return value
}

async function main(): Promise<void> {
  const source = argument('source') ?? process.env.SAMPLES_SOURCE_DIR
  if (!source) {
    if (process.env.SAMPLES_REQUIRE_SOURCE === '1') {
      throw new Error('Samples source is required. Pass --source or set SAMPLES_SOURCE_DIR.')
    }
    await rm(outputDir, { recursive: true, force: true })
    await mkdir(outputDir, { recursive: true })
    console.log(`samples: no source provided; cleared ${path.relative(siteDirectory, outputDir)}`)
    return
  }

  const result = await buildSampleGuides({
    sourceDir: path.resolve(source),
    outputDir,
    requireSamples: process.env.SAMPLES_REQUIRE_SOURCE === '1',
  })
  console.log(`samples: wrote ${result.sampleCount} guides from ${result.repository}@${result.commit}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

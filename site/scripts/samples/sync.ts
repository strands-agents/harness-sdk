#!/usr/bin/env tsx

import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { format, resolveConfig } from 'prettier'

import { buildSampleSnapshot } from './importer'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const siteDirectory = path.resolve(scriptDirectory, '../..')
const destination = path.join(siteDirectory, '.build/samples/sample-details.json')
const fallbackSnapshot = path.join(siteDirectory, 'src/data/sample-details.json')
const migrationManifestPath = path.join(siteDirectory, 'src/data/samples.json')

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`)
  return value
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const sourceArgument = argument('source') ?? process.env.SAMPLES_SOURCE_DIR
  if (!sourceArgument) {
    if (process.env.SAMPLES_REQUIRE_SOURCE === '1') {
      throw new Error('Samples source is required. Pass --source or set SAMPLES_SOURCE_DIR.')
    }
    if (!(await pathExists(destination)) && !(await pathExists(fallbackSnapshot))) {
      throw new Error('No samples source was provided and there is no generated or fallback snapshot to retain.')
    }
    console.log(
      (await pathExists(destination))
        ? `samples: no source provided; retained ${destination}`
        : `samples: no source provided; using committed fallback ${fallbackSnapshot}`
    )
    return
  }

  const sourceDir = path.resolve(sourceArgument)
  const snapshot = await buildSampleSnapshot({
    sourceDir,
    migrationManifestPath,
  })
  const prettierConfig = (await resolveConfig(destination)) ?? {}
  const output = await format(JSON.stringify(snapshot), { ...prettierConfig, filepath: destination })
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, output)
  console.log(
    `samples: wrote ${snapshot.stats.sampleCount} samples and ${snapshot.stats.fileCount} files from ` +
      `${snapshot.source.repository}@${snapshot.source.commit}`
  )
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

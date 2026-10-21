#!/usr/bin/env tsx

import { access, copyFile, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSampleGuides } from './importer'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const siteDirectory = path.resolve(scriptDirectory, '../..')
const outputDir = path.join(siteDirectory, '.build/samples/pages')
const fallback = path.join(siteDirectory, 'src/data/sample-guide-fallback.md')
const fallbackOutput = path.join(outputDir, 'typescript/first-agent.md')

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`)
  return value
}

async function hasGeneratedGuides(): Promise<boolean> {
  try {
    return (await readdir(outputDir, { recursive: true })).some((entry) => entry.endsWith('.md'))
  } catch {
    return false
  }
}

async function useFallback(): Promise<void> {
  await access(fallback)
  await mkdir(path.dirname(fallbackOutput), { recursive: true })
  await copyFile(fallback, fallbackOutput)
  console.log(`samples: no source provided; using ${path.relative(siteDirectory, fallback)}`)
}

async function main(): Promise<void> {
  const source = argument('source') ?? process.env.SAMPLES_SOURCE_DIR
  if (!source) {
    if (process.env.SAMPLES_REQUIRE_SOURCE === '1') {
      throw new Error('Samples source is required. Pass --source or set SAMPLES_SOURCE_DIR.')
    }
    if (await hasGeneratedGuides()) {
      console.log(`samples: no source provided; retained ${path.relative(siteDirectory, outputDir)}`)
      return
    }
    await useFallback()
    return
  }

  const result = await buildSampleGuides({
    sourceDir: path.resolve(source),
    outputDir,
  })
  console.log(`samples: wrote ${result.sampleCount} guides from ${result.repository}@${result.commit}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

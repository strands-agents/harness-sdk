import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

function installedPackageVersion(packageName: string): string {
  let directory: string
  try {
    directory = dirname(require.resolve(packageName))
  } catch {
    return 'development'
  }

  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        name?: unknown
        version?: unknown
      }
      if (manifest.name === packageName && typeof manifest.version === 'string') {
        return manifest.version
      }
    } catch {
      // Continue walking toward the package root.
    }

    const parent = dirname(directory)
    if (parent === directory) {
      return 'development'
    }
    directory = parent
  }
}

export const HARNESS_VERSION = installedPackageVersion('@strands-agents/harness')

/** Reads the CLI manifest from either the source tree or the installed build. */
export function readCliVersion(): string {
  try {
    for (let dir = dirname(fileURLToPath(import.meta.url)); dirname(dir) !== dir; dir = dirname(dir)) {
      const manifest = join(dir, 'package.json')
      if (existsSync(manifest)) {
        return (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version ?? '0.0.0'
      }
    }
  } catch {
    // Keep startup available when package metadata cannot be read.
  }
  return '0.0.0'
}

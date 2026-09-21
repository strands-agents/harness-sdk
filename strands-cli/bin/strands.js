#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_INPUT_DIRECTORIES = ['strands-cli/src', 'harness-ts/src', 'harness-py/src']
const BUILD_INPUT_FILES = [
  'package.json',
  'package-lock.json',
  'strands-cli/package.json',
  'strands-cli/scripts/bundle-python.js',
  'strands-cli/tsconfig.base.json',
  'strands-cli/src/tsconfig.json',
  'harness-ts/package.json',
  'harness-ts/tsconfig.base.json',
  'harness-ts/src/tsconfig.json',
  'harness-py/pyproject.toml',
  'harness-py/README.md',
  'harness-py/LICENSE',
  'harness-py/NOTICE',
]
const BUILD_LOCK_TIMEOUT_MS = 120_000
const BUILD_LOCK_STALE_MS = 300_000

export function isSourceCheckout(packageRoot = PACKAGE_ROOT) {
  return (
    existsSync(join(packageRoot, 'src', 'main.ts')) &&
    existsSync(join(packageRoot, '..', 'harness-ts', 'src', 'index.ts'))
  )
}

export function sourceBuildFingerprint(repositoryRoot) {
  const hash = createHash('sha256')
  const paths = []

  for (const directory of BUILD_INPUT_DIRECTORIES) {
    collectFiles(join(repositoryRoot, directory), paths)
  }
  for (const file of BUILD_INPUT_FILES) {
    const path = join(repositoryRoot, file)
    if (existsSync(path)) {
      paths.push(path)
    }
  }

  paths.sort((left, right) => left.localeCompare(right))
  for (const path of paths) {
    hash.update(relative(repositoryRoot, path))
    hash.update('\0')
    hash.update(readFileSync(path))
    hash.update('\0')
  }
  return hash.digest('hex')
}

export function sourceBuildRequired(repositoryRoot, stateFile, fingerprint) {
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    return (
      state.fingerprint !== fingerprint ||
      !state.outputs.length ||
      state.outputs.some((path) => !existsSync(join(repositoryRoot, path)))
    )
  } catch {
    return true
  }
}

export async function ensureSourceBuild(packageRoot = PACKAGE_ROOT) {
  if (!isSourceCheckout(packageRoot)) {
    return false
  }

  const repositoryRoot = resolve(packageRoot, '..')
  const entrypoint = join(packageRoot, 'dist', 'src', 'main.js')
  const stateDirectory = join(repositoryRoot, 'node_modules', '.cache', 'strands-cli')
  const stateFile = join(stateDirectory, 'source-build.json')
  const lockFile = join(stateDirectory, 'source-build.lock')
  mkdirSync(stateDirectory, { recursive: true })

  let fingerprint = sourceBuildFingerprint(repositoryRoot)
  if (!sourceBuildRequired(repositoryRoot, stateFile, fingerprint)) {
    return false
  }

  const lock = await acquireBuildLock(lockFile)
  try {
    fingerprint = sourceBuildFingerprint(repositoryRoot)
    if (!sourceBuildRequired(repositoryRoot, stateFile, fingerprint)) {
      return false
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      rmSync(join(repositoryRoot, 'harness-ts', 'dist'), { recursive: true, force: true })
      rmSync(join(repositoryRoot, 'strands-cli', 'dist'), { recursive: true, force: true })
      runSourceBuild(repositoryRoot)

      const completedFingerprint = sourceBuildFingerprint(repositoryRoot)
      if (completedFingerprint === fingerprint) {
        if (!existsSync(entrypoint)) {
          throw new Error(`Build completed without creating ${entrypoint}.`)
        }
        const paths = []
        for (const directory of ['harness-ts/dist', 'strands-cli/dist']) {
          collectFiles(join(repositoryRoot, directory), paths)
        }
        const outputs = paths.map((path) => relative(repositoryRoot, path))
        const temporary = `${stateFile}.${process.pid}.tmp`
        writeFileSync(temporary, `${JSON.stringify({ fingerprint: completedFingerprint, outputs })}\n`)
        renameSync(temporary, stateFile)
        return true
      }
      fingerprint = completedFingerprint
    }
    throw new Error('The source checkout changed while it was being built. Run `strands` again.')
  } finally {
    releaseBuildLock(lockFile, lock)
  }
}

export async function launch(packageRoot = PACKAGE_ROOT) {
  await ensureSourceBuild(packageRoot)
  const entrypoint = join(packageRoot, 'dist', 'src', 'main.js')
  if (!existsSync(entrypoint)) {
    throw new Error(`The CLI is not built. From the repository root, run: npm run setup`)
  }
  await import(pathToFileURL(entrypoint).href)
}

function collectFiles(directory, paths) {
  if (!existsSync(directory)) {
    return
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '__pycache__') {
      continue
    }
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      collectFiles(path, paths)
    } else if (entry.isFile()) {
      paths.push(path)
    }
  }
}

function runSourceBuild(repositoryRoot) {
  const windows = process.platform === 'win32'
  const command = windows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm'
  const args = windows ? ['/d', '/s', '/c', 'npm run build'] : ['run', 'build']
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.status === 0) {
    return
  }

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
  const detail = output ? `\n\n${output}` : result.error ? `\n\n${result.error.message}` : ''
  throw new Error(`Unable to build the CLI from this checkout.${detail}\n\nRun npm run setup and try again.`)
}

async function acquireBuildLock(lockFile) {
  const deadline = Date.now() + BUILD_LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const descriptor = openSync(lockFile, 'wx')
      writeSync(descriptor, `${process.pid}\n`)
      return descriptor
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error
      }
      if (lockIsStale(lockFile)) {
        try {
          unlinkSync(lockFile)
        } catch (unlinkError) {
          if (unlinkError?.code !== 'ENOENT') {
            throw unlinkError
          }
        }
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for another source build to finish.', { cause: error })
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
  }
}

function lockIsStale(lockFile) {
  try {
    const owner = Number(readFileSync(lockFile, 'utf8').trim())
    if (Number.isSafeInteger(owner) && owner > 0) {
      try {
        process.kill(owner, 0)
        return false
      } catch (error) {
        return error?.code === 'ESRCH'
      }
    }
    return Date.now() - statSync(lockFile).mtimeMs > BUILD_LOCK_STALE_MS
  } catch {
    return false
  }
}

function releaseBuildLock(lockFile, descriptor) {
  closeSync(descriptor)
  try {
    unlinkSync(lockFile)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
  }
}

function isMainModule() {
  if (!process.argv[1]) {
    return false
  }
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) {
  launch().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

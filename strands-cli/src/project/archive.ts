import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { access, open, readFile, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { Unzip, UnzipInflate, unzipSync } from 'fflate'

import { userDirectory } from '../config/store.js'
import { containsPath } from '../paths.js'
import { npmInvocation } from '../terminal/npm.js'
import type { AgentProjectLanguage } from './import.js'
import { assertPortablePathComponent, MAX_PROJECT_BYTES, MAX_PROJECT_ENTRIES } from './packaging.js'

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
export const AGENT_ENTRYPOINTS = ['ts', 'mts', 'js', 'mjs', 'py'].flatMap((extension) => [
  `agent.${extension}`,
  `agent/agent.${extension}`,
])
export const AGENT_ENTRYPOINT_FILE = '.strands-entrypoint'
export const SOURCE_EXTENSION = /\.(?:ts|mts|js|mjs|py)$/u
const run = promisify(execFile)

function archiveCache(): string {
  return userDirectory('cache', 'agents')
}

export function extractAgentArchive(path: string): string {
  if (lstatSync(path).size > MAX_ARCHIVE_BYTES) {
    throw new Error('The agent ZIP exceeds 64 MB.')
  }
  const archive = readFileSync(path)
  const cache = archiveCache()
  const destination = join(cache, createHash('sha256').update(archive).digest('hex'))
  try {
    const details = lstatSync(destination)
    if (!details.isDirectory()) {
      throw new Error('The cached agent project is not a regular directory.')
    }
    return archiveProjectRoot(realpathSync(destination))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const files = readProjectArchive(archive)
  const modes = archiveExecutableModes(archive)

  mkdirSync(cache, { recursive: true, mode: 0o700 })
  const temporary = mkdtempSync(join(cache, '.extract-'))
  try {
    for (const [name, contents] of files) {
      const target = join(temporary, name)
      if (name.endsWith('/')) {
        mkdirSync(target, { recursive: true })
      } else {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, contents, { flag: 'wx', mode: 0o644 | (modes.get(name) ?? 0) })
      }
    }
    archiveProjectRoot(realpathSync(temporary))
    try {
      renameSync(temporary, destination)
    } catch (error) {
      // Another process may have finished extracting this same archive.
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      if (!lstatSync(destination).isDirectory()) throw error
    }
    return archiveProjectRoot(realpathSync(destination))
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

export function readProjectArchive(archive: Uint8Array): Map<string, Uint8Array> {
  let bytes = 0
  let count = 0
  const names = new Set<string>()
  const sizes = new Map<string, number>()
  unzipSync(archive, {
    filter: (entry) => {
      const name = entry.name.replace(/\/$/u, '')
      const parts = name.split('/')
      if (
        name.includes('\\') ||
        /^[a-z]:/iu.test(name) ||
        parts.some((part) => part === '..' || part === '.' || !part)
      ) {
        throw new Error(`Unsafe path in agent ZIP: ${JSON.stringify(entry.name)}`)
      }
      for (const part of parts) {
        assertPortablePathComponent(part)
      }
      const key = name.toLowerCase()
      if (names.has(key)) {
        throw new Error(`Duplicate path in agent ZIP: ${JSON.stringify(entry.name)}`)
      }
      names.add(key)
      bytes += entry.originalSize
      if (bytes > MAX_PROJECT_BYTES || ++count > MAX_PROJECT_ENTRIES) {
        throw new Error('The agent ZIP exceeds 50 MB of extracted files or 10,000 entries.')
      }
      sizes.set(entry.name, entry.originalSize)
      return false
    },
  })
  const files = new Map<string, Uint8Array>()
  const unzip = new Unzip((file) => {
    const expected = sizes.get(file.name)
    if (expected === undefined) throw new Error('The agent ZIP file headers do not match its directory.')
    sizes.delete(file.name)
    const chunks: Uint8Array[] = []
    let size = 0
    file.ondata = (error, data, final): void => {
      if (error) throw error
      size += data.length
      if (size > expected || (final && size !== expected)) {
        throw new Error('The agent ZIP file size does not match its directory.')
      }
      chunks.push(data)
      if (final) files.set(file.name, Buffer.concat(chunks))
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  // Bound each inflate allocation before checking the emitted size.
  for (let offset = 0; offset < archive.length; offset += 16_384) {
    unzip.push(archive.subarray(offset, offset + 16_384), offset + 16_384 >= archive.length)
  }
  if (sizes.size > 0 || files.size !== count) throw new Error('The agent ZIP is missing file contents.')
  return files
}

// fflate does not expose the central directory's file permissions.
export function archiveExecutableModes(archive: Buffer): Map<string, number> {
  let end = archive.length - 22
  while (end >= 0 && archive.readUInt32LE(end) !== 0x06054b50) {
    end -= 1
  }
  if (end < 0) {
    throw new Error('The agent ZIP is missing its central directory.')
  }
  let offset = archive.readUInt32LE(end + 16)
  if (end >= 20 && archive.readUInt32LE(end - 20) === 0x07064b50) {
    const zip64 = Number(archive.readBigUInt64LE(end - 12))
    offset = Number(archive.readBigUInt64LE(zip64 + 48))
  }
  const modes = new Map<string, number>()
  while (offset + 46 <= archive.length && archive.readUInt32LE(offset) === 0x02014b50) {
    const length = archive.readUInt16LE(offset + 28)
    const name = archive
      .subarray(offset + 46, offset + 46 + length)
      .toString(archive.readUInt16LE(offset + 8) & 0x800 ? 'utf8' : 'latin1')
    const mode = archive.readUInt32LE(offset + 38) >>> 16
    if ((mode & 0o170000) === 0o120000) {
      throw new Error('The agent ZIP cannot contain symbolic links.')
    }
    modes.set(name, mode & 0o111)
    offset += 46 + length + archive.readUInt16LE(offset + 30) + archive.readUInt16LE(offset + 32)
  }
  return modes
}

export async function prepareArchiveDependencies(root: string, language: AgentProjectLanguage): Promise<void> {
  let cache: string
  try {
    cache = realpathSync(archiveCache())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  root = realpathSync(root)
  if (root === cache || !containsPath(cache, root)) return
  // Keep the lock outside the archive: wrapped projects must still have a single child directory.
  const lockPath = join(cache, `${relative(cache, root).split(sep)[0]}.dependencies.lock`)
  const deadline = Date.now() + 3 * 180_000
  let lock: FileHandle | undefined
  while (!lock) {
    try {
      lock = await open(lockPath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const pid = Number(await readFile(lockPath, 'utf8'))
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
            throw new Error(`An interrupted dependency installation left ${lockPath}. Remove this file and retry.`, {
              cause: error,
            })
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Another process is installing this agent's dependencies. If it has stopped, remove ${lockPath} and retry.`,
          { cause: error }
        )
      }
      await delay(100)
    }
  }
  try {
    await lock.writeFile(String(process.pid))
    await installDependencies(root, language)
  } finally {
    await lock.close()
    await unlink(lockPath)
  }
}

async function installDependencies(root: string, language: AgentProjectLanguage): Promise<void> {
  const manifests =
    language === 'typescript'
      ? ['package.json', 'package-lock.json', 'npm-shrinkwrap.json']
      : ['requirements.txt', 'pyproject.toml', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json']
  const readManifests = async (): Promise<(string | undefined)[]> => {
    return Promise.all(
      manifests.map(async (name) => {
        try {
          return await readFile(join(root, name), 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          return undefined
        }
      })
    )
  }
  const contents = await readManifests()
  if (contents.every((content) => !content)) return
  const nodeDependencies = Boolean(language === 'typescript' ? contents[0] : contents[2])
  const pythonDependencies = language === 'python' && Boolean(contents[0] || contents[1])
  const npmCommand = contents.slice(-2).some((content) => content !== undefined) ? 'ci' : 'install'
  const fingerprint = createHash('sha256').update(JSON.stringify(contents)).digest('hex')
  const marker = join(root, '.strands-dependencies')
  const python = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  try {
    if ((await readFile(marker, 'utf8')) === fingerprint) {
      if (nodeDependencies) await access(join(root, 'node_modules'))
      if (pythonDependencies) await access(python)
      return
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const options = { cwd: root, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }
  try {
    if (nodeDependencies) {
      const npm = npmInvocation([npmCommand, '--no-audit', '--no-fund'])
      await run(npm.command, npm.args, options)
    }
    if (pythonDependencies) {
      try {
        await access(python)
      } catch {
        await run(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'venv', '.venv'], options)
      }
      await run(
        python,
        ['-m', 'pip', 'install', ...(contents[0] ? ['-r', 'requirements.txt'] : ['.'])],
        // Keep downloads out of exported source; build-isolation subprocesses inherit env, not pip flags.
        { ...options, env: { ...process.env, PIP_NO_CACHE_DIR: '1' } }
      )
    }
    const installed = await readManifests()
    const installedContents = contents.map((content, index) =>
      index >= manifests.length - 2 && content === undefined ? installed[index] : content
    )
    await writeFile(marker, createHash('sha256').update(JSON.stringify(installedContents)).digest('hex'))
  } catch (error) {
    const setup = [
      ...(nodeDependencies ? [`npm ${npmCommand}`] : []),
      ...(pythonDependencies
        ? [
            `python3 -m venv .venv, then ${python} -m pip install ${contents[0] ? '-r requirements.txt' : '.'} with PIP_NO_CACHE_DIR=1 in the environment`,
          ]
        : []),
    ].join(', then ')
    throw new Error(
      `Could not install the agent's dependencies. In ${root}, run ${setup}, then launch Strands again.`,
      {
        cause: error,
      }
    )
  }
}

function archiveProjectRoot(directory: string): string {
  const entries = readdirSync(directory, { withFileTypes: true }).filter(
    (entry) => entry.name !== '__MACOSX' && entry.name !== '.DS_Store'
  )
  const marker = join(directory, AGENT_ENTRYPOINT_FILE)
  if (regularFile(marker)) {
    if (!resolveProjectEntrypoint(directory, readFileSync(marker, 'utf8').trim())) {
      throw new Error(`Invalid ${AGENT_ENTRYPOINT_FILE}: select an existing supported source file inside the project.`)
    }
    return directory
  }
  if (AGENT_ENTRYPOINTS.some((name) => regularFile(join(directory, name)))) {
    return directory
  }
  if (entries.length === 1 && entries[0]!.isDirectory()) {
    return archiveProjectRoot(join(directory, entries[0]!.name))
  }
  throw new Error(
    'The ZIP must contain a project with agent.ts, agent.py, agent/agent.ts, agent/agent.py, ' +
      'or a .strands-entrypoint selecting a .ts, .mts, .js, .mjs, or .py file. Unzip it and choose the source file to load.'
  )
}

export function resolveProjectEntrypoint(root: string, selected: string): string | undefined {
  const target = resolve(root, selected)
  if (
    isAbsolute(selected) ||
    /^[a-z]:/iu.test(selected) ||
    selected.includes('\\') ||
    selected.split('/').includes('..') ||
    !SOURCE_EXTENSION.test(selected) ||
    !regularFile(target)
  ) {
    return undefined
  }
  const entrypoint = realpathSync(target)
  return containsPath(root, entrypoint) ? entrypoint : undefined
}

export function regularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

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
  await prepareDependencies(root, language, lockPath)
}

export const prepareWorkspaceDependencies = async (root: string, language: AgentProjectLanguage): Promise<void> => {
  const state = join(root, '.strands', 'state')
  mkdirSync(state, { recursive: true, mode: 0o700 })
  await prepareDependencies(realpathSync(root), language, join(state, 'dependencies.lock'))
}

const prepareDependencies = async (root: string, language: AgentProjectLanguage, lockPath: string): Promise<void> => {
  const deadline = Date.now() + 3 * 180_000
  const owner = `${process.pid}-${randomUUID()}`
  while (true) {
    try {
      const temporary = mkdtempSync(`${lockPath}-`)
      try {
        writeFileSync(join(temporary, owner), '', { mode: 0o600 })
        // Publish an occupied directory so another process can safely reap an empty one.
        renameSync(temporary, lockPath)
        break
      } finally {
        rmSync(temporary, { recursive: true, force: true })
      }
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw error
      }
      const running = removeStoppedInstallers(lockPath)
      if (!running.length) continue
      if (Date.now() >= deadline) {
        throw new Error(
          `Agent dependency installation is still locked (recorded process IDs: ${running.join(', ')}). ` +
            `Inspect these processes and stop any stalled npm/pip installer and its children. ` +
            `Once no installer is running, remove ${lockPath} and retry.`,
          { cause: error }
        )
      }
      await delay(100)
    }
  }
  try {
    await installDependencies(root, language, lockPath)
  } finally {
    unlinkSync(join(lockPath, owner))
    removeEmptyInstallLock(lockPath)
  }
}

function installerRunning(owner: string): boolean {
  const pid = Number(owner.split('-')[0])
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
    throw error
  }
}

function removeEmptyInstallLock(path: string): void {
  try {
    rmdirSync(path)
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  }
}

function removeStoppedInstallers(path: string): number[] {
  let owners: string[]
  try {
    owners = readdirSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error
    // Older locks did not record installer children, so a dead CLI alone cannot prove they stopped.
    try {
      const owner = readFileSync(path, 'utf8')
      if (installerRunning(owner)) return [Number(owner)]
    } catch (error) {
      if (['ENOENT', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return []
      throw error
    }
    throw new Error(`An older installation left ${path}. Stop any npm or pip installer, remove this file, and retry.`, {
      cause: error,
    })
  }
  const running = owners.filter(installerRunning).map((owner) => Number(owner.split('-')[0]))
  // An old live owner may still be writing dependencies; age alone cannot make its lock safe to remove.
  if (running.length) return running
  if (owners.some((owner) => !/^\d+-[0-9a-f-]{36}$/u.test(owner))) {
    throw new Error(
      `An installation was interrupted while starting. Stop any npm or pip installer, remove ${path}, and retry.`
    )
  }
  // Unique filenames prevent a delayed reaper from deleting a new owner's lock.
  for (const owner of owners) {
    rmSync(join(path, owner), { force: true })
  }
  removeEmptyInstallLock(path)
  return []
}

async function runInstaller(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
  lockPath: string
): Promise<void> {
  const starting = join(lockPath, 'starting')
  writeFileSync(starting, '', { mode: 0o600 })
  await new Promise<void>((resolve, reject) => {
    let failure: Error | null = null
    let child
    try {
      child = spawn(command, args, options)
    } catch (error) {
      unlinkSync(starting)
      reject(error)
      return
    }
    const stop = (error: Error): void => {
      failure ??= error
      child.stdout.destroy()
      child.stderr.destroy()
      child.kill()
    }
    const timeout = setTimeout(() => stop(new Error(`${command} installer timed out after 180 seconds`)), 180_000)
    let stderr = ''
    for (const stream of [child.stdout, child.stderr]) {
      let bytes = 0
      stream.setEncoding('utf8').on('data', (data: string) => {
        bytes += Buffer.byteLength(data)
        if (bytes > 8 * 1024 * 1024) {
          stop(new Error(`${command} installer output exceeded 8 MB`))
        } else if (stream === child.stderr) {
          stderr += data
        }
      })
    }
    child.once('error', (error) => {
      failure ??= error
    })
    const owner = child.pid ? join(lockPath, `${child.pid}-${randomUUID()}`) : undefined
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      try {
        if (owner) rmSync(owner, { force: true })
        if (code !== 0) {
          failure ??= new Error(`Command failed: ${command} ${args.join(' ')} (${signal ?? code})\n${stderr}`)
        }
        if (failure) reject(failure)
        else resolve()
      } catch (error) {
        reject(error)
      }
    })
    try {
      if (owner) writeFileSync(owner, '', { mode: 0o600 })
      unlinkSync(starting)
    } catch (error) {
      // Keep the starting marker if ownership could not be recorded.
      stop(error as Error)
    }
  })
}

async function installDependencies(root: string, language: AgentProjectLanguage, lockPath: string): Promise<void> {
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
  const options = {
    cwd: root,
    // Windows ties non-detached children to the CLI's lifetime, but leaves grandchildren running.
    detached: process.platform === 'win32',
    windowsHide: true,
  }
  try {
    if (nodeDependencies) {
      const npm = npmInvocation([npmCommand, '--no-audit', '--no-fund'])
      await runInstaller(npm.command, npm.args, options, lockPath)
    }
    if (pythonDependencies) {
      try {
        await access(python)
      } catch {
        await runInstaller(
          process.platform === 'win32' ? 'python' : 'python3',
          ['-m', 'venv', '.venv'],
          options,
          lockPath
        )
      }
      await runInstaller(
        python,
        ['-m', 'pip', 'install', ...(contents[0] ? ['-r', 'requirements.txt'] : ['.'])],
        // Keep downloads out of exported source; build-isolation subprocesses inherit env, not pip flags.
        { ...options, env: { ...process.env, PIP_NO_CACHE_DIR: '1' } },
        lockPath
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

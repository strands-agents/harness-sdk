import { constants, type Stats } from 'node:fs'
import { chmod, link, lstat, mkdir, mkdtemp, open, realpath, rm, rmdir, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { containsPath, expandHome } from '../paths.js'
import { assertPortablePathComponent } from '../project/packaging.js'
import { isRecord } from '../values.js'
import { readWorkspaceBinding, type BoundWorkspace } from './binding.js'

export type DevOrigin = { kind: 'cli' | 'discovered' | 'created'; source?: string; version?: string }

export interface DevWorkspaceConfig {
  version: 1
  name: string
  language: 'typescript' | 'python'
  entrypoint: string
  origin: DevOrigin
  harness?: { path: string; version: string }
}

export interface DevWorkspace {
  directory?: string
  root: string
  entrypoint: string
  config: DevWorkspaceConfig
}

const MAX_METADATA_BYTES = 64 * 1024
const MAX_IGNORE_BYTES = 1024 * 1024
const PRIVATE_DIRECTORIES = ['cases', 'state', 'reports']
const IGNORED_PATHS = ['/.strands/state/', '/.strands/reports/']
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

export const boundDevWorkspace = (workspace: BoundWorkspace): DevWorkspace => ({
  directory: workspace.directory,
  root: workspace.agentRoot,
  entrypoint: workspace.entrypoint,
  config: {
    version: 1,
    name: workspace.binding.name,
    language: workspace.binding.agent.language,
    entrypoint: workspace.binding.agent.entrypoint,
    origin: workspace.binding.origin,
    ...(workspace.binding.harness ? { harness: workspace.binding.harness } : {}),
  },
})

export async function readDevWorkspace(root: string): Promise<DevWorkspace | undefined> {
  const binding = await readWorkspaceBinding(root)
  if (binding) return boundDevWorkspace(binding)
  const directory = await workspaceRoot(root, true)
  if (!directory) return undefined
  await validateMetadata(directory)
  const manifest = join(directory, '.strands', 'config.json')
  const details = await optionalDetails(manifest)
  if (!details) return undefined
  let document: unknown
  try {
    document = JSON.parse((await readRegularFile(manifest, details, MAX_METADATA_BYTES)).toString('utf8'))
  } catch (error) {
    throw new Error(
      `Cannot read workspace configuration at ${manifest}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
  if (
    !isRecord(document) ||
    !Object.hasOwn(document, 'origin') ||
    (!Object.hasOwn(document, 'entrypoint') && !Object.hasOwn(document, 'language'))
  )
    return undefined
  let config: DevWorkspaceConfig
  try {
    config = validateConfig(document)
  } catch (error) {
    throw new Error(
      `Invalid workspace configuration at ${manifest}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
  return resolveWorkspace(directory, config)
}

export async function initializeDevWorkspace(root: string, config: DevWorkspaceConfig): Promise<DevWorkspace> {
  const requested = validateConfig(config, true)
  const contents = `${JSON.stringify(requested, null, 2)}\n`
  if (Buffer.byteLength(contents) > MAX_METADATA_BYTES) throw new Error('Workspace config exceeds 65536 bytes.')
  const directory = await workspaceRoot(root)
  const workspace = await resolveWorkspace(directory, requested)
  const existing = await readDevWorkspace(directory)
  if (existing) return matchingWorkspace(existing, workspace)
  const ignore = await readIgnore(directory)
  const created: string[] = []
  const metadata = join(directory, '.strands')
  const manifest = join(metadata, 'config.json')
  let staging: string | undefined
  let complete = false
  try {
    for (const path of [metadata, join(metadata, 'cases'), join(metadata, 'state')]) {
      await privateDirectory(path, created)
    }
    staging = await mkdtemp(join(metadata, '.initialize-'))
    const stagedManifest = join(staging, 'config.json')
    const file = await open(stagedManifest, 'wx', 0o600)
    try {
      await file.writeFile(contents)
      await file.sync()
    } finally {
      await file.close()
    }
    await validateMetadata(directory)
    await resolveWorkspace(directory, requested)
    try {
      await link(stagedManifest, manifest)
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
      const winner = await readDevWorkspace(directory)
      if (!winner) throw error
      complete = true
      return matchingWorkspace(winner, workspace)
    }
    try {
      await appendIgnores(ignore)
    } catch (error) {
      if (sameFile(await lstat(stagedManifest), await optionalDetails(manifest))) await unlink(manifest)
      throw error
    }
    complete = true
    return workspace
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true })
    if (!complete) {
      for (const path of created.reverse()) await rmdir(path).catch(() => undefined)
    }
  }
}

function matchingWorkspace(existing: DevWorkspace, requested: DevWorkspace): DevWorkspace {
  if (existing.entrypoint !== requested.entrypoint) {
    throw new Error(`Workspace ${existing.root} already selects a different entrypoint: ${existing.config.entrypoint}`)
  }
  return existing
}

function validateConfig(value: unknown, normalize = false): DevWorkspaceConfig {
  if (!isRecord(value) || value.version !== 1) throw new Error('Workspace config version must be 1.')
  if (value.language !== 'typescript' && value.language !== 'python') {
    throw new Error('Workspace language must be typescript or python.')
  }
  const name = requiredText(value.name, 'name')
  const entrypoint = relativePath(value.entrypoint, 'entrypoint', normalize)
  const extension = value.language === 'python' ? /\.py$/u : /\.(?:ts|mts|js|mjs)$/u
  if (!extension.test(entrypoint)) throw new Error('Workspace entrypoint extension must match its language.')
  const originValue = value.origin
  if (
    !isRecord(originValue) ||
    typeof originValue.kind !== 'string' ||
    !['cli', 'discovered', 'created'].includes(originValue.kind)
  ) {
    throw new Error('Workspace origin kind must be cli, discovered, or created.')
  }
  const origin: DevOrigin = { kind: originValue.kind as DevOrigin['kind'] }
  if (originValue.source !== undefined) origin.source = requiredText(originValue.source, 'origin.source')
  if (originValue.version !== undefined) origin.version = requiredText(originValue.version, 'origin.version')
  const result: DevWorkspaceConfig = { version: 1, name, language: value.language, entrypoint, origin }
  if (value.harness !== undefined) {
    if (!isRecord(value.harness)) throw new Error('Workspace harness must contain path and version.')
    result.harness = {
      path: relativePath(value.harness.path, 'harness.path', normalize),
      version: requiredText(value.harness.version, 'harness.version'),
    }
  }
  return result
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /\p{Cc}/u.test(value)) {
    throw new Error(`Workspace ${field} must be nonempty text without surrounding whitespace or control characters.`)
  }
  return value
}

function relativePath(value: unknown, field: string, normalize: boolean): string {
  const text = requiredText(value, field)
  const path = normalize ? text.replaceAll('\\', '/') : text
  for (const component of path.split('/')) assertPortablePathComponent(component)
  if (path.split('/').some((component) => component.toLowerCase() === '.git')) {
    throw new Error(`Workspace ${field} cannot refer to .git.`)
  }
  return path
}

async function resolveWorkspace(root: string, config: DevWorkspaceConfig): Promise<DevWorkspace> {
  const entrypoint = await containedPath(root, config.entrypoint, false)
  if (config.harness) await containedPath(root, config.harness.path, true)
  return { root, entrypoint, config }
}

async function containedPath(root: string, path: string, directory: boolean): Promise<string> {
  let candidate = root
  const parts = path.split('/')
  for (const [index, component] of parts.entries()) {
    candidate = join(candidate, component)
    const details = await lstat(candidate)
    assertPathType(candidate, details, index < parts.length - 1 || directory)
  }
  const physical = await realpath(candidate)
  if (!containsPath(root, physical) || physical !== candidate) {
    throw new Error(`Workspace path must resolve inside its root without symbolic links: ${candidate}`)
  }
  return physical
}

async function workspaceRoot(root: string): Promise<string>
async function workspaceRoot(root: string, optional: true): Promise<string | undefined>
async function workspaceRoot(root: string, optional = false): Promise<string | undefined> {
  if (!root.trim()) throw new Error('Workspace root must not be empty.')
  const candidate = resolve(expandHome(root))
  const details = await optionalDetails(candidate)
  if (!details && optional) return undefined
  if (!details) throw new Error(`Workspace root does not exist: ${candidate}`)
  assertPathType(candidate, details, true)
  return realpath(candidate)
}

async function validateMetadata(root: string): Promise<void> {
  const metadata = join(root, '.strands')
  const details = await optionalDetails(metadata)
  if (!details) return
  assertPathType(metadata, details, true)
  if ((await realpath(metadata)) !== metadata) throw new Error(`Workspace metadata path changed: ${metadata}`)
  for (const name of [...PRIVATE_DIRECTORIES, 'config.json']) {
    const path = join(metadata, name)
    const child = await optionalDetails(path)
    if (child) assertPathType(path, child, name !== 'config.json')
  }
}

function assertPathType(path: string, details: Stats, directory: boolean): void {
  if (details.isSymbolicLink() || !(directory ? details.isDirectory() : details.isFile())) {
    throw new Error(
      `Workspace path must be a regular ${directory ? 'directory' : 'file'}, not a symbolic link: ${path}`
    )
  }
}

async function optionalDetails(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined
    throw error
  }
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}

function sameFile(left: Stats, right: Stats | undefined): boolean {
  return right !== undefined && left.dev === right.dev && left.ino === right.ino
}

async function readRegularFile(path: string, expected: Stats, limit: number): Promise<Buffer> {
  assertPathType(path, expected, false)
  const file = await open(path, READ_FLAGS)
  try {
    const details = await file.stat()
    assertPathType(path, details, false)
    if (!sameFile(expected, details) || (await realpath(path)) !== path) {
      throw new Error(`Workspace file changed while opening it: ${path}`)
    }
    return await readBounded(file, limit)
  } finally {
    await file.close()
  }
}

async function readBounded(file: FileHandle, limit: number): Promise<Buffer> {
  if ((await file.stat()).size > limit) throw new Error(`Workspace metadata exceeds ${limit} bytes.`)
  const buffer = Buffer.alloc(limit + 1)
  let length = 0
  while (length < buffer.length) {
    const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
    if (!bytesRead) break
    length += bytesRead
  }
  if (length > limit) throw new Error(`Workspace metadata exceeds ${limit} bytes.`)
  return buffer.subarray(0, length)
}

async function privateDirectory(path: string, created: string[]): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
    created.push(path)
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error
  }
  assertPathType(path, await lstat(path), true)
  if ((await realpath(path)) !== path) throw new Error(`Workspace directory changed: ${path}`)
  await chmod(path, 0o700)
}

interface IgnoreSnapshot {
  path: string
  contents: Buffer
  details: Stats | undefined
}

async function readIgnore(root: string): Promise<IgnoreSnapshot> {
  const path = join(root, '.gitignore')
  const details = await optionalDetails(path)
  if (details && details.nlink !== 1) throw new Error(`Refusing to modify a hard-linked .gitignore: ${path}`)
  const contents = details ? await readRegularFile(path, details, MAX_IGNORE_BYTES) : Buffer.alloc(0)
  return { path, contents, details }
}

async function appendIgnores(snapshot: IgnoreSnapshot): Promise<void> {
  const text = snapshot.contents.toString('utf8')
  const missing = IGNORED_PATHS.filter((path) => !text.split(/\r?\n/u).includes(path))
  if (!missing.length) return
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const separator = text && !text.endsWith('\n') ? newline : ''
  const addition = Buffer.from(`${separator}${missing.join(newline)}${newline}`)
  const creation = snapshot.details ? 0 : constants.O_CREAT | constants.O_EXCL
  const file = await open(
    snapshot.path,
    constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK | creation,
    0o644
  )
  let writing = false
  try {
    const details = await file.stat()
    assertPathType(snapshot.path, details, false)
    if (
      details.nlink !== 1 ||
      (snapshot.details && !sameFile(snapshot.details, details)) ||
      (await realpath(snapshot.path)) !== snapshot.path ||
      !(await readBounded(file, MAX_IGNORE_BYTES)).equals(snapshot.contents)
    ) {
      throw new Error(`The .gitignore changed during workspace initialization: ${snapshot.path}`)
    }
    writing = true
    await file.writeFile(addition)
    await file.sync()
  } catch (error) {
    if (writing) {
      const contents = await readBounded(file, MAX_IGNORE_BYTES + addition.length)
      const appended = contents.subarray(snapshot.contents.length)
      if (
        contents.subarray(0, snapshot.contents.length).equals(snapshot.contents) &&
        addition.subarray(0, appended.length).equals(appended)
      ) {
        await file.truncate(snapshot.contents.length)
        if (!snapshot.details && sameFile(await file.stat(), await optionalDetails(snapshot.path))) {
          await unlink(snapshot.path)
        }
      }
    }
    throw error
  } finally {
    await file.close()
  }
}

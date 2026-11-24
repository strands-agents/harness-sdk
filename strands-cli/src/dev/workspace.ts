import { constants, type Stats } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, open, realpath, rm, rmdir, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from 'node:path'

import { canonicalParentPath, containsPath, expandHome } from '../paths.js'
import { assertPortablePathComponent } from '../project/packaging.js'
import { isRecord } from '../values.js'
import { editFile } from './file-edits.js'

type DevOrigin = { kind: 'cli' | 'discovered' | 'created'; source?: string; version?: string }

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
const PRIVATE_DIRECTORIES = ['cases', 'state', 'reports']
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

export const WORKSPACE_FOLDER = 'strands-dev'
const WORKSPACE_FOLDER_NAME = /^strands-dev(?:-\d+)?$/u

export const isWorkspaceFolderName = (name: string): boolean => WORKSPACE_FOLDER_NAME.test(name)

export const insideWorkspaceFolder = (path: string): boolean =>
  path.split(/[\\/]/u).some((part) => WORKSPACE_FOLDER_NAME.test(part))

export const entrypointWorkspaceFolder = ({ root, entrypoint }: DevWorkspace): string =>
  WORKSPACE_FOLDER_NAME.test(basename(root)) ? root : join(dirname(entrypoint), WORKSPACE_FOLDER)

export async function findDevWorkspace(path: string): Promise<DevWorkspace | undefined> {
  const details = await optionalDetails(join(path, '.config'))
  return details && !details.isFile() ? undefined : readDevWorkspace(path)
}

export const missingAgentPath = async (folder: string, failure: unknown): Promise<string | undefined> => {
  const { code, path } = (failure ?? {}) as Partial<NodeJS.ErrnoException>
  if ((code !== 'ENOENT' && code !== 'ENOTDIR') || path === undefined) return undefined
  const binding = await lstat(join(folder, '.config')).catch(() => undefined)
  return binding?.isFile() ? path : undefined
}

export async function workspaceFolder(path: string): Promise<string> {
  if (WORKSPACE_FOLDER_NAME.test(basename(path)) || !(await isFolderOrMissing(path))) return path
  if ((await optionalDetails(join(path, '.config')))?.isFile()) return path
  return (await findDevWorkspace(path)) ? path : join(path, WORKSPACE_FOLDER)
}

async function isFolderOrMissing(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return dirname(path) === path || isFolderOrMissing(dirname(path))
    if (hasCode(error, 'ENOTDIR')) return false
    throw error
  }
}

export async function readDevWorkspace(root: string): Promise<DevWorkspace | undefined> {
  const binding = await readWorkspaceBinding(root)
  if (binding) return boundDevWorkspace(binding)
  const directory = await workspaceRoot(root)
  if (!directory) return undefined
  await validateMetadata(directory)
  const manifest = join(directory, '.strands', 'config.json')
  const details = await optionalDetails(manifest)
  if (!details) return undefined
  let document: unknown
  try {
    document = JSON.parse((await readLegacyManifest(manifest, details)).toString('utf8'))
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

function validateConfig(value: unknown): DevWorkspaceConfig {
  if (!isRecord(value) || value.version !== 1) throw new Error('Workspace config version must be 1.')
  if (value.language !== 'typescript' && value.language !== 'python') {
    throw new Error('Workspace language must be typescript or python.')
  }
  const name = requiredText(value.name, 'name')
  const entrypoint = relativePath(value.entrypoint, 'entrypoint')
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
      path: relativePath(value.harness.path, 'harness.path'),
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

function relativePath(value: unknown, field: string): string {
  const path = requiredText(value, field)
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

async function workspaceRoot(root: string): Promise<string | undefined> {
  if (!root.trim()) throw new Error('Workspace root must not be empty.')
  const candidate = resolve(expandHome(root))
  const details = await optionalDetails(candidate)
  if (!details) return undefined
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

export async function optionalDetails(path: string): Promise<Stats | undefined> {
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

async function readLegacyManifest(path: string, expected: Stats): Promise<Buffer> {
  assertPathType(path, expected, false)
  const file = await open(path, READ_FLAGS)
  try {
    const details = await file.stat()
    assertPathType(path, details, false)
    if (!sameFile(expected, details) || (await realpath(path)) !== path) {
      throw new Error(`Workspace file changed while opening it: ${path}`)
    }
    return await readBounded(file, MAX_METADATA_BYTES, `Workspace metadata exceeds ${MAX_METADATA_BYTES} bytes.`)
  } finally {
    await file.close()
  }
}

export interface WorkspaceBinding {
  version: 1
  name: string
  agent: { path: string; entrypoint: string; language: 'typescript' | 'python' }
  origin: DevOrigin
  harness?: { path: string; version: string }
  cli?: Record<string, unknown>
}

interface BoundWorkspace {
  directory: string
  agentRoot: string
  entrypoint: string
  binding: WorkspaceBinding
}

const MAX_CONFIG_BYTES = 64 * 1024
const MAX_IGNORE_BYTES = 1024 * 1024
const WORKSPACE_IGNORES = ['/tmp/', '/.config', '/.strands/state/']

export async function readWorkspaceBinding(directory: string): Promise<BoundWorkspace | undefined> {
  const requested = resolve(expandHome(directory))
  if (!(await optionalDetails(requested))) return undefined
  const root = await canonicalParentPath(requested)
  const path = join(root, '.config')
  const details = await optionalDetails(path)
  if (!details) return undefined
  await assertDirectory(root)
  await validateTmp(root)
  const contents = await readRegularFile(path, details, MAX_CONFIG_BYTES)
  return resolveBinding(root, parseBinding(contents.toString('utf8'), path))
}

function parseBinding(contents: string, path: string): WorkspaceBinding {
  let document: unknown
  try {
    document = JSON.parse(contents)
  } catch {
    throw new Error(`Invalid JSON in workspace binding: ${path}`)
  }
  return validateBinding(document, path)
}

export async function bindWorkspace(directory: string, binding: WorkspaceBinding): Promise<BoundWorkspace> {
  const root = await canonicalParentPath(directory)
  const path = join(root, '.config')
  const requested = validateBinding(binding, path)
  await assertDirectory(root)
  await validateTmp(root)
  const resolved = await resolveBinding(root, requested)
  const stored: WorkspaceBinding = {
    ...requested,
    agent: { ...requested.agent, path: storedAgentPath(root, resolved.agentRoot) },
  }
  const workspace = { ...resolved, binding: stored }
  const contents = `${JSON.stringify(stored, null, 2)}\n`
  if (Buffer.byteLength(contents) > MAX_CONFIG_BYTES) throw new Error(`Binding exceeds 65536 bytes: ${path}`)
  const existing = await readWorkspaceBinding(root)
  if (existing) return matchingBinding(existing, workspace)
  const ignorePath = join(root, '.gitignore')
  const ignoreDetails = await optionalDetails(ignorePath)
  if (ignoreDetails && ignoreDetails.nlink !== 1) throw new Error(`Hard-linked metadata is not writable: ${ignorePath}`)
  const ignore = ignoreDetails ? await readRegularFile(ignorePath, ignoreDetails, MAX_IGNORE_BYTES) : Buffer.alloc(0)
  const tmp = join(root, 'tmp')
  let createdTmp = false
  let staging: string | undefined
  let published: Stats | undefined
  let complete = false
  try {
    try {
      await mkdir(tmp, { mode: 0o700 })
      createdTmp = true
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
    }
    await assertDirectory(tmp)
    staging = await mkdtemp(join(root, '.binding-'))
    const stagedPath = join(staging, '.config')
    const file = await open(stagedPath, 'wx', 0o600)
    try {
      await file.writeFile(contents)
      await file.sync()
    } finally {
      await file.close()
    }
    await assertDirectory(root)
    await validateTmp(root)
    await resolveBinding(root, stored)
    try {
      await link(stagedPath, path)
      published = await lstat(stagedPath)
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
      const concurrent = await readWorkspaceBinding(root)
      if (!concurrent) throw new Error(`Workspace binding changed during creation: ${path}`, { cause: error })
      return matchingBinding(concurrent, workspace)
    }
    const temporaryDirectory = await open(tmp, READ_FLAGS | constants.O_DIRECTORY)
    try {
      if (!sameFile(await temporaryDirectory.stat(), await lstat(tmp))) {
        throw new Error(`Workspace temporary directory changed: ${tmp}`)
      }
      if (process.platform !== 'win32') await temporaryDirectory.chmod(0o700)
    } finally {
      await temporaryDirectory.close()
    }
    await appendIgnore(ignorePath, ignoreDetails, ignore)
    complete = true
    return workspace
  } finally {
    if (!complete && published && sameFile(published, await optionalDetails(path))) await unlink(path)
    if (staging) await rm(staging, { recursive: true, force: true })
    if (!complete && createdTmp && !(await optionalDetails(path))) await rmdir(tmp).catch(() => undefined)
  }
}

const storedAgentPath = (directory: string, agentRoot: string): string =>
  relative(directory, agentRoot).split(sep).join('/') || '.'

function validateBinding(value: unknown, path: string): WorkspaceBinding {
  const invalid = (message: string): never => {
    throw new Error(`Invalid workspace binding ${path}: ${message}`)
  }
  const text = (input: unknown, field: string): string => {
    if (typeof input !== 'string' || !input.trim() || /\p{Cc}/u.test(input)) {
      return invalid(`${field} must be nonempty text without control characters.`)
    }
    return input
  }
  if (!isRecord(value)) return invalid('Expected an object.')
  if (value.version !== 1) return invalid(`Unsupported version ${String(value.version)}; expected 1.`)
  const name = text(value.name, 'name')
  if (!isRecord(value.agent)) return invalid('agent must be an object.')
  const agentPath = text(value.agent.path, 'agent.path')
  const entrypoint = text(value.agent.entrypoint, 'agent.entrypoint')
  if (isAbsolute(entrypoint) || win32.isAbsolute(entrypoint) || entrypoint.includes('\\')) {
    return invalid('agent.entrypoint must be a relative path.')
  }
  const language = value.agent.language
  if (language !== 'typescript' && language !== 'python') return invalid('agent.language must be typescript or python.')
  if (!(language === 'python' ? /\.py$/u : /\.(?:ts|mts|js|mjs)$/u).test(entrypoint)) {
    return invalid('agent.entrypoint extension must match agent.language.')
  }
  if (
    !isRecord(value.origin) ||
    typeof value.origin.kind !== 'string' ||
    !['cli', 'discovered', 'created'].includes(value.origin.kind)
  ) {
    return invalid('origin.kind must be cli, discovered, or created.')
  }
  const origin: DevOrigin = { kind: value.origin.kind as DevOrigin['kind'] }
  if (value.origin.source !== undefined) origin.source = text(value.origin.source, 'origin.source')
  if (value.origin.version !== undefined) origin.version = text(value.origin.version, 'origin.version')
  const result: WorkspaceBinding = { version: 1, name, agent: { path: agentPath, entrypoint, language }, origin }
  if (value.harness !== undefined) {
    if (!isRecord(value.harness)) return invalid('harness must be an object.')
    result.harness = {
      path: text(value.harness.path, 'harness.path'),
      version: text(value.harness.version, 'harness.version'),
    }
  }
  if (value.cli !== undefined) {
    if (!isRecord(value.cli)) return invalid('cli must be an object.')
    result.cli = value.cli
  }
  return result
}

export async function updateWorkspaceCli(directory: string, cli: Record<string, unknown>): Promise<void> {
  const root = await canonicalParentPath(directory)
  const path = join(root, '.config')
  await editFile(root, path, (contents) => {
    if (Buffer.byteLength(contents) > MAX_CONFIG_BYTES)
      throw new Error(`File exceeds ${MAX_CONFIG_BYTES} bytes: ${path}`)
    const { cli: _previous, ...binding } = parseBinding(contents, path)
    const next = `${JSON.stringify(Object.keys(cli).length ? { ...binding, cli } : binding, null, 2)}\n`
    if (Buffer.byteLength(next) > MAX_CONFIG_BYTES) throw new Error(`Binding exceeds 65536 bytes: ${path}`)
    return next
  })
}

async function resolveBinding(directory: string, binding: WorkspaceBinding): Promise<BoundWorkspace> {
  const requestedRoot = resolve(directory, binding.agent.path)
  const requestedEntrypoint = resolve(requestedRoot, binding.agent.entrypoint)
  const tmp = join(directory, 'tmp')
  if (containsPath(tmp, requestedRoot) || containsPath(tmp, requestedEntrypoint)) {
    throw new Error(`Workspace binding cannot target temporary files under ${tmp}`)
  }
  if (!containsPath(requestedRoot, requestedEntrypoint))
    throw new Error(`Agent entrypoint must stay inside ${requestedRoot}: ${requestedEntrypoint}`)
  await assertDirectory(requestedRoot)
  const agentRoot = await realpath(requestedRoot)
  const entrypoint = resolve(agentRoot, binding.agent.entrypoint)
  await assertDirectory(parse(entrypoint).dir)
  assertType(entrypoint, await lstat(entrypoint), false)
  if ((await realpath(entrypoint)) !== entrypoint) throw new Error(`Agent entrypoint path changed: ${entrypoint}`)
  return { directory, agentRoot, entrypoint, binding }
}

function matchingBinding(existing: BoundWorkspace, requested: BoundWorkspace): BoundWorkspace {
  if (
    existing.agentRoot !== requested.agentRoot ||
    existing.entrypoint !== requested.entrypoint ||
    existing.binding.agent.language !== requested.binding.agent.language
  ) {
    throw new Error(`Workspace already binds a different agent: ${join(existing.directory, '.config')}`)
  }
  return existing
}

async function assertDirectory(path: string): Promise<void> {
  let current = parse(path).root
  for (const component of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component)
    assertType(current, await lstat(current), true)
  }
}

async function validateTmp(root: string): Promise<void> {
  const path = join(root, 'tmp')
  const details = await optionalDetails(path)
  if (details) assertType(path, details, true)
}

function assertType(path: string, details: Stats, directory: boolean): void {
  if (details.isSymbolicLink() || !(directory ? details.isDirectory() : details.isFile())) {
    throw new Error(`Expected a regular ${directory ? 'directory' : 'file'}, not a symbolic link: ${path}`)
  }
}

async function readRegularFile(path: string, expected: Stats, limit: number): Promise<Buffer> {
  assertType(path, expected, false)
  const file = await open(path, READ_FLAGS)
  try {
    assertType(path, await file.stat(), false)
    if (!sameFile(expected, await file.stat()) || (await realpath(path)) !== path) {
      throw new Error(`Workspace metadata changed: ${path}`)
    }
    return await readBounded(file, limit, fileTooLarge(limit, path))
  } finally {
    await file.close()
  }
}

const fileTooLarge = (limit: number, path: string): string => `File exceeds ${limit} bytes: ${path}`

export async function readBounded(file: FileHandle, limit: number, tooLarge: string): Promise<Buffer> {
  if ((await file.stat()).size > limit) throw new Error(tooLarge)
  const buffer = Buffer.alloc(limit + 1)
  let length = 0
  while (length < buffer.length) {
    const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
    if (!bytesRead) break
    length += bytesRead
  }
  if (length > limit) throw new Error(tooLarge)
  return buffer.subarray(0, length)
}

const restoreIgnoreLength = async (file: FileHandle, path: string, length: number): Promise<void> => {
  if (process.platform !== 'win32') return file.truncate(length)
  const writable = await open(path, constants.O_RDWR)
  try {
    if (!sameFile(await file.stat(), await writable.stat())) {
      throw new Error(`The .gitignore changed during workspace initialization: ${path}`)
    }
    await writable.truncate(length)
  } finally {
    await writable.close()
  }
}

async function appendIgnore(path: string, expected: Stats | undefined, contents: Buffer): Promise<void> {
  const text = contents.toString('utf8')
  const lines = new Set(text.split(/\r?\n/u))
  const missing = WORKSPACE_IGNORES.filter((line) => !lines.has(line))
  if (!missing.length) return
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const addition = Buffer.from(`${text && !text.endsWith('\n') ? newline : ''}${missing.join(newline)}${newline}`)
  const creation = expected ? 0 : constants.O_CREAT | constants.O_EXCL
  const file = await open(
    path,
    constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK | creation,
    0o644
  )
  let writing = false
  try {
    const details = await file.stat()
    assertType(path, details, false)
    if (
      details.nlink !== 1 ||
      (expected && !sameFile(expected, details)) ||
      (await realpath(path)) !== path ||
      !(await readBounded(file, MAX_IGNORE_BYTES, fileTooLarge(MAX_IGNORE_BYTES, path))).equals(contents)
    ) {
      throw new Error(`Workspace ignore file changed: ${path}`)
    }
    writing = true
    await file.writeFile(addition)
    await file.sync()
  } catch (error) {
    if (writing) {
      const limit = MAX_IGNORE_BYTES + addition.length
      const current = await readBounded(file, limit, fileTooLarge(limit, path))
      if (
        current.subarray(0, contents.length).equals(contents) &&
        addition.subarray(0, current.length - contents.length).equals(current.subarray(contents.length))
      ) {
        await restoreIgnoreLength(file, path, contents.length)
      }
    }
    if (!expected && sameFile(await file.stat(), await optionalDetails(path))) await unlink(path)
    throw error
  } finally {
    await file.close()
  }
}

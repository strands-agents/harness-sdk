import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

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

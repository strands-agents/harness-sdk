import { constants, type Stats } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, open, realpath, rm, rmdir, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, join, parse, resolve, sep, win32 } from 'node:path'

import { canonicalParentPath, containsPath, expandHome } from '../paths.js'
import { isRecord } from '../values.js'

export interface WorkspaceBinding {
  version: 1
  name: string
  agent: { path: string; entrypoint: string; language: 'typescript' | 'python' }
  origin: { kind: 'cli' | 'discovered' | 'created'; source?: string; version?: string }
  harness?: { path: string; version: string }
}

export interface BoundWorkspace {
  directory: string
  agentRoot: string
  entrypoint: string
  binding: WorkspaceBinding
}

const MAX_CONFIG_BYTES = 64 * 1024
const MAX_IGNORE_BYTES = 1024 * 1024
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

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
  let document: unknown
  try {
    document = JSON.parse(contents.toString('utf8'))
  } catch {
    throw new Error(`Invalid JSON in workspace binding: ${path}`)
  }
  return resolveBinding(root, validateBinding(document, path))
}

export async function bindWorkspace(directory: string, binding: WorkspaceBinding): Promise<BoundWorkspace> {
  const root = await canonicalParentPath(directory)
  const path = join(root, '.config')
  const requested = validateBinding(binding, path)
  const contents = `${JSON.stringify(requested, null, 2)}\n`
  if (Buffer.byteLength(contents) > MAX_CONFIG_BYTES) throw new Error(`Binding exceeds 65536 bytes: ${path}`)
  await assertDirectory(root)
  await validateTmp(root)
  const workspace = await resolveBinding(root, requested)
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
    await resolveBinding(root, requested)
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
      await temporaryDirectory.chmod(0o700)
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
  const origin: WorkspaceBinding['origin'] = { kind: value.origin.kind as WorkspaceBinding['origin']['kind'] }
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
  return result
}

async function resolveBinding(directory: string, binding: WorkspaceBinding): Promise<BoundWorkspace> {
  const agentRoot = resolve(directory, binding.agent.path)
  const entrypoint = resolve(agentRoot, binding.agent.entrypoint)
  const tmp = join(directory, 'tmp')
  if (containsPath(tmp, agentRoot) || containsPath(tmp, entrypoint)) {
    throw new Error(`Workspace binding cannot target temporary files under ${tmp}`)
  }
  if (!containsPath(agentRoot, entrypoint))
    throw new Error(`Agent entrypoint must stay inside ${agentRoot}: ${entrypoint}`)
  await assertDirectory(agentRoot)
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
  assertType(path, expected, false)
  const file = await open(path, READ_FLAGS)
  try {
    assertType(path, await file.stat(), false)
    if (!sameFile(expected, await file.stat()) || (await realpath(path)) !== path) {
      throw new Error(`Workspace metadata changed: ${path}`)
    }
    return await readBounded(file, limit, path)
  } finally {
    await file.close()
  }
}

async function readBounded(file: FileHandle, limit: number, path: string): Promise<Buffer> {
  if ((await file.stat()).size > limit) throw new Error(`File exceeds ${limit} bytes: ${path}`)
  const buffer = Buffer.alloc(limit + 1)
  let length = 0
  while (length < buffer.length) {
    const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
    if (!bytesRead) break
    length += bytesRead
  }
  if (length > limit) throw new Error(`File exceeds ${limit} bytes: ${path}`)
  return buffer.subarray(0, length)
}

async function appendIgnore(path: string, expected: Stats | undefined, contents: Buffer): Promise<void> {
  const text = contents.toString('utf8')
  if (text.split(/\r?\n/u).includes('/tmp/')) return
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const addition = Buffer.from(`${text && !text.endsWith('\n') ? newline : ''}/tmp/${newline}`)
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
      !(await readBounded(file, MAX_IGNORE_BYTES, path)).equals(contents)
    ) {
      throw new Error(`Workspace ignore file changed: ${path}`)
    }
    writing = true
    await file.writeFile(addition)
    await file.sync()
  } catch (error) {
    if (writing) {
      const current = await readBounded(file, MAX_IGNORE_BYTES + addition.length, path)
      if (
        current.subarray(0, contents.length).equals(contents) &&
        addition.subarray(0, current.length - contents.length).equals(current.subarray(contents.length))
      ) {
        await file.truncate(contents.length)
      }
    }
    if (!expected && sameFile(await file.stat(), await optionalDetails(path))) await unlink(path)
    throw error
  } finally {
    await file.close()
  }
}

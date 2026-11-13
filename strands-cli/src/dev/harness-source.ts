import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { crc32, inflateRawSync } from 'node:zlib'
import { unzipSync, type UnzipFileInfo } from 'fflate'
import { valid } from 'semver'

import { containsPath } from '../paths.js'
import { assertPortablePathComponent } from '../project/packaging.js'
import { isRecord } from '../values.js'

export interface HarnessSource {
  path: string
  version: string
  digest: string
}

interface SourceSnapshot {
  files: Map<string, Uint8Array>
  bytes: number
}

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
const MAX_SOURCE_BYTES = 10 * 1024 * 1024
const MAX_SOURCE_ENTRIES = 10_000
const EXCLUDED_DIRECTORIES = new Set(['node_modules', '.git'])
const REQUIRED_SOURCE_FILES = ['src/index.ts', 'src/tsconfig.json', 'tsconfig.base.json']

export async function copyHarnessSource(
  destination: string,
  options: { packageRoot?: string; fetch?: typeof globalThis.fetch } = {}
): Promise<HarnessSource> {
  const target = resolve(destination)
  let created = false
  try {
    await mkdir(target, { mode: 0o700 })
    created = true
    const root = await realpath(options.packageRoot ?? (await installedPackageRoot()))
    if (containsPath(root, await realpath(target))) {
      throw new Error('The harness source destination must be outside the installed package.')
    }
    const manifest = await regularFileContents(join(root, 'package.json'))
    const version = manifestVersion(manifest)
    const installedSource = await existingDetails(join(root, 'src'))
    const snapshot = installedSource
      ? await installedSourceSnapshot(root)
      : archiveSourceSnapshot(await fetchSourceArchive(version, options.fetch ?? globalThis.fetch))
    for (const name of REQUIRED_SOURCE_FILES) {
      if (!snapshot.files.has(name)) {
        throw new Error(`No complete TypeScript source for @strands-agents/harness@${version}: missing ${name}.`)
      }
    }
    snapshot.files.set('package.json', manifest)
    for (const [name, contents] of snapshot.files) {
      await writeIndependentFile(target, name, contents)
    }
    for (const name of ['LICENSE', 'NOTICE']) {
      await writeIndependentFile(target, name, await regularFileContents(join(root, name)))
    }
    for (const name of ['README.md', 'dist']) {
      if (await existingDetails(join(root, name))) await copyInstalledTree(root, target, name)
    }
    return { path: target, version, digest: sourceDigest(snapshot.files) }
  } catch (error) {
    if (created) await rm(target, { recursive: true, force: true })
    if (!created && isRecord(error) && error.code === 'EEXIST') {
      throw new Error(`Harness source destination already exists: ${target}.`, { cause: error })
    }
    throw new Error(`Unable to copy harness source to ${target}: ${errorMessage(error)}`, { cause: error })
  }
}

async function installedPackageRoot(): Promise<string> {
  const entrypoint = createRequire(import.meta.url).resolve('@strands-agents/harness')
  let candidate = dirname(entrypoint)
  for (;;) {
    if (await existingDetails(join(candidate, 'package.json'))) return candidate
    const parent = dirname(candidate)
    if (parent === candidate) throw new Error(`Unable to locate the harness package containing ${entrypoint}.`)
    candidate = parent
  }
}

function manifestVersion(contents: Uint8Array): string {
  const manifest: unknown = JSON.parse(Buffer.from(contents).toString('utf8'))
  if (
    !isRecord(manifest) ||
    manifest.name !== '@strands-agents/harness' ||
    typeof manifest.version !== 'string' ||
    !manifest.version.trim()
  ) {
    throw new Error('The installed package.json must identify @strands-agents/harness and its exact version.')
  }
  return manifest.version
}

async function existingDetails(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined
    throw error
  }
}

function assertSupportedFile(
  path: string,
  details: Stats | undefined,
  directoryAllowed = false
): asserts details is Stats {
  if (!details?.isFile() && !(directoryAllowed && details?.isDirectory())) {
    throw new Error(
      `Harness source requires a regular ${directoryAllowed ? 'file or directory' : 'file'}: ${path}. Symbolic links and special files are not supported.`
    )
  }
}

async function regularFileContents(path: string): Promise<Buffer> {
  assertSupportedFile(path, await existingDetails(path))
  return readFile(path)
}

async function installedSourceSnapshot(root: string): Promise<SourceSnapshot> {
  const snapshot: SourceSnapshot = { files: new Map(), bytes: 0 }
  const details = await lstat(join(root, 'src'))
  if (!details.isDirectory())
    throw new Error('The installed harness src must be a directory, not a symbolic link or file.')
  await readInstalledSource(root, 'src', snapshot)
  await readInstalledSource(root, 'tsconfig.base.json', snapshot)
  if (await existingDetails(join(root, 'tsconfig.json'))) await readInstalledSource(root, 'tsconfig.json', snapshot)
  return snapshot
}

async function readInstalledSource(root: string, name: string, snapshot: SourceSnapshot): Promise<void> {
  const path = join(root, name)
  const details = await existingDetails(path)
  assertSupportedFile(path, details, name === 'src' || name.startsWith('src/'))
  if (details.isDirectory()) {
    for (const child of await includedChildren(path)) {
      await readInstalledSource(root, `${name}/${child}`, snapshot)
    }
    return
  }
  assertSourceSize(snapshot.bytes + details.size, snapshot.files.size + 1)
  addSourceFile(snapshot, name, await readFile(path))
}

async function includedChildren(path: string): Promise<string[]> {
  const children = (await readdir(path)).filter((name) => !EXCLUDED_DIRECTORIES.has(name)).sort()
  for (const name of children) assertPortablePathComponent(name)
  return children
}

function assertSourceSize(bytes: number, entries: number): void {
  if (bytes > MAX_SOURCE_BYTES || entries > MAX_SOURCE_ENTRIES) {
    throw new Error('The harness TypeScript source exceeds 10 MB or 10,000 entries.')
  }
}

function addSourceFile(snapshot: SourceSnapshot, name: string, contents: Uint8Array): void {
  assertSourceSize(snapshot.bytes + contents.byteLength, snapshot.files.size + 1)
  snapshot.bytes += contents.byteLength
  snapshot.files.set(name, contents)
}

async function copyInstalledTree(root: string, destination: string, name: string): Promise<void> {
  const path = join(root, name)
  const details = await lstat(path)
  assertSupportedFile(path, details, name === 'dist' || name.startsWith('dist/'))
  if (name === 'dist' && !details.isDirectory()) throw new Error('The installed harness dist must be a directory.')
  if (details.isDirectory()) {
    await mkdir(join(destination, name), { recursive: true })
    for (const child of await includedChildren(path)) {
      await copyInstalledTree(root, destination, `${name}/${child}`)
    }
    return
  }
  await writeIndependentFile(destination, name, await readFile(path))
}

async function writeIndependentFile(destination: string, name: string, contents: Uint8Array): Promise<void> {
  for (const component of name.split('/')) assertPortablePathComponent(component)
  const path = join(destination, name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, { flag: 'wx' })
}

function sourceDigest(files: Map<string, Uint8Array>): string {
  const hash = createHash('sha256')
  for (const name of [...files.keys()].sort()) {
    const contents = files.get(name)!
    hash.update(name).update('\0').update(String(contents.byteLength)).update('\0').update(contents)
  }
  return hash.digest('hex')
}

async function fetchSourceArchive(version: string, fetch: typeof globalThis.fetch): Promise<Buffer> {
  if (!/^\d+\.\d+\.\d+$/u.test(version) || valid(version) !== version) {
    throw new Error(
      `No installed TypeScript source for @strands-agents/harness@${version}. Source downloads require an exact numeric public release version.`
    )
  }
  const url = `https://codeload.github.com/strands-agents/harness-sdk/zip/refs/tags/harness-typescript/v${version}`
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) })
    if (!response.ok || response.redirected) {
      await response.body?.cancel()
      throw new Error(`HTTP ${response.status}; a matching release archive is required.`)
    }
    return await boundedArchiveResponse(response)
  } catch (error) {
    throw new Error(
      `Unable to fetch TypeScript source for @strands-agents/harness@${version} from ${url}: ${errorMessage(error)}`,
      { cause: error }
    )
  }
}

async function boundedArchiveResponse(response: Awaited<ReturnType<typeof globalThis.fetch>>): Promise<Buffer> {
  if (!response.body) throw new Error('The source archive response has no body.')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    if (Number(response.headers.get('content-length')) > MAX_ARCHIVE_BYTES) {
      throw new Error('The harness source archive exceeds 50 MB.')
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_ARCHIVE_BYTES) throw new Error('The harness source archive exceeds 50 MB.')
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, bytes)
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}

function archiveSourceSnapshot(archive: Buffer): SourceSnapshot {
  try {
    const directory = archiveDirectory(archive)
    let offset = directory.start
    let bytes = 0
    let root: string | undefined
    const names = new Set<string>()
    const selected = new Map<string, string>()
    const extracted = unzipSync(archive, {
      filter: (entry) => {
        const header = offset
        offset = nextArchiveHeader(archive, header, directory.end)
        const name = archiveSourcePath(entry.name)
        if (name === undefined) return false
        const entryRoot = entry.name.split('/')[0]!
        if (root !== undefined && root !== entryRoot)
          throw new Error('The archive contains multiple harness source roots.')
        root = entryRoot
        const key = name.toLowerCase()
        if (names.has(key)) throw new Error(`Duplicate harness source path: ${entry.name}.`)
        names.add(key)
        assertArchiveFileType(archive, header, entry)
        const compressed = archiveEntryData(archive, header, directory.start, entry)
        bytes += entry.originalSize
        assertSourceSize(bytes, names.size)
        const contents =
          entry.compression === 0
            ? compressed
            : inflateRawSync(compressed, { maxOutputLength: Math.max(entry.originalSize, 1) })
        if (contents.byteLength !== entry.originalSize || crc32(contents) !== archive.readUInt32LE(header + 16)) {
          throw new Error(`Invalid source size or checksum: ${entry.name}.`)
        }
        if (entry.name.endsWith('/')) return false
        selected.set(entry.name, name)
        return true
      },
    })
    if (offset !== directory.end) throw new Error('The archive central directory is inconsistent.')
    const snapshot: SourceSnapshot = { files: new Map(), bytes: 0 }
    for (const [entry, name] of selected) {
      const contents = extracted[entry]
      if (!contents) throw new Error(`Missing archive entry: ${entry}.`)
      addSourceFile(snapshot, name, contents)
    }
    return snapshot
  } catch (error) {
    throw new Error(`Invalid harness source ZIP: ${errorMessage(error)}`, { cause: error })
  }
}

function archiveDirectory(archive: Buffer): { start: number; end: number } {
  const minimum = Math.max(0, archive.length - 65_557)
  for (let end = archive.length - 22; end >= minimum; end--) {
    if (archive.readUInt32LE(end) !== 0x06054b50) continue
    const start = archive.readUInt32LE(end + 16)
    if (
      end + 22 + archive.readUInt16LE(end + 20) !== archive.length ||
      archive.readUInt16LE(end + 4) !== 0 ||
      archive.readUInt16LE(end + 6) !== 0 ||
      archive.readUInt16LE(end + 8) !== archive.readUInt16LE(end + 10) ||
      archive.readUInt16LE(end + 10) === 0xffff ||
      start + archive.readUInt32LE(end + 12) !== end ||
      (end >= 20 && archive.readUInt32LE(end - 20) === 0x07064b50)
    ) {
      throw new Error('Unsupported or invalid ZIP central directory.')
    }
    return { start, end }
  }
  throw new Error('The archive is missing its ZIP central directory.')
}

function nextArchiveHeader(archive: Buffer, offset: number, end: number): number {
  if (offset + 46 > end || archive.readUInt32LE(offset) !== 0x02014b50) {
    throw new Error('Invalid ZIP file header.')
  }
  const next =
    offset +
    46 +
    archive.readUInt16LE(offset + 28) +
    archive.readUInt16LE(offset + 30) +
    archive.readUInt16LE(offset + 32)
  if (next > end || archive.readUInt16LE(offset + 34) !== 0) throw new Error('Invalid ZIP file header length or disk.')
  return next
}

function archiveSourcePath(name: string): string | undefined {
  const parts = name.replace(/\/$/u, '').split('/')
  if (
    name.includes('\\') ||
    parts.some((part) => !part || part === '.' || part === '..' || part.includes(':')) ||
    [...name].some((character) => (character.codePointAt(0) ?? 0) < 32)
  ) {
    throw new Error(`Unsafe path in harness source ZIP: ${JSON.stringify(name)}.`)
  }
  if (parts[1] !== 'harness-ts') return undefined
  const relative = parts.slice(2)
  if (relative.some((part) => EXCLUDED_DIRECTORIES.has(part))) return undefined
  if (
    relative[0] !== 'src' &&
    !(relative.length === 1 && ['tsconfig.base.json', 'tsconfig.json'].includes(relative[0]!))
  ) {
    return undefined
  }
  for (const part of parts) assertPortablePathComponent(part)
  return relative.join('/')
}

function assertArchiveFileType(archive: Buffer, header: number, entry: UnzipFileInfo): void {
  const attributes = archive.readUInt32LE(header + 38)
  const type = (attributes >>> 16) & 0o170000
  const directory = entry.name.endsWith('/')
  if (type === 0o120000) throw new Error(`Symbolic links are not supported in harness source: ${entry.name}.`)
  if (
    (type !== 0 && type !== (directory ? 0o040000 : 0o100000)) ||
    (!directory && (attributes & 0x10) !== 0) ||
    (attributes & 0x08) !== 0 ||
    (directory && entry.originalSize !== 0) ||
    (archive.readUInt16LE(header + 8) & ~0x080e) !== 0 ||
    ![0, 8].includes(entry.compression)
  ) {
    throw new Error(`Unsupported harness source archive entry type: ${entry.name}.`)
  }
}

function archiveEntryData(archive: Buffer, header: number, directoryStart: number, entry: UnzipFileInfo): Buffer {
  const local = archive.readUInt32LE(header + 42)
  if (local + 30 > directoryStart || archive.readUInt32LE(local) !== 0x04034b50) {
    throw new Error(`Invalid local ZIP header: ${entry.name}.`)
  }
  const nameLength = archive.readUInt16LE(local + 26)
  const start = local + 30 + nameLength + archive.readUInt16LE(local + 28)
  const flags = archive.readUInt16LE(header + 8)
  if (
    start + entry.size > directoryStart ||
    flags !== archive.readUInt16LE(local + 6) ||
    entry.compression !== archive.readUInt16LE(local + 8) ||
    !archive
      .subarray(local + 30, local + 30 + nameLength)
      .equals(archive.subarray(header + 46, header + 46 + archive.readUInt16LE(header + 28)))
  ) {
    throw new Error(`The local and central ZIP headers disagree: ${entry.name}.`)
  }
  if (
    (flags & 8) === 0 &&
    (archive.readUInt32LE(local + 14) !== archive.readUInt32LE(header + 16) ||
      archive.readUInt32LE(local + 18) !== entry.size ||
      archive.readUInt32LE(local + 22) !== entry.originalSize)
  ) {
    throw new Error(`The local and central ZIP sizes or checksums disagree: ${entry.name}.`)
  }
  return archive.subarray(start, start + entry.size)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

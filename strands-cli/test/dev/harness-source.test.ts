import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { zipSync, type Zippable, type ZipOptions } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { copyHarnessSource } from '../../src/dev/harness-source.js'

const resolveHarnessEntrypoint = vi.hoisted(() => vi.fn<(specifier: string) => string>())
vi.mock('node:module', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:module')>()),
  createRequire: () => ({ resolve: resolveHarnessEntrypoint }),
}))

const ARCHIVE_ROOT = 'harness-sdk-harness-typescript-v0.3.4'
const SOURCE_FILES: Record<string, string> = {
  'src/index.ts': 'export const harnessVersion = "0.3.4"\n',
  'src/internal.ts': 'export const internal = true\n',
  'src/tsconfig.json':
    '{"extends":"../tsconfig.base.json","compilerOptions":{"rootDir":"..","outDir":"../dist"},"include":["**/*.ts"]}\n',
  'tsconfig.base.json': '{"compilerOptions":{"target":"ES2022","module":"NodeNext","declaration":true}}\n',
}
const RELEASE_FILES = {
  LICENSE: 'Apache License\nVersion 2.0\n',
  NOTICE: 'Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.\n',
  'README.md': '# Installed harness\n',
  'dist/src/index.js': 'export const harnessVersion = "0.3.4";\n',
  'dist/src/index.d.ts': 'export declare const harnessVersion = "0.3.4";\n',
  'dist/src/index.js.map': '{"version":3,"sources":["../../src/index.ts"]}\n',
}

let temporary: string
let packageRoot: string
let destination: string
const fetch = vi.fn<typeof globalThis.fetch>()

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'strands-harness-source-'))
  packageRoot = join(temporary, 'installed')
  destination = join(temporary, 'copy')
  resolveHarnessEntrypoint.mockReset()
  resolveHarnessEntrypoint.mockReturnValue(join(packageRoot, 'dist/src/index.js'))
  fetch.mockReset()
  fetch.mockRejectedValue(new Error('Unexpected network request'))
  vi.stubGlobal('fetch', fetch)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(temporary, { recursive: true, force: true })
})

async function writeFiles(root: string, files: Record<string, string | Uint8Array>) {
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true })
    await writeFile(join(root, name), contents)
  }
}

function manifest(version: unknown = '0.3.4') {
  return {
    name: '@strands-agents/harness',
    version,
    type: 'module',
    main: 'dist/src/index.js',
    exports: {
      '.': { types: './dist/src/index.d.ts', default: './dist/src/index.js' },
      './internal': { default: './dist/src/internal.js' },
    },
    scripts: { build: 'tsc --project src/tsconfig.json' },
    dependencies: { zod: '^4.1.12', tsx: '^4.23.13' },
    devDependencies: { typescript: '^6.0.3' },
    peerDependencies: { '@strands-agents/sdk': '>=1.19.0 <2.0.0' },
    repository: { url: 'https://untrusted.invalid/not-the-source', directory: '../elsewhere' },
  }
}

async function installPackage(withSource = false, version: unknown = '0.3.4') {
  await writeFiles(packageRoot, {
    'package.json': `${JSON.stringify(manifest(version), null, 2)}\n`,
    ...RELEASE_FILES,
    ...(withSource ? SOURCE_FILES : {}),
  })
}

function releaseArchive(
  files: Record<string, string | Uint8Array> = SOURCE_FILES,
  extra: Zippable = {},
  options: ZipOptions = {}
) {
  const entries: Zippable = Object.fromEntries(
    Object.entries(files).map(([name, contents]) => [
      `${ARCHIVE_ROOT}/harness-ts/${name}`,
      typeof contents === 'string' ? Buffer.from(contents) : contents,
    ])
  )
  return Buffer.from(zipSync({ ...entries, ...extra }, options))
}

function serveArchive(archive = releaseArchive()) {
  fetch.mockResolvedValue(new globalThis.Response(archive))
}

async function fileNames(root: string, parent = ''): Promise<string[]> {
  const files: string[] = []
  for (const name of (await readdir(join(root, parent))).sort()) {
    const relative = parent ? `${parent}/${name}` : name
    const details = await lstat(join(root, relative))
    expect(details.isSymbolicLink()).toBe(false)
    if (details.isDirectory()) files.push(...(await fileNames(root, relative)))
    else {
      expect(details.isFile()).toBe(true)
      files.push(relative)
    }
  }
  return files.sort()
}

function archiveHeader(archive: Buffer, name: string) {
  let offset = archive.readUInt32LE(archive.length - 6)
  while (archive.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = archive.readUInt16LE(offset + 28)
    if (archive.subarray(offset + 46, offset + 46 + nameLength).toString() === name) return offset
    offset += 46 + nameLength + archive.readUInt16LE(offset + 30) + archive.readUInt16LE(offset + 32)
  }
  throw new Error(`Missing fixture entry: ${name}`)
}

async function expectCleanFailure(pattern: RegExp) {
  await expect(copyHarnessSource(destination, { packageRoot, fetch })).rejects.toThrow(pattern)
  await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).name).toBe('@strands-agents/harness')
}

describe('copyHarnessSource', () => {
  it.each(['0.3.4', '0.0.1-development'])(
    'shouldCopySourceOfflineWhenInstalledPackageContainsTypeScriptAtVersion %s',
    async (version) => {
      await installPackage(true, version)
      await writeFiles(packageRoot, {
        'tsconfig.json': '{"extends":"./tsconfig.base.json"}\n',
        'node_modules/ignored/index.js': 'not copied',
        'src/node_modules/ignored/index.ts': 'not copied',
        'src/.git/config': 'not copied',
        'dist/node_modules/ignored/index.js': 'not copied',
        'test/not-source.ts': 'not copied',
      })

      const copied = await copyHarnessSource(destination, { packageRoot })

      expect(copied).toEqual({ path: destination, version, digest: expect.stringMatching(/^[a-f0-9]{64}$/u) })
      expect(fetch).not.toHaveBeenCalled()
      expect(await fileNames(destination)).toEqual(
        [...Object.keys(SOURCE_FILES), ...Object.keys(RELEASE_FILES), 'package.json', 'tsconfig.json'].sort()
      )
      for (const name of await fileNames(destination)) {
        expect(await readFile(join(destination, name))).toEqual(await readFile(join(packageRoot, name)))
      }
    }
  )

  it.each(['installed', 'archive'] as const)(
    'shouldKeepCopiesIndependentWhenSourceAndDistAreEditedAfterCopyingFrom %s',
    async (source) => {
      await installPackage(source === 'installed')
      if (source === 'archive') serveArchive()
      await link(join(packageRoot, 'dist/src/index.js'), join(packageRoot, 'dist/src/hard-link.js'))
      const copied = await copyHarnessSource(destination, { packageRoot, fetch })
      await writeFile(join(destination, 'src/index.ts'), 'export const edited = true\n')
      await writeFile(join(destination, 'dist/src/index.js'), 'export const edited = true;\n')
      await writeFile(join(destination, 'dist/src/hard-link.js'), 'independent hard link')
      await writeFile(join(destination, 'LICENSE'), 'independent license')

      expect(await readFile(join(packageRoot, 'dist/src/index.js'), 'utf8')).toBe(RELEASE_FILES['dist/src/index.js'])
      expect(await readFile(join(packageRoot, 'dist/src/hard-link.js'), 'utf8')).toBe(
        RELEASE_FILES['dist/src/index.js']
      )
      expect(await readFile(join(packageRoot, 'LICENSE'), 'utf8')).toBe(RELEASE_FILES.LICENSE)
      if (source === 'installed') {
        expect(await readFile(join(packageRoot, 'src/index.ts'), 'utf8')).toBe(SOURCE_FILES['src/index.ts'])
        await writeFile(join(packageRoot, 'src/internal.ts'), 'export const changed = true\n')
        expect(await readFile(join(destination, 'src/internal.ts'), 'utf8')).toBe(SOURCE_FILES['src/internal.ts'])
      }
      expect(copied.digest).toMatch(/^[a-f0-9]{64}$/u)
      await fileNames(destination)
    }
  )

  it.each(['0.3.4', '1.22.333'])(
    'shouldFetchOnlyMatchingPublicReleaseTagWhenInstalledSourceIsMissingAtVersion %s',
    async (version) => {
      await installPackage(false, version)
      serveArchive(
        releaseArchive(SOURCE_FILES, {
          [`${ARCHIVE_ROOT}/harness-ts/package.json`]: Buffer.from('{"version":"0.0.1-development"}'),
          [`${ARCHIVE_ROOT}/harness-ts/LICENSE`]: Buffer.from('not the installed license'),
          [`${ARCHIVE_ROOT}/harness-ts/NOTICE`]: Buffer.from('not the installed notice'),
          [`${ARCHIVE_ROOT}/harness-ts/dist/src/index.js`]: Buffer.from('not the installed build'),
          [`${ARCHIVE_ROOT}/strands-ts/src/index.ts`]: Buffer.from('not harness source'),
          [`${ARCHIVE_ROOT}/harness-ts/test/index.test.ts`]: Buffer.from('not copied'),
          [`${ARCHIVE_ROOT}/harness-ts/src/node_modules/ignored/index.ts`]: Buffer.from('not copied'),
          [`${ARCHIVE_ROOT}/.claude/skills`]: [Buffer.from('../.agents/skills'), { os: 3, attrs: 0o120777 << 16 }],
        })
      )

      const copied = await copyHarnessSource(destination, { packageRoot, fetch })

      expect(fetch).toHaveBeenCalledExactlyOnceWith(
        `https://codeload.github.com/strands-agents/harness-sdk/zip/refs/tags/harness-typescript/v${version}`,
        { redirect: 'error', signal: expect.any(AbortSignal) }
      )
      expect(copied.version).toBe(version)
      expect(await fileNames(destination)).toEqual(
        [...Object.keys(SOURCE_FILES), ...Object.keys(RELEASE_FILES), 'package.json'].sort()
      )
      expect(await readFile(join(destination, 'package.json'))).toEqual(
        await readFile(join(packageRoot, 'package.json'))
      )
      for (const name of Object.keys(RELEASE_FILES)) {
        expect(await readFile(join(destination, name))).toEqual(await readFile(join(packageRoot, name)))
      }
      for (const [name, contents] of Object.entries(SOURCE_FILES)) {
        expect(await readFile(join(destination, name), 'utf8')).toBe(contents)
      }
    }
  )

  it.each(['README.md', 'dist'])(
    'shouldCopyAvailablePackageContentsWhenOptionalInstalledPathIsMissing %s',
    async (name) => {
      await installPackage(true)
      await rm(join(packageRoot, name), { recursive: true })

      await copyHarnessSource(destination, { packageRoot })

      await expect(lstat(join(destination, name))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(destination, 'src/index.ts'), 'utf8')).toBe(SOURCE_FILES['src/index.ts'])
    }
  )

  it('shouldKeepDigestStableWhenArchiveOrderAndUnrelatedOutputsChange', async () => {
    await installPackage(true)
    const first = await copyHarnessSource(destination, { packageRoot })
    const sourceFiles = { ...SOURCE_FILES, 'package.json': await readFile(join(packageRoot, 'package.json')) }
    const expected = createHash('sha256')
    for (const [name, contents] of Object.entries(sourceFiles).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    )) {
      const bytes = Buffer.from(contents)
      expected.update(name).update('\0').update(String(bytes.byteLength)).update('\0').update(bytes)
    }
    expect(first.digest).toBe(expected.digest('hex'))
    await rm(join(packageRoot, 'src'), { recursive: true })
    await writeFile(join(packageRoot, 'dist/src/index.js'), 'different build')
    await writeFile(join(packageRoot, 'README.md'), 'different docs')
    await writeFile(join(packageRoot, 'LICENSE'), 'different license')
    serveArchive(releaseArchive(Object.fromEntries(Object.entries(SOURCE_FILES).reverse())))

    const second = await copyHarnessSource(join(temporary, 'second'), { packageRoot, fetch })

    expect(second.digest).toBe(first.digest)
  })

  it.each(['src/index.ts', 'src/tsconfig.json', 'tsconfig.base.json', 'package.json'])(
    'shouldChangeDigestWhenSourceOrManifestBytesChange %s',
    async (name) => {
      await installPackage(true)
      const first = await copyHarnessSource(destination, { packageRoot })
      const path = join(packageRoot, name)
      await writeFile(path, `${await readFile(path, 'utf8')}\n`)

      const second = await copyHarnessSource(join(temporary, 'second'), { packageRoot })

      expect(second.digest).not.toBe(first.digest)
    }
  )

  it.each([
    '0.0.1-development',
    '1.2.3-rc.1',
    '1.2.3+build',
    'latest',
    'v1.2.3',
    '1.2',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    ' 1.2.3',
    '1.2.3/../../main',
    '9007199254740992.0.0',
  ])('shouldRejectWithoutFetchingWhenMissingSourceHasNonPublicVersion %s', async (version) => {
    await installPackage(false, version)

    await expectCleanFailure(/exact numeric public release/u)

    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([null, 3, {}, ''])('shouldRejectWhenInstalledManifestHasInvalidVersion %s', async (version) => {
    await installPackage(true, version)
    await expectCleanFailure(/package.json must identify/u)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['{"name":', '{"name":"different-package","version":"0.3.4"}'])(
    'shouldRejectAndCleanDestinationWhenInstalledManifestIsInvalid %s',
    async (contents) => {
      await installPackage(true)
      await writeFile(join(packageRoot, 'package.json'), contents)

      await expect(copyHarnessSource(destination, { packageRoot })).rejects.toThrow(/Unable to copy harness source/u)

      await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(packageRoot, 'package.json'), 'utf8')).toBe(contents)
      expect(fetch).not.toHaveBeenCalled()
    }
  )

  it.each(['directory', 'file', 'symlink'] as const)(
    'shouldNotOverwriteOrRemoveDestinationWhenItAlreadyExistsAsA %s',
    async (type) => {
      await installPackage(true)
      const outside = join(temporary, 'outside')
      await writeFiles(outside, { 'keep.txt': 'keep' })
      if (type === 'directory') await writeFiles(destination, { 'keep.txt': 'keep' })
      if (type === 'file') await writeFile(destination, 'keep')
      if (type === 'symlink') await symlink(outside, destination, 'junction')

      await expect(copyHarnessSource(destination, { packageRoot })).rejects.toThrow(/destination already exists/u)

      expect(await readFile(type === 'file' ? destination : join(destination, 'keep.txt'), 'utf8')).toBe('keep')
      expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
      expect(fetch).not.toHaveBeenCalled()
    }
  )

  it('shouldRemoveOnlyNewDestinationWhenDestinationIsInsideInstalledPackage', async () => {
    await installPackage(true)
    destination = join(packageRoot, 'src', 'copy')

    await expectCleanFailure(/must be outside the installed package/u)

    expect(await readFile(join(packageRoot, 'src/index.ts'), 'utf8')).toBe(SOURCE_FILES['src/index.ts'])
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['package.json', 'LICENSE', 'NOTICE', 'src/index.ts', 'src/tsconfig.json', 'tsconfig.base.json'])(
    'shouldFailWithoutDownloadingWhenInstalledSourceIsIncompleteAndMissing %s',
    async (name) => {
      await installPackage(true)
      await rm(join(packageRoot, name))

      await expect(copyHarnessSource(destination, { packageRoot, fetch })).rejects.toThrow(/regular file|missing/u)

      await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(fetch).not.toHaveBeenCalled()
    }
  )

  it.each(['src/index.ts', 'src/tsconfig.json', 'tsconfig.base.json'])(
    'shouldFailAndCleanDestinationWhenReleaseArchiveIsMissing %s',
    async (name) => {
      await installPackage()
      serveArchive(releaseArchive(Object.fromEntries(Object.entries(SOURCE_FILES).filter(([path]) => path !== name))))

      await expectCleanFailure(/No complete TypeScript source.*missing/u)
      expect(fetch).toHaveBeenCalledOnce()
    }
  )

  it('shouldNotSubstituteDistWhenArchiveContainsNoTypeScriptSource', async () => {
    await installPackage()
    serveArchive(releaseArchive({ 'dist/src/index.js': 'export const compiled = true' }))

    await expectCleanFailure(/No complete TypeScript source/u)
  })

  it.each([
    'src',
    'src/index.ts',
    'src/nested',
    'tsconfig.base.json',
    'package.json',
    'LICENSE',
    'NOTICE',
    'README.md',
    'dist',
    'dist/src/index.js',
  ])('shouldRejectAndCleanDestinationWhenInstalledContentIsASymbolicLink %s', async (name) => {
    await installPackage(true)
    const outside = join(temporary, 'outside')
    const directory = ['src', 'src/nested', 'dist'].includes(name)
    if (directory) await writeFiles(outside, { 'keep.txt': 'keep' })
    else await writeFile(outside, 'keep')
    await rm(join(packageRoot, name), { recursive: true, force: true })
    await symlink(outside, join(packageRoot, name), directory ? 'junction' : 'file')

    await expect(copyHarnessSource(destination, { packageRoot })).rejects.toThrow(
      /regular file|symbolic link|Symbolic link/u
    )

    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(directory ? join(outside, 'keep.txt') : outside, 'utf8')).toBe('keep')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    '../escape.ts',
    'src/../../../../escape.ts',
    '/absolute.ts',
    'src/./index.ts',
    'src//index.ts',
    'src\\escape.ts',
    'src/C:escape.ts',
    'src/bad\0.ts',
    'src/CON.ts',
    'src/trailing.ts.',
  ])('shouldRejectUnsafeSourcePathsWhenArchiveContains %s', async (name) => {
    await installPackage()
    const outside = join(temporary, 'escape.ts')
    await writeFile(outside, 'keep')
    serveArchive(releaseArchive({ ...SOURCE_FILES, [name]: 'unsafe' }))

    await expectCleanFailure(/Unsafe path|not portable/u)

    expect(await readFile(outside, 'utf8')).toBe('keep')
  })

  it.each(['../escape.ts', '/escape.ts', 'C:/escape.ts', 'root\\harness-ts/src/escape.ts'])(
    'shouldRejectUnsafeArchivePathsWhenEntryIsOutsideSourceSelection %s',
    async (name) => {
      await installPackage()
      serveArchive(releaseArchive(SOURCE_FILES, { [name]: Buffer.from('unsafe') }))

      await expectCleanFailure(/Unsafe path/u)
    }
  )

  it.each([
    { name: 'symlink', attrs: 0o120777 << 16 },
    { name: 'fifo', attrs: 0o010644 << 16 },
    { name: 'socket', attrs: 0o140644 << 16 },
    { name: 'block device', attrs: 0o060644 << 16 },
    { name: 'directory posing as file', attrs: (0o040755 << 16) | 0x10 },
    { name: 'volume label', attrs: 0x08 },
  ])('shouldRejectUnsupportedEntriesWhenSelectedArchiveEntryIsA $name', async ({ attrs }) => {
    await installPackage()
    serveArchive(
      releaseArchive(SOURCE_FILES, {
        [`${ARCHIVE_ROOT}/harness-ts/src/link.ts`]: [Buffer.from('../outside'), { os: 3, attrs }],
      })
    )

    await expectCleanFailure(/Symbolic links|Unsupported harness source archive entry type/u)
  })

  it.each([0, 8])('shouldCopyRegularSourceFilesWhenZipCompressionIs %s', async (compression) => {
    await installPackage()
    serveArchive(
      releaseArchive(
        SOURCE_FILES,
        {
          [`${ARCHIVE_ROOT}/harness-ts/src/`]: [Buffer.alloc(0), { os: 3, attrs: (0o040755 << 16) | 0x10 }],
          [`${ARCHIVE_ROOT}/harness-ts/tsconfig.json`]: Buffer.from('{"extends":"./tsconfig.base.json"}'),
        },
        { level: compression === 0 ? 0 : 6, os: 3, attrs: 0o100644 << 16 }
      )
    )

    await copyHarnessSource(destination, { packageRoot, fetch })

    expect(await readFile(join(destination, 'src/index.ts'), 'utf8')).toBe(SOURCE_FILES['src/index.ts'])
    expect(await readFile(join(destination, 'tsconfig.json'), 'utf8')).toBe('{"extends":"./tsconfig.base.json"}')
    await fileNames(destination)
  })

  it.each(['case collision', 'multiple roots', 'file directory collision'])(
    'shouldRejectAmbiguousSourcePathsWhenArchiveContainsA %s',
    async (scenario) => {
      await installPackage()
      const paths = {
        'case collision': `${ARCHIVE_ROOT}/harness-ts/src/INDEX.ts`,
        'multiple roots': 'another-release/harness-ts/src/other.ts',
        'file directory collision': `${ARCHIVE_ROOT}/harness-ts/src/index.ts/child.ts`,
      }
      serveArchive(releaseArchive(SOURCE_FILES, { [paths[scenario as keyof typeof paths]]: Buffer.from('ambiguous') }))

      await expectCleanFailure(/Duplicate harness source path|multiple harness source roots|EEXIST|ENOTDIR/u)
    }
  )

  it.each([
    'not a zip',
    'truncated zip',
    'invalid central signature',
    'unsupported compression',
    'encrypted entry',
    'mismatched local name',
    'wrong checksum',
    'understated size',
    'overstated size',
    'empty archive',
  ])('shouldRejectAndCleanDestinationWhenSourceArchiveHas %s', async (scenario) => {
    await installPackage()
    let archive = releaseArchive()
    const header = archiveHeader(archive, `${ARCHIVE_ROOT}/harness-ts/src/index.ts`)
    const local = archive.readUInt32LE(header + 42)
    if (scenario === 'not a zip') archive = Buffer.from('invalid archive')
    if (scenario === 'truncated zip') archive = archive.subarray(0, archive.length - 10)
    if (scenario === 'invalid central signature') archive.writeUInt32LE(0, header)
    if (scenario === 'unsupported compression') archive.writeUInt16LE(14, header + 10)
    if (scenario === 'encrypted entry') archive.writeUInt16LE(1, header + 8)
    if (scenario === 'mismatched local name') archive[local + 30] = 0x78
    if (scenario === 'wrong checksum') {
      archive.writeUInt32LE(0, header + 16)
      archive.writeUInt32LE(0, local + 14)
    }
    if (scenario === 'understated size' || scenario === 'overstated size') {
      const size = scenario === 'understated size' ? 1 : 512
      archive.writeUInt32LE(size, header + 24)
      archive.writeUInt32LE(size, local + 22)
    }
    if (scenario === 'empty archive') archive = Buffer.from(zipSync({}))
    serveArchive(archive)

    await expectCleanFailure(/Invalid harness source ZIP|No complete TypeScript source/u)
  })

  it.each(['single file', 'combined files', 'forged header', 'entry count'])(
    'shouldRejectBeforeExtractionWhenSelectedSourceLimitIsExceededBy %s',
    async (scenario) => {
      await installPackage()
      const files: Record<string, string | Uint8Array> = { ...SOURCE_FILES }
      if (scenario === 'single file') files['src/large.ts'] = Buffer.alloc(10 * 1024 * 1024 + 1)
      if (scenario === 'combined files') {
        files['src/first.ts'] = Buffer.alloc(6 * 1024 * 1024)
        files['src/second.ts'] = Buffer.alloc(5 * 1024 * 1024)
      }
      if (scenario === 'entry count') {
        for (let index = 0; index < 10_001; index++) files[`src/${index}.ts`] = ''
      }
      const archive = releaseArchive(files)
      if (scenario === 'forged header') {
        const header = archiveHeader(archive, `${ARCHIVE_ROOT}/harness-ts/src/index.ts`)
        const local = archive.readUInt32LE(header + 42)
        archive.writeUInt32LE(0xffff_ffff, header + 24)
        archive.writeUInt32LE(0xffff_ffff, local + 22)
      }
      serveArchive(archive)

      await expectCleanFailure(/exceeds 10 MB or 10,000 entries/u)
    }
  )

  it('shouldBoundInstalledSourceWhenSourceFileExceedsExpandedLimit', async () => {
    await installPackage(true)
    await writeFile(join(packageRoot, 'src/large.ts'), '')
    await truncate(join(packageRoot, 'src/large.ts'), 10 * 1024 * 1024 + 1)

    await expectCleanFailure(/exceeds 10 MB/u)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('shouldSkipInflatingUnrelatedMonorepoFilesWhenTheirDeclaredSizeExceedsSourceLimit', async () => {
    await installPackage()
    const name = `${ARCHIVE_ROOT}/strands-ts/unrelated.ts`
    const archive = releaseArchive(SOURCE_FILES, { [name]: Buffer.from('not inflated') })
    const header = archiveHeader(archive, name)
    archive.writeUInt32LE(0xffff_ffff, header + 24)
    serveArchive(archive)

    await copyHarnessSource(destination, { packageRoot, fetch })

    expect(await fileNames(destination)).not.toContain('unrelated.ts')
  })

  it.each(['content length', 'streamed bytes', 'underreported content length'])(
    'shouldCancelDownloadAndCleanDestinationWhenArchiveExceedsLimitThrough %s',
    async (scenario) => {
      await installPackage()
      let chunks = 0
      const cancel = vi.fn()
      const body = new ReadableStream({
        pull(controller) {
          controller.enqueue(Buffer.alloc(1024 * 1024))
          if (++chunks > 60) controller.close()
        },
        cancel,
      })
      const headers =
        scenario === 'content length'
          ? { 'content-length': String(50 * 1024 * 1024 + 1) }
          : scenario === 'underreported content length'
            ? { 'content-length': '1' }
            : undefined
      fetch.mockResolvedValue(new globalThis.Response(body, headers ? { headers } : {}))

      await expectCleanFailure(/exceeds 50 MB/u)

      expect(cancel).toHaveBeenCalledOnce()
      expect(chunks).toBeLessThan(60)
    }
  )

  it.each(['network rejection', 'HTTP 404', 'HTTP 500', 'redirect', 'missing body', 'stream rejection'])(
    'shouldFailClearlyAndCleanOnlyNewDestinationWhenDownloadFailsWith %s',
    async (scenario) => {
      await installPackage()
      const sibling = join(temporary, 'sibling.txt')
      await writeFile(sibling, 'keep')
      const response = new globalThis.Response(releaseArchive())
      if (scenario === 'network rejection') fetch.mockRejectedValue(new Error('network disconnected'))
      if (scenario === 'HTTP 404') fetch.mockResolvedValue(new globalThis.Response('missing', { status: 404 }))
      if (scenario === 'HTTP 500') fetch.mockResolvedValue(new globalThis.Response('failed', { status: 500 }))
      if (scenario === 'redirect') {
        Object.defineProperty(response, 'redirected', { value: true })
        fetch.mockResolvedValue(response)
      }
      if (scenario === 'missing body') fetch.mockResolvedValue(new globalThis.Response(null))
      if (scenario === 'stream rejection') {
        fetch.mockResolvedValue(
          new globalThis.Response(
            new ReadableStream({
              pull(controller) {
                controller.error(new Error('connection reset'))
              },
            })
          )
        )
      }

      await expectCleanFailure(/Unable to fetch TypeScript source.*harness@0.3.4/u)

      expect(await readFile(sibling, 'utf8')).toBe('keep')
      expect(fetch).toHaveBeenCalledOnce()
    }
  )

  it.each(['src', 'dist'])('shouldRejectAndCleanDestinationWhenInstalledDirectoryIsARegularFile %s', async (name) => {
    await installPackage(true)
    await rm(join(packageRoot, name), { recursive: true })
    await writeFile(join(packageRoot, name), 'not a directory')

    await expectCleanFailure(/must be a directory/u)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('shouldResolveInstalledManifestAboveEntrypointWhenPackageRootIsNotProvided', async () => {
    await installPackage()
    serveArchive()

    const copied = await copyHarnessSource(destination, { fetch })

    expect(resolveHarnessEntrypoint).toHaveBeenCalledExactlyOnceWith('@strands-agents/harness')
    expect(copied).toEqual({ path: destination, version: '0.3.4', digest: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(await readFile(join(destination, 'package.json'))).toEqual(await readFile(join(packageRoot, 'package.json')))
  })

  it('shouldRebuildCanonicalDistWhenUsingPreservedManifestBuildCommandAndConfigs', async () => {
    await installPackage()
    serveArchive()
    await copyHarnessSource(destination, { packageRoot, fetch })
    const copiedManifest = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'))
    const [command, ...args] = copiedManifest.scripts.build.split(' ') as string[]
    expect(command).toBe('tsc')
    const { createRequire } = await vi.importActual<typeof import('node:module')>('node:module')
    const require = createRequire(import.meta.url)
    await rm(join(destination, 'dist'), { recursive: true })

    await promisify(execFile)(process.execPath, [require.resolve('typescript/bin/tsc'), ...args], { cwd: destination })

    expect(await readFile(join(destination, 'dist/src/index.js'), 'utf8')).toContain('harnessVersion = "0.3.4"')
    expect(await readFile(join(destination, 'dist/src/index.d.ts'), 'utf8')).toContain('harnessVersion = "0.3.4"')
    expect(await readFile(join(destination, 'src/index.ts'), 'utf8')).toBe(SOURCE_FILES['src/index.ts'])
  }, 15_000)
})

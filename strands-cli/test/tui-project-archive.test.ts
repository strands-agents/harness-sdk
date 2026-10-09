import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { ZipFile } from 'yazl'

const execute = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: execute }))

import { prepareArchiveDependencies } from '../src/tui/project/archive.js'
import { importAgentProject } from '../src/tui/project/import.js'

let temporary: string | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  execute.mockReset()
  if (temporary) await rm(temporary, { recursive: true, force: true })
})

it('removes the extraction directory when the ZIP contains no agent', async () => {
  temporary = await mkdtemp(join(tmpdir(), 'strands-archive-'))
  vi.stubEnv('HOME', temporary)
  const archive = join(temporary, 'agent.zip')
  await writeFile(archive, zipSync({ 'README.md': strToU8('No entrypoint') }))

  expect(() => importAgentProject(archive)).toThrow('The ZIP must contain a project with agent.ts, agent.py')
  expect(await readdir(join(temporary, '.strands', 'cli', 'cache', 'agents'))).toEqual([])
})

it.each(['missing.py', '../outside.py', 'notes.txt'] as const)(
  'cleans up an invalid marker %s ZIP',
  async (selected) => {
    temporary = await mkdtemp(join(tmpdir(), 'strands-archive-'))
    vi.stubEnv('HOME', temporary)
    const archive = join(temporary, 'agent.zip')
    for (const prefix of ['', 'wrapper/project/']) {
      await writeFile(
        archive,
        zipSync({
          [`${prefix}.strands-entrypoint`]: strToU8(selected),
          ...(selected === 'notes.txt' ? { [`${prefix}notes.txt`]: strToU8('Not source') } : {}),
          [`${prefix}agent.ts`]: strToU8('export const agent = {}'),
        })
      )
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(() => importAgentProject(archive)).toThrow('Invalid .strands-entrypoint')
        expect(await readdir(join(temporary, '.strands', 'cli', 'cache', 'agents'))).toEqual([])
      }
    }
  }
)

it.each(['typescript', 'python'] as const)(
  'installs %s archive dependencies through an aliased home, but leaves source projects alone',
  async (language) => {
    temporary = await mkdtemp(join(tmpdir(), 'strands-archive-'))
    const testHome = join(temporary, 'home')
    const alias = join(temporary, 'alias')
    await mkdir(testHome)
    await symlink(testHome, alias, 'dir')
    vi.stubEnv('HOME', alias)
    const filename = language === 'typescript' ? 'agent/agent.ts' : 'agent/agent.py'
    const manifest = language === 'typescript' ? 'package.json' : 'requirements.txt'
    const contents = language === 'typescript' ? '{"private":true}' : 'example-package\n'
    const archive = join(temporary, 'agent.zip')
    await writeFile(
      archive,
      zipSync({ [filename]: strToU8(''), [manifest]: strToU8(contents), '.strands-entrypoint': strToU8(filename) })
    )
    const extracted = importAgentProject(archive)
    const project = importAgentProject(extracted.entrypoint)
    if (language === 'python') {
      const executable = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
      const directory = join(project.root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin')
      await mkdir(directory, { recursive: true })
      await writeFile(join(project.root, '.venv', executable), '')
    } else {
      await mkdir(join(project.root, 'node_modules'))
    }
    execute.mockImplementation((_command, args, _options, callback) => {
      expect(args).toEqual(
        language === 'typescript'
          ? ['install', '--no-audit', '--no-fund']
          : ['-m', 'pip', 'install', '-r', 'requirements.txt']
      )
      if (language === 'typescript') {
        void writeFile(join(project.root, 'package-lock.json'), '{"lockfileVersion":3}').then(() =>
          callback(null, '', '')
        )
      } else {
        callback(null, '', '')
      }
    })
    await prepareArchiveDependencies(project.root, language)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[2].cwd).toBe(realpathSync(project.root))
    expect(await readFile(join(project.root, '.strands-dependencies'), 'utf8')).toMatch(/^[a-f0-9]{64}$/u)

    await prepareArchiveDependencies(extracted.root, language)
    const source = join(temporary, 'source')
    await mkdir(source)
    await mkdir(join(source, 'agent'), { recursive: true })
    await writeFile(join(source, filename), '')
    await writeFile(join(source, manifest), contents)
    await prepareArchiveDependencies(source, language)
    expect(execute).toHaveBeenCalledTimes(1)
  }
)

it.each([
  ['typescript', 'package-lock.json'],
  ['python', 'package-lock.json'],
  ['typescript', 'npm-shrinkwrap.json'],
  ['python', 'npm-shrinkwrap.json'],
] as const)('uses npm ci and invalidates the %s dependency cache when only %s changes', async (language, lockfile) => {
  temporary = await mkdtemp(join(tmpdir(), 'strands-archive-'))
  vi.stubEnv('HOME', temporary)
  const archive = join(temporary, 'agent.zip')
  const filename = language === 'typescript' ? 'agent.ts' : 'agent.py'
  const manifest = Buffer.from('{\r\n  "private": true\r\n}\r\n')
  const lock = Buffer.from('{\r\n  "lockfileVersion": 3\r\n}\r\n')
  await writeFile(archive, zipSync({ [filename]: Buffer.from(''), 'package.json': manifest, [lockfile]: lock }))
  const project = importAgentProject(archive)
  await mkdir(join(project.root, 'node_modules'))
  execute.mockImplementation((_command, _args, _options, callback) => callback(null, '', ''))

  await prepareArchiveDependencies(project.root, language)
  expect(execute.mock.calls[0]?.[1]).toEqual(['ci', '--no-audit', '--no-fund'])
  const fingerprint = await readFile(join(project.root, '.strands-dependencies'), 'utf8')
  await prepareArchiveDependencies(project.root, language)
  expect(execute).toHaveBeenCalledTimes(1)
  const changedLock = Buffer.from('{\r\n  "lockfileVersion": 3,\r\n  "packages": {}\r\n}\r\n')
  await writeFile(join(project.root, lockfile), changedLock)
  await prepareArchiveDependencies(project.root, language)
  expect(execute).toHaveBeenCalledTimes(2)
  expect(execute.mock.calls[1]?.[1]).toEqual(['ci', '--no-audit', '--no-fund'])
  expect(await readFile(join(project.root, '.strands-dependencies'), 'utf8')).not.toBe(fingerprint)
  expect(await readFile(join(project.root, 'package.json'))).toEqual(manifest)
  expect(await readFile(join(project.root, lockfile))).toEqual(changedLock)
})

it.each([false, true])('restores executable permissions without privileged bits from ZIP64=%s', async (zip64) => {
  const archive = await archiveWithMode(0o107777, zip64)
  const project = importAgentProject(archive)
  expect((await stat(join(project.root, 'helper.sh'))).mode & 0o7777).toBe(0o755)
})

it.each([false, true])('rejects symbolic links in ZIP64=%s before extraction', async (zip64) => {
  const archive = await archiveWithMode(0o120777, zip64)
  expect(() => importAgentProject(archive)).toThrow('symbolic links')
})

async function archiveWithMode(mode: number, zip64: boolean): Promise<string> {
  temporary = await mkdtemp(join(tmpdir(), 'strands-archive-'))
  vi.stubEnv('HOME', temporary)
  const zip = new ZipFile()
  zip.addBuffer(Buffer.from(''), 'agent/agent.ts')
  zip.addBuffer(Buffer.from('#!/bin/sh\nprintf helper-ran\n'), 'helper.sh', { mode })
  const chunks: Buffer[] = []
  const completed = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk))
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
    zip.outputStream.on('error', reject)
  })
  zip.end({ forceZip64Format: zip64, comment: 'permission fixture' })
  const archive = join(temporary, `permissions-${mode}-${zip64}.zip`)
  await writeFile(archive, await completed)
  return archive
}

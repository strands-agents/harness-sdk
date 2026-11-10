import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { ZipFile } from 'yazl'

const execute = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  return {
    ...actual,
    spawn: (command: string, args: string[], options: object) => {
      const child = Object.assign(new EventEmitter(), {
        pid: process.pid,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      })
      process.nextTick(() => {
        execute(
          command,
          args,
          options,
          (error: Error | null) => {
            if (error) child.stderr.write(error.message)
            child.stdout.end()
            child.stderr.end()
            child.emit('close', error ? 1 : 0, null)
          },
          child
        )
      })
      return child
    },
  }
})

import { prepareArchiveDependencies } from '../../src/project/archive.js'
import { importAgentProject } from '../../src/project/import.js'
import { npmInvocation } from '../../src/terminal/npm.js'

let temporary: string | undefined

/** `os.homedir()` reads USERPROFILE on Windows, so the test home has to move both variables. */
function stubHome(home: string): void {
  vi.stubEnv('HOME', home)
  if (process.platform === 'win32') vi.stubEnv('USERPROFILE', home)
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  execute.mockReset()
  if (temporary) await rm(temporary, { recursive: true, force: true })
})

// https://github.com/strands-agents/harness-sdk/pull/5194#discussion_r4488017925
it.each(['timeout', 'stdout', 'stderr', 'signal'] as const)(
  'rejects installer %s failures, retains ownership until close, and allows retry',
  async (failure) => {
    temporary = await mkdtemp(join(tmpdir(), 'strands-archive-'))
    stubHome(temporary)
    const archive = join(temporary, 'agent.zip')
    await writeFile(archive, zipSync({ 'agent.ts': strToU8(''), 'package.json': strToU8('{"private":true}') }))
    const project = importAgentProject(archive)
    const lock = `${project.root}.dependencies.lock`
    execute.mockImplementation((_command, _args, _options, callback) => callback(null))
    const started = new Promise<ChildProcessWithoutNullStreams>((resolve) => {
      execute.mockImplementationOnce((_command, _args, _options, _callback, child) => resolve(child))
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const installing = prepareArchiveDependencies(project.root, 'typescript')
    let settled = false
    void installing.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    const rejected = expect(installing).rejects.toMatchObject({
      cause: {
        message: expect.stringMatching(
          failure === 'timeout'
            ? /timed out after 180 seconds/u
            : failure === 'signal'
              ? /SIGTERM[\s\S]*installer diagnostic/u
              : /output exceeded 8 MB/u
        ),
      },
    })
    const child = await started
    if (failure === 'timeout') {
      await vi.advanceTimersByTimeAsync(179_999)
      expect(child.kill).not.toHaveBeenCalled()
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
    } else if (failure === 'signal') {
      child.stderr.push('installer diagnostic')
    } else {
      child[failure].push(Buffer.alloc(8 * 1024 * 1024, 'x'))
      expect(child.kill).not.toHaveBeenCalled()
      expect(child[failure].destroyed).toBe(false)
      expect(settled).toBe(false)
      child[failure].push('x')
    }
    if (failure !== 'signal') {
      expect(child.kill).toHaveBeenCalledOnce()
      expect(child.stdout.destroyed).toBe(true)
      expect(child.stderr.destroyed).toBe(true)
    }
    expect(await readdir(lock)).toHaveLength(2)
    expect(settled).toBe(false)
    child.emit('close', null, 'SIGTERM')
    await rejected
    expect(vi.getTimerCount()).toBe(0)
    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(project.root, '.strands-dependencies'))).rejects.toMatchObject({ code: 'ENOENT' })

    vi.useRealTimers()
    await mkdir(join(project.root, 'node_modules'))
    await prepareArchiveDependencies(project.root, 'typescript')
    expect(await readFile(join(project.root, '.strands-dependencies'), 'utf8')).toMatch(/^[a-f0-9]{64}$/u)
    expect(execute).toHaveBeenCalledTimes(2)
  }
)

// https://github.com/strands-agents/harness-sdk/pull/5194#discussion_r4488018108
it('reports live lock owners and safe recovery without removing their lock', async () => {
  temporary = await mkdtemp(join(tmpdir(), 'strands-archive-'))
  stubHome(temporary)
  const archive = join(temporary, 'agent.zip')
  await writeFile(archive, zipSync({ 'agent.ts': strToU8(''), 'package.json': strToU8('{"private":true}') }))
  const project = importAgentProject(archive)
  const lock = `${project.root}.dependencies.lock`
  const owner = `${process.pid}-${randomUUID()}`
  await mkdir(lock)
  await writeFile(join(lock, owner), '')
  const kill = process.kill
  const signals = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    expect(signal).toBe(0)
    return kill(pid, signal)
  })
  const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(540_001)
  const error = await prepareArchiveDependencies(project.root, 'typescript').catch((error: unknown) => error)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain(lock)
  expect((error as Error).message).toContain(String(process.pid))
  expect((error as Error).message).toMatch(/stop.*installer/iu)
  expect(await readdir(lock)).toEqual([owner])
  expect(signals).toHaveBeenCalledWith(process.pid, 0)
  expect(execute).not.toHaveBeenCalled()

  clock.mockRestore()
  signals.mockRestore()
  await rm(join(lock, owner))
  await mkdir(join(project.root, 'node_modules'))
  execute.mockImplementation((_command, _args, _options, callback) => callback(null))
  await prepareArchiveDependencies(project.root, 'typescript')
  expect(await readFile(join(project.root, '.strands-dependencies'), 'utf8')).toMatch(/^[a-f0-9]{64}$/u)
  await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('removes the extraction directory when the ZIP contains no agent', async () => {
  temporary = await mkdtemp(join(tmpdir(), 'strands-archive-'))
  stubHome(temporary)
  const archive = join(temporary, 'agent.zip')
  await writeFile(archive, zipSync({ 'README.md': strToU8('No entrypoint') }))

  expect(() => importAgentProject(archive)).toThrow('The ZIP must contain a project with agent.ts, agent.py')
  expect(await readdir(join(temporary, '.strands', 'cli', 'cache', 'agents'))).toEqual([])
})

it('rejects Windows-reserved paths', async () => {
  temporary = await mkdtemp(join(tmpdir(), 'strands-archive-'))
  stubHome(temporary)
  const archive = join(temporary, 'agent.zip')
  await writeFile(archive, zipSync({ 'agent/agent.ts': strToU8(''), 'agent/CON': strToU8('reserved') }))

  expect(() => importAgentProject(archive)).toThrow('not portable to Windows')
})

it.each(['missing.py', '../outside.py', 'notes.txt'] as const)(
  'cleans up an invalid marker %s ZIP',
  async (selected) => {
    temporary = await mkdtemp(join(tmpdir(), 'strands-archive-'))
    stubHome(temporary)
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

// https://github.com/strands-agents/harness-sdk/pull/5194#discussion_r4483785396
it.each([
  ['typescript', 'default', false],
  ['python', 'default', false],
  ['python', 'relative', true],
  ['python', 'external', false],
  ['python', 'internal', true],
  ['python', 'aliased-internal', true],
] as const)(
  'installs %s archive dependencies with a %s cache through an aliased home, but leaves source projects alone',
  async (language, cache, disableCache) => {
    temporary = await mkdtemp(join(tmpdir(), 'strands-archive-'))
    const testHome = join(temporary, 'home')
    const alias = join(temporary, 'alias')
    await mkdir(testHome)
    await symlink(testHome, alias, 'dir')
    stubHome(alias)
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
    vi.stubEnv('PIP_NO_CACHE_DIR', undefined)
    vi.stubEnv(
      'PIP_CACHE_DIR',
      cache === 'default'
        ? undefined
        : cache === 'relative'
          ? 'pip/cache'
          : join(cache === 'internal' ? realpathSync(project.root) : temporary, 'pip-cache')
    )
    if (cache === 'aliased-internal') {
      const alias = join(temporary, 'project-alias')
      await symlink(realpathSync(project.root), alias, 'junction')
      vi.stubEnv('PIP_CACHE_DIR', join(alias, 'pip', 'cache'))
    }
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
          ? npmInvocation(['install', '--no-audit', '--no-fund']).args
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
    execute.mockImplementationOnce((_command, _args, _options, callback) => callback(new Error('installer failed')))
    await expect(prepareArchiveDependencies(project.root, language)).rejects.toThrow('Could not install')
    await prepareArchiveDependencies(project.root, language)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[0]?.[2].cwd).toBe(realpathSync(project.root))
    if (language === 'python') {
      expect(execute.mock.calls[0]?.[2].env.PIP_NO_CACHE_DIR).toBe(disableCache ? '1' : undefined)
      expect(execute.mock.calls[0]?.[2].env.PIP_CACHE_DIR).toBe(process.env.PIP_CACHE_DIR)
    }
    expect(await readFile(join(project.root, '.strands-dependencies'), 'utf8')).toMatch(/^[a-f0-9]{64}$/u)

    await prepareArchiveDependencies(extracted.root, language)
    const source = join(temporary, 'source')
    await mkdir(source)
    await mkdir(join(source, 'agent'), { recursive: true })
    await writeFile(join(source, filename), '')
    await writeFile(join(source, manifest), contents)
    await prepareArchiveDependencies(source, language)
    expect(execute).toHaveBeenCalledTimes(2)
  }
)

it.each([
  ['typescript', 'package-lock.json'],
  ['python', 'package-lock.json'],
  ['typescript', 'npm-shrinkwrap.json'],
  ['python', 'npm-shrinkwrap.json'],
] as const)('uses npm ci and invalidates the %s dependency cache when only %s changes', async (language, lockfile) => {
  temporary = await mkdtemp(join(tmpdir(), 'strands-archive-'))
  stubHome(temporary)
  const archive = join(temporary, 'agent.zip')
  const filename = language === 'typescript' ? 'agent.ts' : 'agent.py'
  const manifest = Buffer.from('{\r\n  "private": true\r\n}\r\n')
  const lock = Buffer.from('{\r\n  "lockfileVersion": 3\r\n}\r\n')
  await writeFile(archive, zipSync({ [filename]: Buffer.from(''), 'package.json': manifest, [lockfile]: lock }))
  const project = importAgentProject(archive)
  await mkdir(join(project.root, 'node_modules'))
  execute.mockImplementation((_command, _args, _options, callback) => callback(null, '', ''))

  await prepareArchiveDependencies(project.root, language)
  const install = npmInvocation(['ci', '--no-audit', '--no-fund'])
  expect(execute.mock.calls[0]?.slice(0, 2)).toEqual([install.command, install.args])
  const fingerprint = await readFile(join(project.root, '.strands-dependencies'), 'utf8')
  await prepareArchiveDependencies(project.root, language)
  expect(execute).toHaveBeenCalledTimes(1)
  const changedLock = Buffer.from('{\r\n  "lockfileVersion": 3,\r\n  "packages": {}\r\n}\r\n')
  await writeFile(join(project.root, lockfile), changedLock)
  await prepareArchiveDependencies(project.root, language)
  expect(execute).toHaveBeenCalledTimes(2)
  expect(execute.mock.calls[1]?.slice(0, 2)).toEqual([install.command, install.args])
  expect(await readFile(join(project.root, '.strands-dependencies'), 'utf8')).not.toBe(fingerprint)
  expect(await readFile(join(project.root, 'package.json'))).toEqual(manifest)
  expect(await readFile(join(project.root, lockfile))).toEqual(changedLock)
})

it.each([
  { zip64: false, compress: false },
  { zip64: false, compress: true },
  { zip64: true, compress: false },
  { zip64: true, compress: true },
])(
  'preserves filenames and executable permissions from ZIP64=$zip64 compressed=$compress',
  async ({ zip64, compress }) => {
    const archive = await archiveWithMode(0o107777, zip64, compress)
    const project = importAgentProject(archive)
    for (const name of ['helper.sh', '__proto__']) {
      expect(await readFile(join(project.root, name), 'utf8')).toBe('#!/bin/sh\nprintf helper-ran\n')
      // Windows has no POSIX executable bit.
      if (process.platform !== 'win32') {
        expect((await stat(join(project.root, name))).mode & 0o7777).toBe(0o755)
      }
    }
  }
)

it.each([false, true])('rejects symbolic links in ZIP64=%s', async (zip64) => {
  const archive = await archiveWithMode(0o120777, zip64)
  expect(() => importAgentProject(archive)).toThrow('symbolic links')
})

async function archiveWithMode(mode: number, zip64: boolean, compress = true): Promise<string> {
  temporary = await mkdtemp(join(tmpdir(), 'strands-archive-'))
  stubHome(temporary)
  const zip = new ZipFile()
  zip.addBuffer(Buffer.from(''), 'agent/agent.ts')
  for (const name of ['helper.sh', '__proto__']) {
    zip.addBuffer(Buffer.from('#!/bin/sh\nprintf helper-ran\n'), name, { mode, compress })
  }
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

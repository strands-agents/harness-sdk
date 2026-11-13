import { lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { devNull } from 'node:os'
import { describe, expect, it, vi } from 'vitest'

import {
  preparePythonRuntime,
  pythonInstallEnvironment,
  type PythonRuntimeCommand,
} from '../../src/project/python-runtime.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const runtimePath = (root: string): string =>
  join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const missing = (): Error => Object.assign(new Error('Missing Python module'), { code: 42 })
const createEnvironment = async (root: string): Promise<string> => {
  const python = runtimePath(root)
  await mkdir(dirname(python), { recursive: true })
  await writeFile(python, 'fixture interpreter')
  return python
}

const commands = (run: ReturnType<typeof vi.fn<(request: PythonRuntimeCommand) => Promise<void>>>): string[][] =>
  run.mock.calls.map(([request]) => request.args)

describe('dev Python runtime preparation', () => {
  it('shouldRejectGlobalInterpreterPathsBeforeAnyPackageInstall', async () => {
    const root = await temporaryDirectory()
    await createEnvironment(root)
    const run = vi.fn(async ({ args }: PythonRuntimeCommand): Promise<void> => {
      if (args[1]?.includes('strands_harness')) throw missing()
      if (args.includes('-I') && args.includes('-c'))
        throw Object.assign(new Error('prefix outside project'), { code: 44 })
    })

    await expect(preparePythonRuntime(root, { run })).rejects.toThrow('installation paths must stay inside')

    expect(commands(run).some((args) => args.includes('install') || args.includes('ensurepip'))).toBe(false)
    expect(await readdir(join(root, '.strands/state'))).toEqual([])
  })

  it('shouldIgnoreInstallationDestinationOverridesWhileKeepingIndexConfiguration', () => {
    const environment = {
      PATH: '/tools',
      PIP_TARGET: '/outside',
      PIP_PREFIX: '/shared',
      PIP_USER: '1',
      PIP_ROOT: '/root',
      PIP_CONFIG_FILE: '/config/pip.conf',
      PYTHONHOME: '/other',
      PYTHONPATH: '/modules',
      PYTHONUSERBASE: '/users',
      PIP_INDEX_URL: 'https://packages.example/simple',
      PIP_CERT: '/certs/ca.pem',
      pip_target: '/lowercase',
    }

    const result = pythonInstallEnvironment(environment)

    expect(result).toEqual({
      PATH: '/tools',
      PIP_INDEX_URL: environment.PIP_INDEX_URL,
      PIP_CERT: environment.PIP_CERT,
      PIP_CONFIG_FILE: devNull,
      PIP_REQUIRE_VIRTUALENV: 'true',
      PIP_NO_CACHE_DIR: '1',
      PYTHONDONTWRITEBYTECODE: '1',
    })
    expect(environment.PIP_TARGET).toBe('/outside')
  })

  it('shouldReuseTheProjectInterpreterWhenTheHarnessIsAlreadyInstalled', async () => {
    const root = await temporaryDirectory()
    const python = await createEnvironment(root)
    const run = vi.fn(async (_request: PythonRuntimeCommand): Promise<void> => undefined)

    expect(await preparePythonRuntime(root, { run })).toBe(python)

    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0]?.[0]).toMatchObject({ command: python, cwd: root })
    expect(await readdir(root)).toEqual(['.venv'])
  })

  it.each(['requirements.txt', 'pyproject.toml', 'none'])(
    'shouldInstallTheMissingRuntimeAndDeclaredDependenciesWhenManifestIs%s',
    async (manifest) => {
      const root = await temporaryDirectory()
      const original = 'project dependency fixture'
      if (manifest !== 'none') await writeFile(join(root, manifest), original)
      let installed = false
      const run = vi.fn(async ({ args }: PythonRuntimeCommand): Promise<void> => {
        if (args.includes('venv')) await createEnvironment(root)
        if (args.includes('install')) installed = true
        if (args[0] === '-c' && args[1]?.includes('strands_harness') && !installed) throw missing()
      })

      const python = await preparePythonRuntime(root, { run, interpreter: '/python/3.12' })

      expect(run.mock.calls[0]?.[0].command).toBe('/python/3.12')
      expect(commands(run)).toContainEqual(['-I', '-m', 'venv', '.venv'])
      const installation = run.mock.calls.find(([request]) => request.args.includes('install'))![0]
      expect(installation.command).toBe(python)
      expect(installation.args).toEqual([
        '-I',
        '-m',
        'pip',
        'install',
        '--disable-pip-version-check',
        ...(manifest === 'requirements.txt' ? ['-r', manifest] : manifest === 'pyproject.toml' ? ['.'] : []),
        expect.stringMatching(/^strands-harness~=\d+\.\d+\.0$/),
      ])
      expect(installation.args).not.toContain('--user')
      if (manifest !== 'none') expect(await readFile(join(root, manifest), 'utf8')).toBe(original)
      expect(await readdir(join(root, '.strands/state'))).toEqual([])
    }
  )

  it('shouldBootstrapPipWhenAnExistingProjectEnvironmentHasNoPip', async () => {
    const root = await temporaryDirectory()
    const python = await createEnvironment(root)
    let installed = false
    const run = vi.fn(async ({ command, args }: PythonRuntimeCommand): Promise<void> => {
      expect(command).toBe(python)
      if (args.includes('install')) installed = true
      if (
        args[0] === '-c' &&
        (args[1]?.includes('find_spec("pip")') || (args[1]?.includes('strands_harness') && !installed))
      )
        throw missing()
    })

    await preparePythonRuntime(root, { run })

    expect(commands(run)).toContainEqual(['-I', '-m', 'ensurepip'])
    expect(commands(run)).not.toContainEqual(['-I', '-m', 'venv', '.venv'])
  })

  it('shouldKeepAWorkingLinkedEnvironmentUnchangedWhenOnlyProbing', async () => {
    const root = await temporaryDirectory()
    const other = await temporaryDirectory()
    await createEnvironment(other)
    await symlink(join(other, '.venv'), join(root, '.venv'), 'junction')
    const run = vi.fn(async (_request: PythonRuntimeCommand): Promise<void> => undefined)

    expect(await preparePythonRuntime(root, { run })).toBe(runtimePath(root))
    expect(run).toHaveBeenCalledOnce()
    expect((await lstat(join(root, '.venv'))).isSymbolicLink()).toBe(true)
  })

  it('shouldRefuseToInstallIntoALinkedEnvironmentWhenTheRuntimeIsMissing', async () => {
    const root = await temporaryDirectory()
    const other = await temporaryDirectory()
    await createEnvironment(other)
    await symlink(join(other, '.venv'), join(root, '.venv'), 'junction')
    const run = vi.fn(async (_request: PythonRuntimeCommand): Promise<void> => {
      throw missing()
    })

    await expect(preparePythonRuntime(root, { run })).rejects.toThrow('Cannot install into a linked')

    expect(run).toHaveBeenCalledOnce()
    expect(await readdir(other)).toEqual(['.venv'])
  })

  it('shouldNotInstallWhenTheExistingHarnessImportFailsForAnotherReason', async () => {
    const root = await temporaryDirectory()
    await createEnvironment(root)
    const run = vi.fn(async (_request: PythonRuntimeCommand): Promise<void> => {
      throw Object.assign(new Error('ImportError: broken runtime'), { code: 1 })
    })

    await expect(preparePythonRuntime(root, { run })).rejects.toThrow('ImportError: broken runtime')

    expect(run).toHaveBeenCalledOnce()
    expect(await readdir(root)).toEqual(['.venv'])
  })

  it('shouldPreserveTheEnvironmentAndReleaseTheLockWhenInstallationFails', async () => {
    const root = await temporaryDirectory()
    await createEnvironment(root)
    const run = vi.fn(async ({ args }: PythonRuntimeCommand): Promise<void> => {
      if (args[1]?.includes('strands_harness')) throw missing()
      if (args.includes('install')) throw new Error('Package index unavailable')
    })

    await expect(preparePythonRuntime(root, { run })).rejects.toThrow('Package index unavailable')

    expect(await readFile(runtimePath(root), 'utf8')).toBe('fixture interpreter')
    expect(await readdir(join(root, '.strands/state'))).toEqual([])
  })

  it('shouldStopBeforeInstallingWhenTheInterpreterIsTooOld', async () => {
    const root = await temporaryDirectory()
    const run = vi.fn(async (_request: PythonRuntimeCommand): Promise<void> => {
      throw Object.assign(new Error('unsupported version'), { code: 43 })
    })

    await expect(preparePythonRuntime(root, { run, interpreter: '/python/old' })).rejects.toThrow(
      'Python 3.10 or newer'
    )
    expect(run).toHaveBeenCalledOnce()
    await expect(lstat(join(root, '.venv'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('shouldStopBeforeFilesystemChangesWhenCancelled', async () => {
    const root = await temporaryDirectory()
    const abort = new AbortController()
    abort.abort(new Error('cancelled'))
    const run = vi.fn(async (_request: PythonRuntimeCommand): Promise<void> => undefined)

    await expect(preparePythonRuntime(root, { run, signal: abort.signal })).rejects.toThrow('cancelled')
    expect(run).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
  })
})

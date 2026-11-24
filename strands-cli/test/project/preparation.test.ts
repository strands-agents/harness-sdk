import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cachedPreparation,
  executePreparation,
  preparationCacheState,
  preparationFailure,
  redactPreparationOutput,
  ProjectPreparationError,
  savePreparationCache,
} from '../../src/project/preparation.js'
import { planProjectPreparation } from '../../src/project/preparation-plan.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const fixture = async (build: string) => {
  const root = await temporaryDirectory()
  await writeFile(join(root, 'agent.ts'), 'export const agent = {}')
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'setup-fixture', version: '1.0.0', scripts: { build: 'node build.cjs' } })
  )
  await writeFile(join(root, 'build.cjs'), build)
  return { root, entrypoint: join(root, 'agent.ts'), language: 'typescript' as const }
}

const COUNTING_BUILD =
  "const fs=require('node:fs'); fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/agent.js',fs.readFileSync('agent.ts')); fs.appendFileSync('dist/runs','x')"

const manualProject = async () => {
  const root = await temporaryDirectory()
  await writeFile(join(root, 'agent.ts'), 'export const agent = {}')
  return { root, entrypoint: join(root, 'agent.ts'), language: 'typescript' as const }
}

const preparationLock = (root: string): string => join(root, '.strands', 'state', 'setup', 'prepare.lock')

const stoppedProcessId = async (): Promise<number> => {
  const child = spawn(process.execPath, ['-e', ''])
  await new Promise((resolve) => child.once('exit', resolve))
  return child.pid!
}

describe('project preparation execution', () => {
  it('shouldInstallAndBuildWithoutCreatingALockWhenNoneWasDeclared', async () => {
    const project = await fixture("require('node:fs').writeFileSync('built.txt', 'built')")
    const source = await readFile(project.entrypoint, 'utf8')
    const progress = vi.fn()

    const log = await executePreparation(await planProjectPreparation(project), { progress })

    expect(await readFile(join(project.root, 'built.txt'), 'utf8')).toBe('built')
    expect(await readFile(project.entrypoint, 'utf8')).toBe(source)
    await expect(readFile(join(project.root, 'package-lock.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(progress.mock.calls.map(([value]) => value.stage)).toEqual(['dependencies', 'build'])
    expect(await readFile(log, 'utf8')).toContain('npm --global=false run build')
  }, 30000)

  it('shouldKeepFailedBuildDetailsAndRedactCredentialsInItsLog', async () => {
    const project = await fixture("console.error('Build failed ' + process.env.TEST_API_KEY); process.exit(1)")
    vi.stubEnv('TEST_API_KEY', 'sensitive-value-12345')
    const plan = await planProjectPreparation(project)

    let failure: ProjectPreparationError | undefined
    try {
      await executePreparation(plan)
    } catch (error) {
      if (!(error instanceof ProjectPreparationError)) throw error
      failure = error
    }

    expect(failure?.failure.stage).toBe('build')
    expect(failure?.failure.action).toContain('Retry')
    expect(failure?.failure.command).toBe('npm --global=false run build')
    expect(failure?.failure.details).not.toContain('sensitive-value-12345')
    expect(await readFile(failure!.failure.logPath!, 'utf8')).toContain('[redacted]')
    expect(await readFile(failure!.failure.logPath!, 'utf8')).not.toContain('sensitive-value-12345')
  }, 30000)

  it('shouldKeepNpmInstallationLocalWhenGlobalDefaultsAreInherited', async () => {
    const project = await fixture("require('node:fs').writeFileSync('built.txt', 'local')")
    const outside = await temporaryDirectory()
    vi.stubEnv('npm_config_global', 'true')
    vi.stubEnv('npm_config_prefix', outside)
    vi.stubEnv('NPM_CONFIG_LOCATION', 'global')
    await writeFile(join(project.root, '.npmrc'), `global=true\nprefix=${outside}\n`)

    await executePreparation(await planProjectPreparation(project))

    expect(await readdir(outside)).toEqual([])
    expect(await readFile(join(project.root, 'built.txt'), 'utf8')).toBe('local')
  }, 30000)

  it.each([
    [
      'AStoppedProcess',
      async (lock: string) => {
        await mkdir(lock, { recursive: true })
        await writeFile(join(lock, `${await stoppedProcessId()}-${randomUUID()}`), '')
      },
    ],
    ['AnOlderStrandsVersion', (lock: string) => mkdir(lock, { recursive: true })],
  ])('shouldTakeOverThePreparationLockWhenItWasLeftBy%s', async (_case, leave) => {
    const project = await manualProject()
    const lock = preparationLock(project.root)
    await leave(lock)

    const log = await executePreparation(await planProjectPreparation(project))

    expect(dirname(log)).toBe(dirname(lock))
    expect(await readdir(dirname(lock))).not.toContain('prepare.lock')
  })

  it('shouldAskTheUserToWaitWhenALiveProcessIsPreparingTheProject', async () => {
    const project = await manualProject()
    const lock = preparationLock(project.root)
    const owner = `${process.pid}-${randomUUID()}`
    await mkdir(lock, { recursive: true })
    await writeFile(join(lock, owner), '')
    const plan = await planProjectPreparation(project)
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 10_001))

    const error = await executePreparation(plan).catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(ProjectPreparationError)
    expect((error as ProjectPreparationError).failure.action).toBe(
      'Wait until the other strands process finishes, then Retry.'
    )
    expect((error as ProjectPreparationError).failure.details).toContain(String(process.pid))
    expect(await readdir(lock)).toEqual([owner])
  })

  it.each([
    ['ALockFolder', 'EACCES: permission denied, mkdir /work/.strands/state/python-runtime.lock', false],
    ['ABlockedDownload', 'The download was blocked by the proxy', false],
    ['TheNpmLockfile', 'npm ci can only install packages when package.json and package-lock.json are in sync', true],
    ['TheUvLockfile', 'The lockfile at `uv.lock` needs to be updated, but `--locked` was provided', true],
  ])('shouldBlameTheLockfileOnlyWhenTheErrorNames%s', (_case, message, lockfile) => {
    const failure = preparationFailure(new Error(message))

    expect(failure.action.includes('lockfile mismatch')).toBe(lockfile)
  })

  it('shouldRedactTheDisplayedCommandWhenACommandContainsCredentials', () => {
    const failure = preparationFailure(new Error('download failed'), {
      stage: 'dependencies',
      command: 'pip install https://user:review-secret@example.test/pkg.whl',
      logPath: '/tmp/setup.log',
    })

    expect(failure.command).not.toContain('review-secret')
    expect(failure.command).toContain('[redacted]')
  })

  it('shouldRejectAStalePreviewBeforeRunningCommands', async () => {
    const project = await fixture('')
    const plan = await planProjectPreparation(project)
    await writeFile(join(project.root, 'package.json'), '{}')

    await expect(executePreparation(plan)).rejects.toThrow('manifests changed')
    await expect(readFile(join(project.root, 'built.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('shouldExplainLocalPackageInstallationWhenAnImportIsMissing', () => {
    const failure = preparationFailure(new Error("No module named 'refund_desk'"))
    expect(failure.action).toContain('project root')
    expect(failure.action).toContain('editable install')
    expect(failure.action).not.toContain('pip install refund_desk')
  })

  it('shouldRedactTokensAndAuthenticatedUrlsWithoutLosingTheError', () => {
    const output = redactPreparationOutput(
      'Failed https://user:password@packages.test/simple?token=abc123 API_KEY=secret-value',
      {}
    )
    expect(output).toContain('Failed')
    expect(output).not.toContain('password')
    expect(output).not.toContain('abc123')
    expect(output).not.toContain('secret-value')
  })
})

describe('reusable project preparation', () => {
  it('shouldSkipInstallAndBuildWhenTheProjectAndEnvironmentAreUnchanged', async () => {
    const project = await fixture(COUNTING_BUILD)
    await executePreparation(await planProjectPreparation(project))
    const progress = vi.fn()

    const log = await executePreparation(await planProjectPreparation(project), { progress })

    expect(progress).not.toHaveBeenCalled()
    expect(await readFile(join(project.root, 'dist/runs'), 'utf8')).toBe('x')
    expect(await readFile(log, 'utf8')).toContain('Reused unchanged project preparation')
  }, 30000)

  it('shouldRebuildWithoutInstallingWhenOnlySourceChanges', async () => {
    const project = await fixture(COUNTING_BUILD)
    await executePreparation(await planProjectPreparation(project))
    await writeFile(project.entrypoint, 'export const agent = {name: "edited"}')
    const progress = vi.fn()

    await executePreparation(await planProjectPreparation(project), { progress })

    expect(progress.mock.calls.map(([step]) => step.stage)).toEqual(['build'])
    expect(await readFile(join(project.root, 'dist/runs'), 'utf8')).toBe('xx')
  }, 30000)

  it('shouldInstallAgainWhenTheManifestChanges', async () => {
    const project = await fixture(COUNTING_BUILD)
    await executePreparation(await planProjectPreparation(project))
    const path = join(project.root, 'package.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...manifest, description: 'changed' }))
    const progress = vi.fn()

    await executePreparation(await planProjectPreparation(project), { progress })

    expect(progress.mock.calls.map(([step]) => step.stage)).toEqual(['dependencies', 'build'])
  }, 30000)

  it('shouldRebuildWhenAnOutputDirectoryIsRemoved', async () => {
    const project = await fixture(COUNTING_BUILD)
    await executePreparation(await planProjectPreparation(project))
    await rm(join(project.root, 'dist'), { recursive: true })
    const progress = vi.fn()

    await executePreparation(await planProjectPreparation(project), { progress })

    expect(progress.mock.calls.map(([step]) => step.stage)).toEqual(['build'])
  }, 30000)

  it('shouldRebuildWhenANestedBuildOutputIsRemoved', async () => {
    const project = await fixture(COUNTING_BUILD)
    await executePreparation(await planProjectPreparation(project))
    await rm(join(project.root, 'dist/agent.js'))
    const progress = vi.fn()

    await executePreparation(await planProjectPreparation(project), { progress })

    expect(progress.mock.calls.map(([step]) => step.stage)).toEqual(['build'])
    expect(await readFile(join(project.root, 'dist/agent.js'), 'utf8')).toContain('agent')
  }, 30000)

  it('shouldRebuildWhenTheBuildEnvironmentFileChanges', async () => {
    const project = await fixture(
      "const fs=require('node:fs'); fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/value',fs.readFileSync('.env.production'))"
    )
    await writeFile(join(project.root, '.env.production'), 'ENDPOINT=first')
    await executePreparation(await planProjectPreparation(project))
    await writeFile(join(project.root, '.env.production'), 'ENDPOINT=second')
    const progress = vi.fn()

    await executePreparation(await planProjectPreparation(project), { progress })

    expect(progress.mock.calls.map(([step]) => step.stage)).toEqual(['build'])
    expect(await readFile(join(project.root, 'dist/value'), 'utf8')).toBe('ENDPOINT=second')
  }, 30000)

  it('shouldNotReuseBuildOutputsWhenTheyExceedTheFingerprintLimit', async () => {
    const project = await fixture(COUNTING_BUILD)
    await mkdir(join(project.root, 'dist'))
    const output = join(project.root, 'dist/large.bin')
    await writeFile(output, '')
    await truncate(output, 33 * 1024 * 1024)
    const plan = await planProjectPreparation(project)
    const marker = join(project.root, 'prepared.json')
    await savePreparationCache(marker, await preparationCacheState(plan), '/tmp/log')

    expect((await cachedPreparation(marker, await preparationCacheState(plan))).build).toBe(false)
  })

  it('shouldInvalidateDependenciesWhenNestedRequirementsChange', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'agent.py'), 'agent = None')
    await mkdir(join(root, 'requirements'))
    await writeFile(join(root, 'requirements.txt'), '-r requirements/base.txt\n')
    await writeFile(join(root, 'requirements/base.txt'), '-c constraints.txt\npackage==1.0\n')
    await writeFile(join(root, 'requirements/constraints.txt'), 'other==1.0\n')
    const plan = await planProjectPreparation({ root, entrypoint: join(root, 'agent.py'), language: 'python' })
    const before = await preparationCacheState(plan)

    await writeFile(join(root, 'requirements/constraints.txt'), 'other==2.0\n')
    const after = await preparationCacheState(plan)

    expect(after.dependencies).not.toBe(before.dependencies)
  })

  it('shouldDisableDependencyReuseWhenRequirementsIncludeARemoteFile', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'agent.py'), 'agent = None')
    await writeFile(join(root, 'requirements.txt'), '-r https://example.test/requirements.txt\n')
    const plan = await planProjectPreparation({ root, entrypoint: join(root, 'agent.py'), language: 'python' })

    expect((await preparationCacheState(plan)).dependencies).toBeUndefined()
  })

  it('shouldForceRepairWhenRequestedAfterAnEntrypointFailure', async () => {
    const project = await fixture(COUNTING_BUILD)
    const plan = await planProjectPreparation(project)
    await executePreparation(plan)
    const progress = vi.fn()

    await executePreparation(plan, { progress, force: true })

    expect(progress.mock.calls.map(([step]) => step.stage)).toEqual(['dependencies', 'build'])
  }, 30000)

  it('shouldInvalidateDependenciesWhenAnInstalledPackageDisappears', async () => {
    const root = await temporaryDirectory()
    const entrypoint = join(root, 'agent.ts')
    await writeFile(entrypoint, 'export const agent = {}')
    await writeFile(join(root, 'package.json'), '{"dependencies":{"fixture-package":"1.0.0"}}')
    await mkdir(join(root, 'node_modules/fixture-package'), { recursive: true })
    await writeFile(
      join(root, 'node_modules/fixture-package/package.json'),
      '{"name":"fixture-package","version":"1.0.0"}'
    )
    const plan = await planProjectPreparation({ root, entrypoint, language: 'typescript' })
    const marker = join(root, 'prepared.json')
    await savePreparationCache(marker, await preparationCacheState(plan), '/tmp/log')
    await rm(join(root, 'node_modules/fixture-package'), { recursive: true })

    expect((await cachedPreparation(marker, await preparationCacheState(plan))).dependencies).toBe(false)
  })

  it('shouldRejectAReplacedPythonEnvironmentEvenWhenTheManifestsMatch', async () => {
    const root = await temporaryDirectory()
    const entrypoint = join(root, 'agent.py')
    await writeFile(entrypoint, 'agent = None')
    const executable = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    const site = join(
      root,
      '.venv',
      process.platform === 'win32' ? 'Lib/site-packages' : 'lib/python3.12/site-packages'
    )
    await mkdir(site, { recursive: true })
    await mkdir(join(executable, '..'), { recursive: true })
    await writeFile(executable, 'runtime-a')
    await writeFile(join(root, '.venv/pyvenv.cfg'), 'version = 3.12')
    const plan = await planProjectPreparation({ root, entrypoint, language: 'python' })
    const marker = join(root, 'prepared.json')
    await savePreparationCache(marker, await preparationCacheState(plan), '/tmp/log')
    await writeFile(executable, 'runtime-b-with-different-content')

    expect((await cachedPreparation(marker, await preparationCacheState(plan))).dependencies).toBe(false)
  })
})

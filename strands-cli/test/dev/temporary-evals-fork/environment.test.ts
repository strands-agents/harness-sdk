import { existsSync } from 'node:fs'
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { STRANDS_EVALS_REQUIREMENT, STRANDS_EVALS_VERSION } from '../../../src/dev/evals-package.js'
import {
  installedEvalsSkill,
  prepareTemporaryOptimizerEnvironment,
  temporaryVenvPython,
  type TemporaryCommandRequest,
} from '../../../src/dev/temporary-evals-fork/environment.js'
import { writeFileAt } from '../../fixtures/optimizer-run.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

interface Layout {
  projectRoot: string
  workspaceDirectory: string
  projectPaths: string[]
}

interface FakePython {
  version?: string
  pipConfig?: string
}

const DAY_MS = 24 * 60 * 60 * 1000
const PACKAGES_FILE = 'temporary_strands_dev_packages.pth'
const MARKER_FILE = 'temporary-evals-fork.json'

const writeExecutable = async (path: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, 'fixture interpreter')
}

const layout = async (): Promise<Layout> => {
  const projectRoot = await temporaryDirectory()
  await writeExecutable(temporaryVenvPython(join(projectRoot, '.venv')))
  return {
    projectRoot,
    workspaceDirectory: join(projectRoot, 'strands-dev'),
    projectPaths: [join(projectRoot, '.venv/lib/python3.12/site-packages')],
  }
}

const pythonTag = (version: string): string => `cpython-${version.split('.').slice(0, 2).join('')}-linux-x86_64`

const sharedFolder = (version = '3.12.4', release: string = STRANDS_EVALS_VERSION): string =>
  join(homedir(), '.strands', 'temporary-evals', `${release}-${pythonTag(version)}`)

const buildingFolder = (): string => `${sharedFolder()}.${process.pid}.tmp`

const sitePackagesOf = (venv: string): string => join(venv, 'lib', 'site-packages')

const workspaceVenv = ({ workspaceDirectory }: Layout): string => join(workspaceDirectory, 'tmp/.state/evals-env')

const siteDirectories = (...paths: string[]): string =>
  paths.map((path) => `import site; site.addsitedir(${JSON.stringify(path)})\n`).join('')

const packagesHook = (paths: Layout): Promise<string> =>
  readFile(join(sitePackagesOf(workspaceVenv(paths)), PACKAGES_FILE), 'utf8')

const usedDaysAgo = async (folder: string, days: number): Promise<void> => {
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, MARKER_FILE), '{}')
  const used = new Date(Date.now() - days * DAY_MS)
  await utimes(join(folder, MARKER_FILE), used, used)
}

const fakeRunner = ({ projectPaths }: Layout, { version = '3.12.4', pipConfig = '' }: FakePython = {}) =>
  vi.fn(async ({ command, args }: TemporaryCommandRequest): Promise<string> => {
    if (args[1]?.includes('platform.python_version'))
      return JSON.stringify({ version, tag: pythonTag(version), paths: projectPaths })
    if (args[0] === '-m' && args[1] === 'venv') {
      await writeExecutable(temporaryVenvPython(args[3]!))
      await mkdir(sitePackagesOf(args[3]!), { recursive: true })
      return ''
    }
    if (args[1]?.includes('site.getsitepackages()[0]')) return `${sitePackagesOf(dirname(dirname(command)))}\n`
    if (args.join(' ') === '-m pip config list') return pipConfig
    return ''
  })

const requests = (run: ReturnType<typeof fakeRunner>): TemporaryCommandRequest[] =>
  run.mock.calls.map(([request]) => request)

const installs = (run: ReturnType<typeof fakeRunner>): TemporaryCommandRequest[] =>
  requests(run).filter((request) => request.args.includes('install'))

const venvRequests = (run: ReturnType<typeof fakeRunner>): TemporaryCommandRequest[] =>
  requests(run).filter((request) => request.args[1] === 'venv')

describe('TEMPORARY optimizer environment', () => {
  beforeEach(async () => {
    const home = await temporaryDirectory()
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('shouldInstallStrandsEvalsWithTheProjectPackagesVisibleWhenTheEnvironmentIsMissing', async () => {
    const paths = await layout()
    const run = fakeRunner(paths)

    const python = await prepareTemporaryOptimizerEnvironment(paths, { run })

    expect(python).toBe(temporaryVenvPython(workspaceVenv(paths)))
    expect(await packagesHook(paths)).toBe(siteDirectories(sitePackagesOf(sharedFolder()), ...paths.projectPaths))
    expect(existsSync(sitePackagesOf(sharedFolder()))).toBe(true)
    const [install] = installs(run)
    expect(install?.command).toBe(temporaryVenvPython(buildingFolder()))
    expect(install?.args).toContain(STRANDS_EVALS_REQUIREMENT)
    expect(install?.env?.PIP_REQUIRE_VIRTUALENV).toBe('true')
  })

  it('shouldReuseTheEnvironmentWhenTheEvalsVersionAndTheProjectPythonAreUnchanged', async () => {
    const paths = await layout()
    await prepareTemporaryOptimizerEnvironment(paths, { run: fakeRunner(paths) })
    const run = fakeRunner(paths)

    await prepareTemporaryOptimizerEnvironment(paths, { run })

    expect(run).toHaveBeenCalledTimes(1)
    expect(installs(run)).toEqual([])
  })

  it('shouldRebuildTheEnvironmentWhenTheProjectPythonChanges', async () => {
    const paths = await layout()
    await prepareTemporaryOptimizerEnvironment(paths, { run: fakeRunner(paths, { version: '3.12.4' }) })
    const run = fakeRunner(paths, { version: '3.13.1' })

    await prepareTemporaryOptimizerEnvironment(paths, { run })

    expect(installs(run)).toHaveLength(1)
    expect(await packagesHook(paths)).toBe(
      siteDirectories(sitePackagesOf(sharedFolder('3.13.1')), ...paths.projectPaths)
    )
  })

  it('shouldExplainHowToPrepareTheProjectWhenItHasNoPythonEnvironment', async () => {
    const projectRoot = await temporaryDirectory()

    await expect(
      prepareTemporaryOptimizerEnvironment({ projectRoot, workspaceDirectory: join(projectRoot, 'strands-dev') })
    ).rejects.toThrow('Restart strands dev on this agent so that it prepares the project')
  })

  it('shouldUseTheSystemPythonWithoutProjectPackagesWhenTheAgentIsTypeScript', async () => {
    vi.stubEnv('PYTHON', '/opt/python3.12')
    const paths = await layout()
    const run = fakeRunner(paths)

    await prepareTemporaryOptimizerEnvironment({ ...paths, language: 'typescript' }, { run })

    expect(venvRequests(run).map(({ command }) => command)).toEqual(['/opt/python3.12', '/opt/python3.12'])
    expect(await packagesHook(paths)).toBe(siteDirectories(sitePackagesOf(sharedFolder())))
    expect(installs(run)).toHaveLength(1)
  })

  it.each([
    { language: 'python' as const, hint: 'Recreate the project .venv with a newer Python.' },
    { language: 'typescript' as const, hint: 'Set PYTHON to a newer interpreter.' },
  ])('shouldAskForANewerPythonWhenTheBaseInterpreterIsTooOld ($language)', async ({ language, hint }) => {
    const paths = await layout()

    await expect(
      prepareTemporaryOptimizerEnvironment({ ...paths, language }, { run: fakeRunner(paths, { version: '3.9.6' }) })
    ).rejects.toThrow(`needs Python 3.10 or later, but`)
    await expect(
      prepareTemporaryOptimizerEnvironment({ ...paths, language }, { run: fakeRunner(paths, { version: '3.9.6' }) })
    ).rejects.toThrow(hint)
  })

  it.each([
    {
      failing: 'install',
      message:
        /Could not install strands-agents-evals .+:\nERROR: No matching distribution\nCheck your network connection and your pip index settings, then try again\./u,
    },
    {
      failing: 'venv',
      message:
        /Could not create the optimizer environment in .+\nERROR: No matching distribution\nCheck that .+ -m venv works/u,
    },
  ])('shouldSayWhatFailedAndWhatToDoNextWhenAStepFails ($failing)', async ({ failing, message }) => {
    const paths = await layout()
    const succeeding = fakeRunner(paths)
    const run = vi.fn(async (request: TemporaryCommandRequest): Promise<string> => {
      if (request.args.includes(failing))
        throw Object.assign(new Error('Command failed'), { stderr: 'ERROR: No matching distribution\n' })
      return succeeding(request)
    })

    await expect(prepareTemporaryOptimizerEnvironment(paths, { run })).rejects.toThrow(message)
  })

  it('shouldShowThePipErrorWhenPipCannotReachThePackageIndex', async () => {
    const paths = await layout()
    const succeeding = fakeRunner(paths)
    const stderr = [
      "WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after connection broken by 'NewConnectionError'",
      `ERROR: Could not find a version that satisfies the requirement ${STRANDS_EVALS_REQUIREMENT} (from versions: none)`,
      'ERROR: No matching distribution found for strands-agents-evals',
    ].join('\n')
    const run = vi.fn(async (request: TemporaryCommandRequest): Promise<string> => {
      if (request.args.includes('install')) throw Object.assign(new Error('Command failed'), { stderr })
      return succeeding(request)
    })

    await expect(prepareTemporaryOptimizerEnvironment(paths, { run })).rejects.toThrow(
      /ERROR: No matching distribution found for strands-agents-evals/u
    )
  })

  it.each([
    { language: 'python' as const, hint: 'Restart strands dev on this agent so that it prepares the project again' },
    { language: 'typescript' as const, hint: 'Set PYTHON to a working Python 3.10 or later' },
  ])('shouldSayHowToFixPythonWhenItCannotStart ($language)', async ({ language, hint }) => {
    const paths = await layout()
    const run = vi.fn(async (): Promise<string> => {
      throw Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' })
    })

    await expect(prepareTemporaryOptimizerEnvironment({ ...paths, language }, { run })).rejects.toThrow(
      new RegExp(`Could not start .+:\\nspawn python3 ENOENT\\n${hint}`, 'u')
    )
  })

  it('shouldBuildTheEnvironmentOnceWhenTwoCommandsStartTogether', async () => {
    const paths = await layout()
    const run = fakeRunner(paths)

    await Promise.all([
      prepareTemporaryOptimizerEnvironment(paths, { run }),
      prepareTemporaryOptimizerEnvironment(paths, { run }),
    ])

    expect(venvRequests(run).map(({ args }) => args.at(-1))).toEqual([buildingFolder(), workspaceVenv(paths)])
    expect(installs(run)).toHaveLength(1)
  })

  it('shouldFinishTheSharedSetupForTheOtherCallerWhenOneCallerStops', async () => {
    const paths = await layout()
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const base = fakeRunner(paths)
    const run = vi.fn(async (request: TemporaryCommandRequest): Promise<string> => {
      if (request.args.includes('install')) await gate
      return base(request)
    })
    const stop = new AbortController()

    const stopped = prepareTemporaryOptimizerEnvironment(paths, { run, signal: stop.signal })
    const other = prepareTemporaryOptimizerEnvironment(paths, { run })
    await vi.waitFor(() => expect(installs(base)).toHaveLength(0))
    stop.abort(new Error('stopped by the user'))
    release()

    await expect(stopped).rejects.toThrow('stopped by the user')
    await expect(other).resolves.toBe(temporaryVenvPython(workspaceVenv(paths)))
  })

  it('shouldInstallStrandsEvalsOnceWhenTwoWorkspacesUseTheSamePython', async () => {
    const first = await layout()
    const second = await layout()
    const firstRun = fakeRunner(first)
    const secondRun = fakeRunner(second)

    await prepareTemporaryOptimizerEnvironment(first, { run: firstRun })
    await prepareTemporaryOptimizerEnvironment(second, { run: secondRun })

    expect(installs(firstRun)).toHaveLength(1)
    expect(installs(secondRun)).toEqual([])
    expect(await packagesHook(second)).toBe(siteDirectories(sitePackagesOf(sharedFolder()), ...second.projectPaths))
  })

  it('shouldListTheSharedPackagesBeforeEachProjectPathWhenItMakesTheWorkspaceEnvironment', async () => {
    const paths = await layout()
    const projectPaths = [
      join(paths.projectRoot, '.venv/lib/python3.12/site-packages'),
      join(paths.projectRoot, '.venv/lib64/python3.12/site-packages'),
    ]
    const run = fakeRunner({ ...paths, projectPaths })

    await prepareTemporaryOptimizerEnvironment(paths, { run })

    expect(await packagesHook(paths)).toBe(siteDirectories(sitePackagesOf(sharedFolder()), ...projectPaths))
    expect(venvRequests(run).at(-1)).toMatchObject({
      command: temporaryVenvPython(join(paths.projectRoot, '.venv')),
      args: ['-m', 'venv', '--without-pip', workspaceVenv(paths)],
    })
  })

  it('shouldPassThePipIndexSettingsToTheInstallWhenPipIsConfiguredForAnIndex', async () => {
    vi.stubEnv('PIP_INDEX_URL', undefined)
    vi.stubEnv('PIP_TRUSTED_HOST', undefined)
    const paths = await layout()
    const run = fakeRunner(paths, {
      pipConfig: "global.index-url='https://packages.example/simple'\ninstall.trusted-host='packages.example'\n",
    })

    await prepareTemporaryOptimizerEnvironment(paths, { run })

    expect(installs(run)[0]?.env).toMatchObject({
      PIP_INDEX_URL: 'https://packages.example/simple',
      PIP_TRUSTED_HOST: 'packages.example',
      PIP_REQUIRE_VIRTUALENV: 'true',
    })
  })

  it('shouldDeleteTheSharedEnvironmentOfAnotherVersionWhenNothingUsedItForMoreThanSevenDays', async () => {
    const stale = sharedFolder('3.12.4', '1.10.0')
    const recent = sharedFolder('3.12.4', '1.11.0')
    await usedDaysAgo(stale, 8)
    await usedDaysAgo(recent, 6)
    const paths = await layout()

    await prepareTemporaryOptimizerEnvironment(paths, { run: fakeRunner(paths) })

    expect(existsSync(stale)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(sharedFolder())).toBe(true)
  })
})

describe('installed evals skills', () => {
  const installedPackage = async (skill?: string): Promise<string> => {
    const folder = join(await temporaryDirectory(), 'site-packages', 'strands_evals')
    if (skill) await writeFileAt(join(folder, '.agents', 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\n---\n`)
    else await mkdir(folder, { recursive: true })
    return folder
  }

  it('shouldFindTheSkillFolderInTheInstalledPackageWhenTheWheelShipsIt', async () => {
    const folder = await installedPackage('session-converter')
    const run = vi.fn(async (_request: TemporaryCommandRequest): Promise<string> => `${folder}\n`)

    const skill = await installedEvalsSkill('/env/bin/python', 'session-converter', run)

    expect(skill).toBe(join(folder, '.agents', 'skills', 'session-converter'))
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/env/bin/python',
        args: ['-c', expect.stringContaining("find_spec('strands_evals')")],
      })
    )
  })

  it('shouldNameTheVersionAndANextStepWhenTheInstalledPackageHasNoSuchSkill', async () => {
    const folder = await installedPackage()
    const run = vi.fn(async (_request: TemporaryCommandRequest): Promise<string> => `${folder}\n`)

    await expect(installedEvalsSkill('/env/bin/python', 'session-converter', run)).rejects.toThrow(
      `The installed strands-agents-evals ${STRANDS_EVALS_VERSION} has no session-converter skill in ${join(folder, '.agents', 'skills', 'session-converter')}. Restart strands dev, then try again.`
    )
  })
})

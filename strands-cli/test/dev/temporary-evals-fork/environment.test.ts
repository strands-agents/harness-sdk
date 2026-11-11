import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  prepareTemporaryOptimizerEnvironment,
  temporaryVenvPython,
  type TemporaryCommandRequest,
} from '../../../src/dev/temporary-evals-fork/environment.js'
import { TEMPORARY_EVALS_FORK_REQUIREMENT } from '../../../src/dev/temporary-evals-fork/fork.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

interface Layout {
  projectRoot: string
  workspaceDirectory: string
  sitePackages: string
}

const writeExecutable = async (path: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, 'fixture interpreter')
}

const layout = async (): Promise<Layout> => {
  const projectRoot = await temporaryDirectory()
  await writeExecutable(temporaryVenvPython(join(projectRoot, '.venv')))
  const workspaceDirectory = join(projectRoot, 'strands-dev')
  const sitePackages = join(workspaceDirectory, 'tmp/optimization/.venv/lib/python3.12/site-packages')
  return { projectRoot, workspaceDirectory, sitePackages }
}

const fakeRunner = ({ projectRoot, sitePackages }: Layout, version = '3.12.4') =>
  vi.fn(async ({ args }: TemporaryCommandRequest): Promise<string> => {
    if (args[1]?.includes('platform.python_version'))
      return JSON.stringify({ version, paths: [join(projectRoot, '.venv/lib/python3.12/site-packages')] })
    if (args[0] === '-m' && args[1] === 'venv') {
      await writeExecutable(temporaryVenvPython(args[3]!))
      await mkdir(sitePackages, { recursive: true })
      return ''
    }
    if (args[1]?.includes('site.getsitepackages()[0]')) return `${sitePackages}\n`
    return ''
  })

const installs = (run: ReturnType<typeof fakeRunner>): TemporaryCommandRequest[] =>
  run.mock.calls.map(([request]) => request).filter((request) => request.args.includes('install'))

describe('TEMPORARY optimizer environment', () => {
  it('shouldInstallTheForkWithTheProjectPackagesVisibleWhenTheEnvironmentIsMissing', async () => {
    const paths = await layout()
    const run = fakeRunner(paths)

    const python = await prepareTemporaryOptimizerEnvironment(paths, { run })

    expect(python).toBe(temporaryVenvPython(join(paths.workspaceDirectory, 'tmp/optimization/.venv')))
    expect(await readFile(join(paths.sitePackages, 'temporary_strands_dev_project.pth'), 'utf8')).toBe(
      `import site; site.addsitedir(${JSON.stringify(join(paths.projectRoot, '.venv/lib/python3.12/site-packages'))})\n`
    )
    const [install] = installs(run)
    expect(install?.command).toBe(python)
    expect(install?.args).toContain(TEMPORARY_EVALS_FORK_REQUIREMENT)
    expect(install?.env?.PIP_REQUIRE_VIRTUALENV).toBe('true')
  })

  it('shouldReuseTheEnvironmentWhenTheForkAndTheProjectPythonAreUnchanged', async () => {
    const paths = await layout()
    await prepareTemporaryOptimizerEnvironment(paths, { run: fakeRunner(paths) })
    const run = fakeRunner(paths)

    await prepareTemporaryOptimizerEnvironment(paths, { run })

    expect(run).toHaveBeenCalledTimes(1)
    expect(installs(run)).toEqual([])
  })

  it('shouldRebuildTheEnvironmentWhenTheProjectPythonChanges', async () => {
    const paths = await layout()
    await prepareTemporaryOptimizerEnvironment(paths, { run: fakeRunner(paths, '3.12.4') })
    const run = fakeRunner(paths, '3.13.1')

    await prepareTemporaryOptimizerEnvironment(paths, { run })

    expect(installs(run)).toHaveLength(1)
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

    const venv = run.mock.calls.map(([request]) => request).find((request) => request.args[1] === 'venv')
    expect(venv?.command).toBe('/opt/python3.12')
    expect(existsSync(join(paths.sitePackages, 'temporary_strands_dev_project.pth'))).toBe(false)
    expect(installs(run)).toHaveLength(1)
    vi.unstubAllEnvs()
  })

  it.each([
    { language: 'python' as const, hint: 'Recreate the project .venv with a newer Python.' },
    { language: 'typescript' as const, hint: 'Set PYTHON to a newer interpreter.' },
  ])('shouldAskForANewerPythonWhenTheBaseInterpreterIsTooOld ($language)', async ({ language, hint }) => {
    const paths = await layout()

    await expect(
      prepareTemporaryOptimizerEnvironment({ ...paths, language }, { run: fakeRunner(paths, '3.9.6') })
    ).rejects.toThrow(`needs Python 3.10 or later, but`)
    await expect(
      prepareTemporaryOptimizerEnvironment({ ...paths, language }, { run: fakeRunner(paths, '3.9.6') })
    ).rejects.toThrow(hint)
  })

  it.each([
    {
      failing: 'install',
      message:
        /Could not install strands-agents-evals from .+\nERROR: No matching distribution\nCheck your network connection and that git is installed/u,
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

  it('shouldShowTheGitErrorWhenPipCannotFetchTheFork', async () => {
    const paths = await layout()
    const succeeding = fakeRunner(paths)
    const stderr = [
      '  Running command git clone --filter=blob:none --quiet https://github.com/arielnabavian/evals /tmp/pip-req',
      "  fatal: unable to access 'https://github.com/arielnabavian/evals/': Could not resolve host: github.com",
      '  error: subprocess-exited-with-error',
      '  × git clone did not run successfully.',
      '  │ exit code: 128',
      '  ╰─> No available output.',
      'note: This error originates from a subprocess, and is likely not a problem with pip.',
    ].join('\n')
    const run = vi.fn(async (request: TemporaryCommandRequest): Promise<string> => {
      if (request.args.includes('install')) throw Object.assign(new Error('Command failed'), { stderr })
      return succeeding(request)
    })

    await expect(prepareTemporaryOptimizerEnvironment(paths, { run })).rejects.toThrow(
      /Could not resolve host: github\.com/u
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

    expect(run.mock.calls.filter(([request]) => request.args[1] === 'venv')).toHaveLength(1)
  })
})

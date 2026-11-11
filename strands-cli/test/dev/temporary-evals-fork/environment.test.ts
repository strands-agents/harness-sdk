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
    ).rejects.toThrow('Start strands dev once to prepare it')
  })
})

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { temporaryVenvPython, type TemporaryCommandRequest } from '../../../src/dev/temporary-evals-fork/environment.js'
import type { TemporaryEvalsProcess } from '../../../src/dev/temporary-evals-fork/evals-process.js'
import { runTemporaryOptimization } from '../../../src/dev/temporary-evals-fork/optimize.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const NOW = new Date('2026-11-11T15:04:05Z')

const writeFileAt = async (path: string, text = '{}'): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const workspaceFixture = async (
  experiments: string[] = ['support.json'],
  language: 'python' | 'typescript' = 'python'
): Promise<DevWorkspace> => {
  const root = await temporaryDirectory()
  const directory = join(root, 'strands-dev')
  await writeFileAt(temporaryVenvPython(join(root, '.venv')), 'fixture interpreter')
  await Promise.all(experiments.map((name) => writeFileAt(join(directory, 'tmp/experiments', name))))
  return {
    directory,
    root,
    entrypoint: join(root, 'agent.py'),
    config: { version: 1, name: 'desk', language, entrypoint: 'agent.py', origin: { kind: 'discovered' } },
  }
}

const environmentRunner = (workspace: DevWorkspace) =>
  vi.fn(async ({ args }: TemporaryCommandRequest): Promise<string> => {
    if (args[1]?.includes('platform.python_version')) return JSON.stringify({ version: '3.12.4', paths: [] })
    if (args[0] === '-m' && args[1] === 'venv') await writeFileAt(temporaryVenvPython(args[3]!), 'fixture interpreter')
    if (args[1]?.includes('site.getsitepackages()[0]')) {
      const sitePackages = join(workspace.directory!, 'tmp/optimization/.venv/lib/site-packages')
      await mkdir(sitePackages, { recursive: true })
      return sitePackages
    }
    return ''
  })

const succeeding = (stdout = 'ships candidate 3\nrecord: somewhere\n') =>
  vi.fn(async (process: TemporaryEvalsProcess) => {
    process.onLine('candidate  0 baseline complete n=4 Contains 0.5')
    return { code: 0, stdout, stderrTail: [] }
  })

describe('TEMPORARY dev optimization', () => {
  it('shouldRunTheForkCommandAgainstTheWorkspaceAgentWhenOneExperimentExists', async () => {
    const workspace = await workspaceFixture()
    const spawnOptimizer = succeeding()
    const progress: string[] = []

    const outcome = await runTemporaryOptimization(
      { workspace, forkArguments: ['--width', '2'], now: () => NOW, onProgress: (line) => progress.push(line) },
      { run: environmentRunner(workspace), spawnOptimizer }
    )

    const record = join(workspace.directory!, 'tmp/optimization/20261111-150405-support')
    const [{ command, args, cwd, env }] = spawnOptimizer.mock.calls[0]!
    expect(command).toBe(temporaryVenvPython(join(workspace.directory!, 'tmp/optimization/.venv')))
    expect(args).toEqual([
      '-m',
      'strands_evals.cli',
      'optimize',
      join(workspace.directory!, 'tmp/experiments/support.json'),
      '--agent',
      workspace.entrypoint,
      '--record',
      record,
      '--rich',
      '--width',
      '2',
    ])
    expect(cwd).toBe(workspace.root)
    expect(env.PATH?.startsWith(dirname(command))).toBe(true)
    expect(outcome).toEqual({
      experiment: join(workspace.directory!, 'tmp/experiments/support.json'),
      record,
      summary: ['ships candidate 3', 'record: somewhere'],
    })
    expect(progress).toContain('candidate  0 baseline complete n=4 Contains 0.5')
  })

  it('shouldUseTheNamedExperimentWhenSeveralExist', async () => {
    const workspace = await workspaceFixture(['billing.json', 'support.json'])
    const spawnOptimizer = succeeding()

    await runTemporaryOptimization(
      { workspace, experiment: 'billing', now: () => NOW },
      { run: environmentRunner(workspace), spawnOptimizer }
    )

    expect(spawnOptimizer.mock.calls[0]![0].args[3]).toBe(join(workspace.directory!, 'tmp/experiments/billing.json'))
  })

  it.each([
    { experiments: [], requested: undefined, message: 'Draft cases with /experiment in a strands dev chat' },
    {
      experiments: ['billing.json', 'support.json'],
      requested: undefined,
      message: 'for example strands dev optimize billing',
    },
    {
      experiments: ['support.json'],
      requested: 'refunds',
      message: 'Use one of support, or draft cases with /experiment',
    },
    { experiments: [], requested: 'refunds', message: 'then run strands dev optimize again' },
    {
      experiments: ['support.json'],
      requested: './missing/refunds.json',
      message: 'Check the path, or name an experiment in',
    },
  ])('shouldExplainTheExperimentChoiceWhen$message', async ({ experiments, requested, message }) => {
    const workspace = await workspaceFixture(experiments)
    const spawnOptimizer = succeeding()

    await expect(
      runTemporaryOptimization(
        { workspace, ...(requested ? { experiment: requested } : {}) },
        { run: environmentRunner(workspace), spawnOptimizer }
      )
    ).rejects.toThrow(message)
    expect(spawnOptimizer).not.toHaveBeenCalled()
  })

  it.each([['--agent', 'other.py'], ['--record=elsewhere'], ['--json'], ['--rich'], ['--typescript-runner', 'node']])(
    'shouldRejectFlagsThatStrandsDevOwnsWhen%sIsPassed',
    async (...forkArguments) => {
      const workspace = await workspaceFixture()
      const run = environmentRunner(workspace)

      await expect(runTemporaryOptimization({ workspace, forkArguments }, { run })).rejects.toThrow('strands dev sets')
      expect(run).not.toHaveBeenCalled()
    }
  )

  it('shouldStartTheTypescriptRunnerAndUseTheSystemPythonWhenTheWorkspaceAgentIsTypeScript', async () => {
    vi.stubEnv('PYTHON', '/opt/python3.12')
    const workspace = await workspaceFixture(['support.json'], 'typescript')
    const run = environmentRunner(workspace)
    const spawnOptimizer = succeeding()

    await runTemporaryOptimization({ workspace }, { run, spawnOptimizer })

    const { args } = spawnOptimizer.mock.calls[0]![0]
    const runner = args[args.indexOf('--typescript-runner') + 1]!
    expect(runner).toMatch(/^'.+' '.+typescript-runner-main\.js'$/u)
    expect(runner).toContain(process.execPath)
    const venv = run.mock.calls.map(([request]) => request).find((request) => request.args[1] === 'venv')
    expect(venv?.command).toBe('/opt/python3.12')
    vi.unstubAllEnvs()
  })

  it('shouldReportTheOptimizerOutputWhenItFails', async () => {
    const workspace = await workspaceFixture()
    const spawnOptimizer = vi.fn(async () => ({
      code: 2,
      stdout: '',
      stderrTail: ['strands-evals: error: agent.py must export a Strands Agent as "agent"'],
    }))

    await expect(
      runTemporaryOptimization({ workspace }, { run: environmentRunner(workspace), spawnOptimizer })
    ).rejects.toThrow(
      /stopped with exit code 2: agent\.py must export a Strands Agent .*\nThe full optimizer output is in .+\.log\./u
    )
  })

  it.each([
    { given: { AWS_REGION: 'us-east-2', AWS_DEFAULT_REGION: 'eu-west-1' }, expected: 'us-east-2' },
    { given: { AWS_DEFAULT_REGION: 'eu-west-1' }, expected: 'eu-west-1' },
    { given: {}, expected: undefined },
  ])('shouldSetTheDefaultRegionLikeTheDevWorkerWhenTheEnvironmentIs$given', async ({ given, expected }) => {
    const workspace = await workspaceFixture()
    const spawnOptimizer = succeeding()
    const environment = { PATH: '/usr/bin', ...given }

    await runTemporaryOptimization({ workspace, environment }, { run: environmentRunner(workspace), spawnOptimizer })

    expect(spawnOptimizer.mock.calls[0]![0].env.AWS_DEFAULT_REGION).toBe(expected)
    expect(environment).toEqual({ PATH: '/usr/bin', ...given })
  })

  it('shouldPrepareTheProjectAfterTheChecksPassAndBeforeTheOptimizerRuns', async () => {
    const workspace = await workspaceFixture()
    const order: string[] = []
    const run = environmentRunner(workspace)
    const spawnOptimizer = vi.fn(async () => {
      order.push('optimize')
      return { code: 0, stdout: '', stderrTail: [] }
    })

    await runTemporaryOptimization(
      { workspace, prepare: async () => void order.push('prepare') },
      { run: async (request) => (order.push('environment'), run(request)), spawnOptimizer }
    )

    expect(order[0]).toBe('prepare')
    expect(order.at(-1)).toBe('optimize')
  })

  it.each([
    { language: 'typescript' as const, experiments: [], message: 'There is no experiment to optimize yet' },
    { language: 'python' as const, experiments: [], message: 'There is no experiment to optimize yet' },
  ])('shouldNotPrepareTheProjectWhen$message ($language)', async ({ language, experiments, message }) => {
    const workspace = await workspaceFixture(experiments, language)
    const prepare = vi.fn(async () => {})

    await expect(runTemporaryOptimization({ workspace, prepare })).rejects.toThrow(message)
    expect(prepare).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'shouldStreamTheOptimizerStderrAndReturnItsStdoutWhenTheRealProcessRuns',
    async () => {
      const workspace = await workspaceFixture()
      const run = environmentRunner(workspace)
      const python = temporaryVenvPython(join(workspace.directory!, 'tmp/optimization/.venv'))
      const progress: string[] = []
      const script = "#!/bin/sh\necho 'candidate  0 baseline complete' >&2\necho 'ships candidate 0: {}'\nexit 0\n"

      const outcome = await runTemporaryOptimization(
        { workspace, onProgress: (line) => progress.push(line) },
        {
          run: async (request) => {
            const output = await run(request)
            if (request.args.includes('install')) {
              await writeFile(python, script)
              await chmod(python, 0o755)
            }
            return output
          },
        }
      )

      expect(progress).toContain('candidate  0 baseline complete')
      expect(outcome.summary).toEqual(['ships candidate 0: {}'])
      expect(await readFile(`${outcome.record}.log`, 'utf8')).toBe('candidate  0 baseline complete\n')
    }
  )

  it.skipIf(process.platform === 'win32')('shouldReportTheStderrTailWhenTheRealProcessFails', async () => {
    const workspace = await workspaceFixture()
    const run = environmentRunner(workspace)
    const python = temporaryVenvPython(join(workspace.directory!, 'tmp/optimization/.venv'))
    const script = "#!/bin/sh\necho 'strands-evals: error: the record is in use' >&2\nexit 2\n"

    await expect(
      runTemporaryOptimization(
        { workspace },
        {
          run: async (request) => {
            const output = await run(request)
            if (request.args.includes('install')) {
              await writeFile(python, script)
              await chmod(python, 0o755)
            }
            return output
          },
        }
      )
    ).rejects.toThrow(/stopped with exit code 2: the record is in use\nThe full optimizer output is in .+\.log\./u)
  })
})

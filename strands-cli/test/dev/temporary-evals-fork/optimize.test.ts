import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { temporaryVenvPython, type TemporaryCommandRequest } from '../../../src/dev/temporary-evals-fork/environment.js'
import type { TemporaryEvalsProcess } from '../../../src/dev/temporary-evals-fork/evals-process.js'
import { runTemporaryOptimization } from '../../../src/dev/temporary-evals-fork/optimize.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const NOW = new Date('2026-11-11T15:04:05Z')
const STAMP = '20261111-150405'

const writeFileAt = async (path: string, text = '{}'): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const experimentFile = (directory: string, name: string): string => join(directory, 'experiments', name, `${name}.json`)

const workspaceFixture = async (
  experiments: string[] = ['support'],
  language: 'python' | 'typescript' = 'python'
): Promise<DevWorkspace> => {
  const root = await temporaryDirectory()
  const directory = join(root, 'strands-dev')
  await writeFileAt(temporaryVenvPython(join(root, '.venv')), 'fixture interpreter')
  await Promise.all(
    experiments.map((name) =>
      writeFileAt(experimentFile(directory, name), JSON.stringify({ cases: [{ name: 'greeting', input: 'Hello' }] }))
    )
  )
  return {
    directory,
    root,
    entrypoint: join(root, 'agent.py'),
    config: { version: 1, name: 'desk', language, entrypoint: 'agent.py', origin: { kind: 'discovered' } },
  }
}

const evalsEnvironment = (workspace: DevWorkspace): string => join(workspace.directory!, 'tmp/.state/evals-env')

const optimizationFile = (workspace: DevWorkspace, file: string): string =>
  join(workspace.directory!, 'experiments/support/optimizations', STAMP, file)

const sitePackagesOf = (python: string): string => join(dirname(dirname(python)), 'lib', 'site-packages')

const environmentRunner = () =>
  vi.fn(async ({ command, args }: TemporaryCommandRequest): Promise<string> => {
    if (args[1]?.includes('platform.python_version')) return JSON.stringify({ version: '3.12.4', paths: [] })
    if (args[0] === '-m' && args[1] === 'venv') await writeFileAt(temporaryVenvPython(args[3]!), 'fixture interpreter')
    if (args[1]?.includes('site.getsitepackages()[0]')) {
      const sitePackages = sitePackagesOf(command)
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
      { run: environmentRunner(), spawnOptimizer }
    )

    const experiment = experimentFile(workspace.directory!, 'support')
    const record = optimizationFile(workspace, 'optimizer')
    const [{ command, args, cwd, env, log }] = spawnOptimizer.mock.calls[0]!
    expect(command).toBe(temporaryVenvPython(evalsEnvironment(workspace)))
    expect(args).toEqual([
      '-m',
      'strands_evals.cli',
      'optimize',
      experiment,
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
    expect(log).toBe(optimizationFile(workspace, 'run.log'))
    expect(outcome).toEqual({
      experiment,
      record,
      summary: ['ships candidate 3', 'record: somewhere'],
    })
    expect(progress).toContain('candidate  0 baseline complete n=4 Contains 0.5')
  })

  it('shouldGiveTheOptimizerACopyWithUniqueCaseNamesWhenCasesRepeatOrLackANameAndKeepTheExperimentFile', async () => {
    const workspace = await workspaceFixture()
    const experiment = experimentFile(workspace.directory!, 'support')
    const original = JSON.stringify({
      cases: [
        { name: 'greeting', input: 'Hello' },
        { name: 'greeting', input: 'Hi' },
        { name: null, input: 'Hey' },
      ],
    })
    await writeFile(experiment, original)
    const spawnOptimizer = succeeding()

    await runTemporaryOptimization({ workspace, now: () => NOW }, { run: environmentRunner(), spawnOptimizer })

    const copy = optimizationFile(workspace, '.state/experiment.json')
    expect(spawnOptimizer.mock.calls[0]![0].args[3]).toBe(copy)
    const named = JSON.parse(await readFile(copy, 'utf8')) as { cases: { name: string; input: string }[] }
    expect(named.cases.map(({ name, input }) => [name, input])).toEqual([
      ['greeting', 'Hello'],
      ['greeting-2', 'Hi'],
      ['case_2', 'Hey'],
    ])
    expect(await readFile(experiment, 'utf8')).toBe(original)
  })

  it('shouldUseTheNamedExperimentWhenSeveralExist', async () => {
    const workspace = await workspaceFixture(['billing', 'support'])
    const spawnOptimizer = succeeding()

    await runTemporaryOptimization(
      { workspace, experiment: 'billing', now: () => NOW },
      { run: environmentRunner(), spawnOptimizer }
    )

    expect(spawnOptimizer.mock.calls[0]![0].args[3]).toBe(experimentFile(workspace.directory!, 'billing'))
  })

  it.each([
    { experiments: [], requested: undefined, message: 'Draft cases with /experiment in a strands dev chat' },
    {
      experiments: ['billing', 'support'],
      requested: undefined,
      message: 'for example strands dev optimize billing',
    },
    {
      experiments: ['support'],
      requested: 'refunds',
      message: 'Use one of support, or draft cases with /experiment',
    },
    { experiments: [], requested: 'refunds', message: 'then run strands dev optimize again' },
    {
      experiments: ['support'],
      requested: './missing/refunds.json',
      message: 'Check the path, or name an experiment in',
    },
  ])('shouldExplainTheExperimentChoiceWhen$message', async ({ experiments, requested, message }) => {
    const workspace = await workspaceFixture(experiments)
    const spawnOptimizer = succeeding()

    await expect(
      runTemporaryOptimization(
        { workspace, ...(requested ? { experiment: requested } : {}) },
        { run: environmentRunner(), spawnOptimizer }
      )
    ).rejects.toThrow(message)
    expect(spawnOptimizer).not.toHaveBeenCalled()
  })

  it.each([['--agent', 'other.py'], ['--record=elsewhere'], ['--json'], ['--rich'], ['--typescript-runner', 'node']])(
    'shouldRejectFlagsThatStrandsDevOwnsWhen%sIsPassed',
    async (...forkArguments) => {
      const workspace = await workspaceFixture()
      const run = environmentRunner()

      await expect(runTemporaryOptimization({ workspace, forkArguments }, { run })).rejects.toThrow('strands dev sets')
      expect(run).not.toHaveBeenCalled()
    }
  )

  it('shouldStartTheTypescriptRunnerAndUseTheSystemPythonWhenTheWorkspaceAgentIsTypeScript', async () => {
    vi.stubEnv('PYTHON', '/opt/python3.12')
    const workspace = await workspaceFixture(['support'], 'typescript')
    const run = environmentRunner()
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

  it.each([
    ['--resume when the record already holds a run', true, '--resume'],
    ['--record when the optimizer died before it made a run', false, '--record'],
  ])('shouldContinueARecordedRunWith %s', async (_, hasRun, flag) => {
    const workspace = await workspaceFixture()
    const record = optimizationFile(workspace, 'optimizer')
    await mkdir(hasRun ? join(record, '20261111-150406-abc123') : record, { recursive: true })
    if (hasRun) await writeFile(join(record, '20261111-150406-abc123', 'events.jsonl'), '')
    const spawnOptimizer = succeeding()

    await runTemporaryOptimization(
      { workspace, continuing: record, now: () => NOW },
      { run: environmentRunner(), spawnOptimizer }
    )

    const { args } = spawnOptimizer.mock.calls[0]![0]
    expect(args.slice(args.indexOf(flag), args.indexOf(flag) + 2)).toEqual([flag, record])
    expect(args).not.toContain(flag === '--resume' ? '--record' : '--resume')
  })

  it('shouldStartTheOptimizerDetachedAndReportItsProcessWhenAskedToOutliveStrandsDev', async () => {
    const workspace = await workspaceFixture()
    const onSpawn = vi.fn()
    const spawnOptimizer = vi.fn(async (process: TemporaryEvalsProcess) => {
      process.onSpawn?.(4242)
      return { code: 0, stdout: '', stderrTail: [] }
    })

    await runTemporaryOptimization(
      { workspace, detached: true, onSpawn, now: () => NOW },
      { run: environmentRunner(), spawnOptimizer }
    )

    expect(spawnOptimizer.mock.calls[0]![0]).toMatchObject({ detached: true })
    expect(onSpawn).toHaveBeenCalledWith(4242)
  })

  it('shouldReportTheOptimizerOutputWhenItFails', async () => {
    const workspace = await workspaceFixture()
    const spawnOptimizer = vi.fn(async () => ({
      code: 2,
      stdout: '',
      stderrTail: ['strands-evals: error: agent.py must export a Strands Agent as "agent"'],
    }))

    await expect(runTemporaryOptimization({ workspace }, { run: environmentRunner(), spawnOptimizer })).rejects.toThrow(
      /stopped with exit code 2: agent\.py must export a Strands Agent .*\nThe full optimizer output is in .+run\.log\./u
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

    await runTemporaryOptimization({ workspace, environment }, { run: environmentRunner(), spawnOptimizer })

    expect(spawnOptimizer.mock.calls[0]![0].env.AWS_DEFAULT_REGION).toBe(expected)
    expect(environment).toEqual({ PATH: '/usr/bin', ...given })
  })

  it('shouldPrepareTheProjectAfterTheChecksPassAndBeforeTheOptimizerRuns', async () => {
    const workspace = await workspaceFixture()
    const order: string[] = []
    const run = environmentRunner()
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
      const run = environmentRunner()
      const venv = evalsEnvironment(workspace)
      const python = temporaryVenvPython(venv)
      const progress: string[] = []
      const script = "#!/bin/sh\necho 'candidate  0 baseline complete' >&2\necho 'ships candidate 0: {}'\nexit 0\n"

      const outcome = await runTemporaryOptimization(
        { workspace, onProgress: (line) => progress.push(line) },
        {
          run: async (request) => {
            const output = await run(request)
            if (request.args.includes(venv)) {
              await writeFile(python, script)
              await chmod(python, 0o755)
            }
            return output
          },
        }
      )

      expect(progress).toContain('candidate  0 baseline complete')
      expect(outcome.summary).toEqual(['ships candidate 0: {}'])
      expect(await readFile(join(dirname(outcome.record), 'run.log'), 'utf8')).toBe('candidate  0 baseline complete\n')
    }
  )

  it.skipIf(process.platform === 'win32')('shouldReportTheStderrTailWhenTheRealProcessFails', async () => {
    const workspace = await workspaceFixture()
    const run = environmentRunner()
    const venv = evalsEnvironment(workspace)
    const python = temporaryVenvPython(venv)
    const script = "#!/bin/sh\necho 'strands-evals: error: the record is in use' >&2\nexit 2\n"

    await expect(
      runTemporaryOptimization(
        { workspace },
        {
          run: async (request) => {
            const output = await run(request)
            if (request.args.includes(venv)) {
              await writeFile(python, script)
              await chmod(python, 0o755)
            }
            return output
          },
        }
      )
    ).rejects.toThrow(/stopped with exit code 2: the record is in use\nThe full optimizer output is in .+run\.log\./u)
  })
})

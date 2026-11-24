import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import { temporaryVenvPython } from '../../../src/dev/temporary-evals-fork/environment.js'
import type { TemporaryEvalsProcess } from '../../../src/dev/temporary-evals-fork/evals-process.js'
import { runTemporaryOptimization } from '../../../src/dev/temporary-evals-fork/optimize.js'
import { TEMPORARY_DECISION_DEFAULTS } from '../../../src/dev/temporary-evals-fork/plan.js'
import type { OptimizeDecision } from '../../../src/dev/panels/model.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import {
  environmentRunner,
  experimentFile,
  optimizerProposerError,
  workspaceFixture,
  writeFileAt,
  writeOptimizerRun,
} from '../../fixtures/optimizer-run.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const NOW = new Date('2026-11-11T15:04:05Z')
const STAMP = '20261111-150405'
const EVALS_AGENT_FOLDER = fileURLToPath(new URL('../../../src/dev/evals-agent', import.meta.url))

const evalsEnvironment = (workspace: DevWorkspace): string => join(workspace.directory!, 'tmp/.state/evals-env')

const optimizationFile = (workspace: DevWorkspace, file: string): string =>
  join(workspace.directory!, 'experiments/support/optimizations', STAMP, file)

const succeeding = (stdout = 'ships candidate 3\nrecord: somewhere\n') =>
  vi.fn(async (process: TemporaryEvalsProcess) => {
    process.onLine('candidate  0 baseline complete n=4 Contains 0.5')
    return { code: 0, stdout, stderrTail: [] }
  })

const TASK = '.state/task.py'

const spawnedWith = async (
  request: Partial<Parameters<typeof runTemporaryOptimization>[0]> = {},
  given?: DevWorkspace
): Promise<{ workspace: DevWorkspace; args: string[]; task: string }> => {
  const workspace = given ?? (await workspaceFixture())
  const spawnOptimizer = succeeding()
  await runTemporaryOptimization(
    { workspace, now: () => NOW, ...request },
    { run: environmentRunner(), spawnOptimizer }
  )
  return {
    workspace,
    args: spawnOptimizer.mock.calls[0]![0].args,
    task: await readFile(optimizationFile(workspace, TASK), 'utf8'),
  }
}

const afterTheDefaults = (args: readonly string[]): string[] => args.slice(args.indexOf('--seed') + 2)

describe('TEMPORARY dev optimization', () => {
  it('shouldRunOptimizeRunWithATaskFileForTheWorkspaceAgentWhenOneExperimentExists', async () => {
    const workspace = await workspaceFixture()
    const spawnOptimizer = succeeding()
    const progress: string[] = []

    const outcome = await runTemporaryOptimization(
      {
        workspace,
        forkArguments: ['--max-rollouts', '100'],
        now: () => NOW,
        onProgress: (line) => progress.push(line),
      },
      { run: environmentRunner(), spawnOptimizer }
    )

    const experiment = experimentFile(workspace.directory!, 'support')
    const record = optimizationFile(workspace, 'optimizer')
    const task = optimizationFile(workspace, TASK)
    const [{ command, args, cwd, env, log }] = spawnOptimizer.mock.calls[0]!
    expect(command).toBe(temporaryVenvPython(evalsEnvironment(workspace)))
    expect(args).toEqual([
      '-m',
      'strands_evals.cli',
      'optimize',
      'run',
      experiment,
      '--agent',
      `${task}:agent`,
      '--rollout',
      `${task}:rollout`,
      '--base-dir',
      record,
      '--rich',
      '--split',
      '0.5,0.25,0.25',
      '--max-iterations',
      '4',
      '--proposals-per-iteration',
      '4',
      '--runs-per-candidate',
      '1',
      '--max-workers',
      '4',
      '--max-rollouts',
      '500',
      '--seed',
      '0',
      '--max-rollouts',
      '100',
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

  it('shouldWriteATaskFileThatImportsTheShippedPackageWithAbsolutePathsWhenANewRunStarts', async () => {
    const { workspace, task } = await spawnedWith()

    expect(task).toBe(
      [
        'import sys',
        '',
        `sys.path.insert(0, ${JSON.stringify(EVALS_AGENT_FOLDER)})`,
        '',
        'from strands_dev_evals.optimize import optimize_task',
        '',
        '_task = optimize_task(',
        `    ${JSON.stringify(workspace.entrypoint)},`,
        `    experiment_file=${JSON.stringify(experimentFile(workspace.directory!, 'support'))},`,
        '    settings=("instructions",),',
        '    baseline_only=False,',
        ')',
        'agent = _task.agent',
        'rollout = _task.rollout',
        'search = _task.search',
        '',
      ].join('\n')
    )
  })

  it('shouldGiveTheOptimizerTheSettingsObjectiveAndSpaceOfTheRequestWhenTheSessionStartsARun', async () => {
    const workspace = await workspaceFixture()
    const space = optimizationFile(workspace, '.state/space.json')

    const { args, task } = await spawnedWith(
      {
        settings: { iterations: 2, split: [0.6, 0.2, 0.2], width: 3, repetitions: 2 },
        objective: { expression: 'Minimize(tokens)', constraints: 'Contains >= 0.8' },
        space,
      },
      workspace
    )

    expect(args.slice(args.indexOf('--split'))).toEqual([
      '--split',
      '0.6,0.2,0.2',
      '--max-iterations',
      '2',
      '--proposals-per-iteration',
      '3',
      '--runs-per-candidate',
      '2',
      '--max-workers',
      '4',
      '--max-rollouts',
      '500',
      '--seed',
      '0',
      '--objective',
      'minimize:tokens',
      '--constraint',
      'Contains>=0.8',
    ])
    expect(task).toContain(`    space_file=${JSON.stringify(space)},\n`)
  })

  it.each<[string, Partial<OptimizeDecision>, readonly string[]]>([
    ['NoFlagForTheDefaults', {}, []],
    ['TheFeasibilityThreshold', { feasibility: 0.95 }, ['--feasibility-threshold', '0.95']],
    ['NoDataForACrash', { crashScore: 'none' }, ['--agent-failure-score', 'none']],
    ['TheFinalists', { finalists: 5 }, ['--n-finalists', '5']],
  ])('shouldGiveTheOptimizer%sOfTheDecisionWhenARunStarts', async (_case, change, flags) => {
    const { args } = await spawnedWith({ settings: { decision: { ...TEMPORARY_DECISION_DEFAULTS, ...change } } })

    expect(afterTheDefaults(args)).toEqual(flags)
    expect(args).not.toContain('--final-pick')
  })

  it('shouldDefineTheFinalPickInTheTaskFileAndGiveItInsteadOfTheFinalistsWhenThePickIsALowerBound', async () => {
    const decision: OptimizeDecision = { ...TEMPORARY_DECISION_DEFAULTS, pickRule: 'lower-bound-10', finalists: 2 }

    const { workspace, args, task } = await spawnedWith({ settings: { decision } })

    expect(args.slice(args.indexOf('--final-pick'), args.indexOf('--final-pick') + 2)).toEqual([
      '--final-pick',
      `${optimizationFile(workspace, TASK)}:final_pick`,
    ])
    expect(args).not.toContain('--n-finalists')
    expect(task).toContain(
      [
        'search = _task.search',
        '',
        'from strands_evals.optimization import FinalPick, LowerBound',
        '',
        'final_pick = FinalPick(n_finalists=2, rule=LowerBound(q=0.1))',
        '',
      ].join('\n')
    )
  })

  it('shouldMeasureOnlyTheBaselineWithTheSearchOfTheTaskWhenTheRunHasNoIterations', async () => {
    const { workspace, args, task } = await spawnedWith({ settings: { iterations: 0 } })

    const file = optimizationFile(workspace, TASK)
    expect(args.slice(args.indexOf('--rollout'), args.indexOf('--base-dir'))).toEqual([
      '--rollout',
      `${file}:rollout`,
      '--search',
      `${file}:search`,
    ])
    expect(args).not.toContain('--max-iterations')
    expect(task).toContain('    baseline_only=True,\n')
  })

  it.each([
    { given: ['--width', '2'], passed: ['--proposals-per-iteration', '2'] },
    { given: ['--repetitions=3'], passed: ['--runs-per-candidate', '3'] },
    { given: ['--max-concurrency', '8'], passed: ['--max-workers', '8'] },
    { given: ['--at-most', 'tokens=4000'], passed: ['--constraint', 'tokens<=4000'] },
    { given: ['--at-least=Contains=0.8'], passed: ['--constraint', 'Contains>=0.8'] },
    {
      given: ['--objective', 'Pareto(Maximize(Contains), Minimize(tokens, scale=1000))'],
      passed: ['--objective', 'maximize:Contains', '--objective', 'minimize:tokens:scale=1000', '--pareto'],
    },
    {
      given: ['--objective', 'maximize:Contains', '--pareto'],
      passed: ['--objective', 'maximize:Contains', '--pareto'],
    },
    { given: ['--seed', '7', '--split=0.6,0.2,0.2'], passed: ['--seed', '7', '--split=0.6,0.2,0.2'] },
  ])('shouldPassUpstreamFlagsAfterTheDefaultsWhenStrandsDevOptimizeGets$given', async ({ given, passed }) => {
    const { args } = await spawnedWith({ forkArguments: given })

    expect(afterTheDefaults(args)).toEqual(passed)
  })

  it.each([
    { given: ['--iterations', '2'], iterations: '2' },
    { given: ['--max-iterations=6'], iterations: '6' },
  ])('shouldGiveTheIterationsOnceWhenStrandsDevOptimizeGets$given', async ({ given, iterations }) => {
    const { args } = await spawnedWith({ forkArguments: given })

    expect(args.filter((argument) => argument === '--max-iterations')).toHaveLength(1)
    expect(args[args.indexOf('--max-iterations') + 1]).toBe(iterations)
  })

  it.each([{ given: ['--iterations', '0'] }, { given: ['--max-iterations=0'] }])(
    'shouldMeasureOnlyTheBaselineWhenStrandsDevOptimizeGets$given',
    async ({ given }) => {
      const { args, task } = await spawnedWith({ forkArguments: given })

      expect(args).toContain('--search')
      expect(args.some((argument) => argument.startsWith('--max-iterations'))).toBe(false)
      expect(task).toContain('    baseline_only=True,\n')
    }
  )

  it('shouldGiveTheTaskTheTunedSettingsAndTheCustomEvaluatorsWhenStrandsDevOptimizeGetsThem', async () => {
    const { args, task } = await spawnedWith({
      forkArguments: ['--tune', 'instructions, effort', '--custom-evaluator', 'evals.py:Tone'],
    })

    expect(afterTheDefaults(args)).toEqual(['--custom-evaluator', 'evals.py:Tone'])
    expect(task).toContain('    settings=("instructions", "effort",),\n')
    expect(task).toContain('    custom_evaluators=("evals.py:Tone",),\n')
  })

  it.each([
    { given: ['--reflection-model', 'model-a'], passed: ['--reflection-model', 'model-a'] },
    { given: ['--rewriter-model=model-a'], passed: ['--reflection-model', 'model-a'] },
    { given: ['--tune', 'effort', '--reflection-model', 'model-a'], passed: [] },
    { given: ['--iterations', '0', '--reflection-model', 'model-a'], passed: [] },
  ])('shouldGiveTheReflectionModelOnlyWhenTheRunRewritesTextAndGets$given', async ({ given, passed }) => {
    const { args } = await spawnedWith({ forkArguments: given })

    expect(afterTheDefaults(args)).toEqual(passed)
  })

  it.each([
    { kind: 'text', passed: ['--reflection-model', 'model-a'] },
    { kind: 'choice', passed: [] },
  ])('shouldReadTheSpaceForTextWhenTheReflectionModelIsGivenAndTheSpaceHasA$kind', async ({ kind, passed }) => {
    const space = join(await temporaryDirectory(), 'space.json')
    await writeFile(space, JSON.stringify({ variables: [{ key: 'tuned', kind, option: 'instructions' }] }))

    const { args } = await spawnedWith({ space, forkArguments: ['--reflection-model', 'model-a'] })

    expect(afterTheDefaults(args)).toEqual(passed)
  })

  it.each([
    { given: ['--iterations', 'many'], message: '--iterations takes a whole number' },
    { given: ['--at-most', 'tokens'], message: '--at-most takes METRIC=NUMBER' },
    { given: ['--width'], message: '--width needs a value after it' },
    { given: ['--objective', 'Maximize(Contains'], message: 'The objective must look like' },
  ])('shouldRefuseAFlagBeforeTheEnvironmentIsPreparedWhenStrandsDevOptimizeGets$given', async ({ given, message }) => {
    const workspace = await workspaceFixture()
    const run = environmentRunner()

    await expect(runTemporaryOptimization({ workspace, forkArguments: given }, { run })).rejects.toThrow(message)
    expect(run).not.toHaveBeenCalled()
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

    const { args } = await spawnedWith({}, workspace)

    const copy = optimizationFile(workspace, '.state/experiment.json')
    expect(args[4]).toBe(copy)
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

    expect(spawnOptimizer.mock.calls[0]![0].args[4]).toBe(experimentFile(workspace.directory!, 'billing'))
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

  it.each([
    ['--agent', 'other.py:agent'],
    ['--build-task=tuning.py:build_task'],
    ['--space', 'tuning.py:space'],
    ['--config', 'agent.json'],
    ['--rollout', 'tuning.py:rollout'],
    ['--search=tuning.py:search'],
    ['--base-dir', 'elsewhere'],
    ['--name', 'support'],
    ['--json'],
    ['--rich'],
    ['--record=elsewhere'],
  ])('shouldRejectFlagsThatStrandsDevOwnsWhen%sIsPassed', async (...forkArguments) => {
    const workspace = await workspaceFixture()
    const run = environmentRunner()

    await expect(runTemporaryOptimization({ workspace, forkArguments }, { run })).rejects.toThrow('strands dev sets')
    expect(run).not.toHaveBeenCalled()
  })

  it('shouldWriteTheTemporaryTypescriptRunnerAndUseTheSystemPythonWhenTheWorkspaceAgentIsTypeScript', async () => {
    vi.stubEnv('PYTHON', '/opt/python3.12')
    const workspace = await workspaceFixture(['support'], 'typescript')
    const run = environmentRunner()
    const spawnOptimizer = succeeding()

    await runTemporaryOptimization({ workspace }, { run, spawnOptimizer })

    const { args } = spawnOptimizer.mock.calls[0]![0]
    const task = await readFile(args[args.indexOf('--agent') + 1]!.replace(/:agent$/u, ''), 'utf8')
    const runner = JSON.parse(/^ {4}temporary_typescript_runner=(".*"),$/mu.exec(task)![1]!) as string
    expect(runner).toMatch(/^'.+' '.+typescript-runner-main\.js'$/u)
    expect(runner).toContain(process.execPath)
    expect(args).not.toContain('--typescript-runner')
    const venv = run.mock.calls.map(([request]) => request).find((request) => request.args[1] === 'venv')
    expect(venv?.command).toBe('/opt/python3.12')
    vi.unstubAllEnvs()
  })

  it('shouldResumeWithTheRunFolderAloneAndWriteTheTaskFileAgainWhenTheRecordHoldsARun', async () => {
    const workspace = await workspaceFixture()
    const record = optimizationFile(workspace, 'optimizer')
    const runFolder = join(record, '20261111-150406-abc123')
    const task = optimizationFile(workspace, TASK)
    await writeFileAt(join(runFolder, 'events.jsonl'), '')
    await writeFileAt(task, 'the task of the first run\n')

    const { args } = await spawnedWith({ continuing: record, settings: { iterations: 8 } }, workspace)

    expect(args).toEqual(['-m', 'strands_evals.cli', 'optimize', 'resume', runFolder, '--rich'])
    expect(await readFile(task, 'utf8')).toContain('optimize_task(')
  })

  it('shouldStartTheRunAgainInItsRecordWhenTheOptimizerStoppedBeforeItMadeARunFolder', async () => {
    const workspace = await workspaceFixture()
    const record = optimizationFile(workspace, 'optimizer')
    await mkdir(record, { recursive: true })

    const { args } = await spawnedWith({ continuing: record }, workspace)

    expect(args.slice(3, 4)).toEqual(['run'])
    expect(args.slice(args.indexOf('--base-dir'), args.indexOf('--base-dir') + 2)).toEqual(['--base-dir', record])
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
      /^strands-evals optimize run stopped with exit code 2: agent\.py must export a Strands Agent .*\nThe full optimizer output is in .+run\.log\./u
    )
  })

  it.each([
    {
      error: 'Split: 0.5/0.25/0.25 gives 0 validation cases of 2; at least 1 is needed',
      step: 'Add more cases to the experiment, or choose a split',
    },
    {
      error: 'run 20261111-150406-abc123 stopped at setup, so there is nothing to resume; start a new run',
      step: 'Ask for a new run in the chat.',
    },
    {
      error: "space changed: 'a' -> 'b'; pass the run's space to resume it, or start a new run to change it",
      step: 'Ask for a new run in the chat.',
    },
    {
      error: '/work/run has no cli.json: it was not started by `strands-evals optimize run`',
      step: 'Ask for a new run in the chat.',
    },
    {
      error: 'every train trial of the baseline failed, so nothing was measured',
      step: 'If the agent failed, check that it answers one of the cases in a strands dev chat.',
    },
  ])('shouldAddTheNextStepForStrandsDevWhenTheOptimizerReports$error', async ({ error, step }) => {
    const workspace = await workspaceFixture()
    const spawnOptimizer = vi.fn(async () => ({ code: 2, stdout: '', stderrTail: [`strands-evals: error: ${error}`] }))

    const running = runTemporaryOptimization(
      { workspace, now: () => NOW },
      { run: environmentRunner(), spawnOptimizer }
    )

    await expect(running).rejects.toThrow(`: ${error}\n${step}`)
  })

  it('shouldReturnTheProposerFailureWhenTheOptimizerExitsWithThreeAfterAProposerError', async () => {
    const workspace = await workspaceFixture()
    const spawnOptimizer = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      await writeOptimizerRun(args[args.indexOf('--base-dir') + 1]!, [
        optimizerProposerError('RuntimeError', 'model down'),
      ])
      return {
        code: 3,
        stdout: '',
        stderrTail: [
          "strands-evals: error: the proposer of block 'instructions' raised RuntimeError: model down. The search stopped",
          'strands-evals optimize: continue with `strands-evals optimize resume /w/run`',
        ],
      }
    })

    const outcome = await runTemporaryOptimization(
      { workspace, now: () => NOW },
      { run: environmentRunner(), spawnOptimizer }
    )

    expect(outcome).toMatchObject({
      summary: [],
      proposerFailure: 'The proposer failed with RuntimeError: model down.',
    })
  })

  it('shouldReportTheErrorWhenTheOptimizerExitsWithThreeAndTheRunHasNoResult', async () => {
    const workspace = await workspaceFixture()
    const spawnOptimizer = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      await writeOptimizerRun(args[args.indexOf('--base-dir') + 1]!, [])
      return {
        code: 3,
        stdout: '',
        stderrTail: ['strands-evals: error: every train trial of the baseline failed, so nothing was measured'],
      }
    })

    await expect(
      runTemporaryOptimization({ workspace, now: () => NOW }, { run: environmentRunner(), spawnOptimizer })
    ).rejects.toThrow('stopped with exit code 3: every train trial of the baseline failed, so nothing was measured')
  })

  it.each([
    { given: { AWS_REGION: 'us-east-2', AWS_DEFAULT_REGION: 'eu-west-1' }, expected: 'us-east-2' },
    { given: { AWS_DEFAULT_REGION: 'eu-west-1' }, expected: 'eu-west-1' },
    { given: {}, expected: undefined },
  ])('shouldSetTheDefaultRegionLikeTheDevWorkerWhenTheEnvironmentIs$given', async ({ given, expected }) => {
    const workspace = await workspaceFixture()
    const spawnOptimizer = succeeding()
    for (const name of ['AWS_REGION', 'AWS_DEFAULT_REGION'] as const) vi.stubEnv(name, given[name])

    await runTemporaryOptimization({ workspace }, { run: environmentRunner(), spawnOptimizer })

    expect(spawnOptimizer.mock.calls[0]![0].env.AWS_DEFAULT_REGION).toBe(expected)
    expect(process.env.AWS_DEFAULT_REGION).toBe(given.AWS_DEFAULT_REGION)
    vi.unstubAllEnvs()
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

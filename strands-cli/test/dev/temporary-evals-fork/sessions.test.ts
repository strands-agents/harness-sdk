import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { ExperimentSummary } from '../../../src/dev/panels/model.js'
import {
  readTemporaryRunRecords,
  saveTemporaryRunRecord,
  type TemporaryTestRecord,
} from '../../../src/dev/temporary-evals-fork/background-runs.js'
import { temporaryVenvPython, type TemporaryCommandRequest } from '../../../src/dev/temporary-evals-fork/environment.js'
import type { TemporaryEvalsExit, TemporaryEvalsProcess } from '../../../src/dev/temporary-evals-fork/evals-process.js'
import type { TemporarySessionDependencies } from '../../../src/dev/temporary-evals-fork/host.js'
import { TemporaryExperiments } from '../../../src/dev/temporary-evals-fork/experiments-session.js'
import { readTemporaryTestResults, rememberTemporaryTestResults } from '../../../src/dev/temporary-evals-fork/report.js'
import type { TemporarySessionHost } from '../../../src/dev/temporary-evals-fork/host.js'
import {
  TemporaryTest,
  temporaryDevSessions,
  temporaryOptimizeJobs,
  temporaryTestJobs,
} from '../../../src/dev/temporary-evals-fork/sessions.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import { watchAgentProject } from '../../../src/project/watch.js'
import type { ChatNotice, DevChatCommandContext } from '../../../src/ui/chat/types.js'
import { pythonExecutable } from '../../fixtures/python-runtime.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'
import {
  optimizerCandidate,
  optimizerConfig,
  optimizerIterationEnd,
  optimizerPicked,
  optimizerStop,
  optimizerTested,
  writeOptimizerRun,
} from '../../fixtures/optimizer-run.js'

const BASELINE = 'Answer in one word.'
const WINNER = 'Answer in one word.\nName the capital city.'

const writeFileAt = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const workspaceFixture = async (): Promise<DevWorkspace> => {
  const root = await temporaryDirectory()
  await writeFileAt(temporaryVenvPython(join(root, '.venv')), 'fixture interpreter')
  await writeFileAt(join(root, 'instructions.md'), `${BASELINE}\n`)
  await writeFileAt(
    join(root, 'agent.py'),
    'agent = create_harness(instructions=open("instructions.md").read(), effort="low")\n'
  )
  return {
    directory: join(root, 'strands-dev'),
    root,
    entrypoint: join(root, 'agent.py'),
    config: { version: 1, name: 'desk', language: 'python', entrypoint: 'agent.py', origin: { kind: 'discovered' } },
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

const experimentDocument = (names: readonly string[], evaluators: readonly string[] = ['OutputEvaluator']) => ({
  cases: names.map((name) => ({
    name,
    session_id: `session-${name}`,
    input: `question ${name}`,
    expected_output: `answer ${name}`,
    metadata: null,
  })),
  evaluators: evaluators.map((evaluator_type) => ({ evaluator_type })),
})

const flagValue = (args: readonly string[], flag: string): string => args[args.indexOf(flag) + 1]!

const exit = { code: 0, stdout: '', stderrTail: [] }

const held = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const testingProcess = () =>
  vi.fn(async ({ args }: TemporaryEvalsProcess) => {
    const experiment = JSON.parse(await readFile(args[3]!, 'utf8')) as ReturnType<typeof experimentDocument>
    const store = flagValue(args, '--data-store')
    await mkdir(store, { recursive: true })
    await Promise.all(experiment.cases.map(({ name }) => writeFile(join(store, `${name}.json`), '{}')))
    const passes = experiment.cases.map(({ name }) => name !== 'c1')
    await writeFileAt(
      flagValue(args, '--output'),
      JSON.stringify({
        overall_score: passes.filter(Boolean).length / passes.length,
        scores: passes.map((pass) => (pass ? 1 : 0)),
        test_passes: passes,
        reasons: passes.map((pass) => (pass ? 'matches' : 'named the wrong city')),
        cases: experiment.cases.map((item) => ({
          ...item,
          actual_output: 'Paris',
          evaluator: 'OutputEvaluator',
          evaluator_type: 'OutputEvaluator',
        })),
        detailed_results: passes.map((pass) => [{ score: pass ? 1 : 0, test_pass: pass, reason: '', label: null }]),
      })
    )
    return exit
  })

const studyLines = (best: number, values: { baseline?: object; winner?: object } = {}): string[] => [
  optimizerConfig(),
  ...optimizerCandidate({
    id: 'base',
    number: 0,
    values: { instructions: BASELINE, ...values.baseline },
    train: 0.5,
  }),
  ...optimizerCandidate({
    id: 'win',
    number: 1,
    iteration: 1,
    values: { instructions: WINNER, ...values.winner },
    changed: ['instructions'],
    train: best,
  }),
  optimizerIterationEnd(['win', 'base']),
]

const optimizingProcess = () =>
  vi.fn(async ({ args }: TemporaryEvalsProcess) => {
    await writeOptimizerRun(flagValue(args, '--record'), [...studyLines(0.9), optimizerStop(), optimizerPicked('win')])
    return exit
  })

const chat = () => {
  const notices: { status: ChatNotice['status']; text: string }[] = []
  const context: DevChatCommandContext = {
    signal: new AbortController().signal,
    report: (status, text) => {
      const notice = { status, text }
      notices.push(notice)
      return {
        update: (nextStatus, nextText): void => {
          notice.status = nextStatus
          notice.text = nextText
        },
      }
    },
    fail: vi.fn(),
    submit: vi.fn(),
  }
  return { context, notices }
}

const sessionsFor = async (dependencies: Partial<TemporarySessionDependencies> = {}) => {
  const workspace = await workspaceFixture()
  const { context, notices } = chat()
  const sessions = temporaryDevSessions({
    workspace,
    agent: () => ({ description: 'Answers capital city questions', tools: [] }),
    context,
    dependencies: { run: environmentRunner(workspace), ...dependencies },
  })
  return { workspace, sessions, notices }
}

const savedExperiment = async (
  workspace: DevWorkspace,
  names: readonly string[],
  name = 'capital',
  evaluators?: readonly string[]
): Promise<ExperimentSummary> => {
  const path = join(workspace.directory!, `tmp/experiments/${name}.json`)
  await writeFileAt(path, JSON.stringify(experimentDocument(names, evaluators)))
  return { name, path, caseCount: names.length }
}

const finished = (sessions: ReturnType<typeof temporaryDevSessions>, path: string) => {
  const run = sessions.test.snapshot().runs.find(({ experiment }) => experiment.path === path)?.run
  if (run?.status !== 'done') throw new Error(`expected finished results, got ${run?.status}`)
  return run.results
}

const runStatus = (sessions: ReturnType<typeof temporaryDevSessions>, path: string) =>
  sessions.test.snapshot().runs.find(({ experiment }) => experiment.path === path)?.run.status

const restartedTest = (
  workspace: DevWorkspace,
  dependencies?: Partial<TemporarySessionDependencies>
): TemporaryTest => {
  const host = (): TemporarySessionHost => ({ workspace, agent: () => ({}), ...(dependencies ? { dependencies } : {}) })
  return new TemporaryTest(host, new TemporaryExperiments(host))
}

const remembered = async (workspace: DevWorkspace, name: string): Promise<void> =>
  vi.waitFor(() => expect(existsSync(join(workspace.directory!, 'tmp/reports/latest', `${name}.json`))).toBe(true))

const strictTestingProcess = (failing: ReadonlySet<string>) =>
  vi.fn(async ({ args }: TemporaryEvalsProcess) => {
    const experiment = JSON.parse(await readFile(args[3]!, 'utf8')) as ReturnType<typeof experimentDocument>
    const names = experiment.cases.map(({ name }) => name.toLowerCase())
    if (new Set(names).size !== names.length)
      return { code: 3, stdout: '', stderrTail: ['All case names must be unique when using an evaluation_data_store.'] }
    const passes = experiment.cases.map(({ input }) => !failing.has(input))
    await writeFileAt(
      flagValue(args, '--output'),
      JSON.stringify({
        overall_score: 0,
        scores: passes.map(Number),
        test_passes: passes,
        reasons: passes.map((pass) => (pass ? 'ok' : 'wrong')),
        cases: experiment.cases.map((item) => ({ ...item, actual_output: 'x', evaluator: 'OutputEvaluator' })),
      })
    )
    return exit
  })

describe('TEMPORARY dev sessions', () => {
  it('shouldShareTheSessionsWhenTheSameWorkspaceOpensAgain', async () => {
    const { workspace, sessions } = await sessionsFor()

    const again = temporaryDevSessions({ workspace, agent: () => ({}) })

    expect(again).toBe(sessions)
  })

  it('shouldShowTheFailedCaseAndPostANoticeWhenATestRunFinishes', async () => {
    const { workspace, sessions, notices } = await sessionsFor({ spawnTests: testingProcess() })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2'])

    sessions.test.run([experiment])
    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('done'))

    const results = finished(sessions, experiment.path)
    expect(results.cases.filter(({ passed }) => !passed).map(({ name }) => name)).toEqual(['c1'])
    expect(results.cases.find(({ name }) => name === 'c1')?.verdicts[0]?.reason).toBe('named the wrong city')
    expect(notices.at(-1)).toEqual({
      status: 'success',
      text: 'test · capital · 2 of 3 cases passed · /test shows the results',
    })
  })

  it('shouldStopARunningTestWithoutAnErrorNoticeWhenTheUserStopsIt', async () => {
    const spawnTests = vi.fn(
      ({ signal }: TemporaryEvalsProcess) =>
        new Promise<TemporaryEvalsExit>((resolve) =>
          signal?.addEventListener('abort', () => resolve({ code: 143, stdout: '', stderrTail: [] }), { once: true })
        )
    )
    const { workspace, sessions, notices } = await sessionsFor({ spawnTests })
    const experiment = await savedExperiment(workspace, ['c0', 'c1'])
    sessions.test.run([experiment])
    await vi.waitFor(() => expect(spawnTests).toHaveBeenCalledTimes(1))

    sessions.test.stop(experiment.path)

    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('failed'))
    const run = sessions.test.snapshot().runs.find((entry) => entry.experiment.path === experiment.path)?.run
    expect(run).toEqual({ status: 'failed', message: 'You stopped the run.' })
    expect(notices).toEqual([])
  })

  it('shouldRerunOnlyTheFailedCasesWhenAsked', async () => {
    const testing = testingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnTests: testing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2'])
    sessions.test.run([experiment])
    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('done'))

    sessions.test.rerunFailed(experiment.path)
    await vi.waitFor(() => expect(testing).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('done'))

    const rerun = JSON.parse(await readFile(testing.mock.calls.at(-1)![0].args[3]!, 'utf8')) as ReturnType<
      typeof experimentDocument
    >
    expect(rerun.cases.map(({ name }) => name)).toEqual(['c1'])
  })

  it('shouldPlanTheSplitAndUpdateTheEstimateWhenTheBudgetChanges', async () => {
    const { workspace, sessions } = await sessionsFor()
    const experiment = await savedExperiment(
      workspace,
      Array.from({ length: 20 }, (_, index) => `c${index}`)
    )

    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    const before = sessions.optimize.snapshot()
    sessions.optimize.setIterations(2)

    const after = sessions.optimize.snapshot()
    if (before.step !== 'setup' || after.step !== 'setup') throw new Error('expected the setup')
    expect(before.plan.split).toEqual({ train: 10, validation: 5, test: 5 })
    expect(before.plan.knobs.map(({ key, enabled }) => [key, enabled])).toEqual([
      ['instructions', true],
      ['model', false],
      ['effort', false],
      ['caching', false],
      ['builtinTools', false],
      ['backgroundTasks', false],
      ['contextManager', false],
      ['skills', false],
      ['builtinPlugins', false],
    ])
    expect(after.plan.iterations).toBe(2)
    expect(after.plan.rollouts).toBeLessThan(before.plan.rollouts)
  })

  it('shouldMoveTheCasesAndUpdateTheEstimateAndWarningWhenTheDeveloperPicksAnotherSplit', async () => {
    const { workspace, sessions } = await sessionsFor()
    const experiment = await savedExperiment(
      workspace,
      Array.from({ length: 20 }, (_, index) => `c${index}`)
    )
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    const before = sessions.optimize.snapshot()

    sessions.optimize.setSplit({ train: 16, validation: 2, test: 2 })
    const after = sessions.optimize.snapshot()
    sessions.optimize.setSplit({ train: 17, validation: 2, test: 1 })

    if (before.step !== 'setup' || after.step !== 'setup') throw new Error('expected the setup')
    expect(before.plan.splitChoices).toContainEqual(before.plan.split)
    expect(after.plan.split).toEqual({ train: 16, validation: 2, test: 2 })
    expect(after.plan.rollouts).toBeGreaterThan(before.plan.rollouts)
    expect(before.plan.warning).toBeUndefined()
    expect(after.plan.warning).toBeUndefined()
    expect(sessions.optimize.snapshot()).toEqual(after)
  })

  it('shouldWarnWhenTheChosenSplitLeavesTooFewHeldOutCases', async () => {
    const { workspace, sessions } = await sessionsFor()
    const experiment = await savedExperiment(
      workspace,
      Array.from({ length: 8 }, (_, index) => `c${index}`)
    )
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    const state = sessions.optimize.snapshot()
    if (state.step !== 'setup') throw new Error('expected the setup')

    sessions.optimize.setSplit(state.plan.splitChoices.at(-1)!)

    expect(sessions.optimize.snapshot()).toMatchObject({
      plan: { warning: expect.stringContaining('so the scores can be luck') },
    })
  })

  it('shouldListTheProviderModelsAndTurnTheModelKnobOnWhenTheDeveloperPicksAnotherModel', async () => {
    const discoverModels = vi.fn(async () => ({
      options: [
        { id: 'bedrock/global.anthropic.claude-opus-5', name: 'Claude Opus 5' },
        { id: 'bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0', name: 'Claude Haiku 4.5' },
      ],
    }))
    const { workspace, sessions } = await sessionsFor({ discoverModels })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))

    sessions.optimize.toggleKnob('model')
    sessions.optimize.loadModels()
    await vi.waitFor(() =>
      expect(sessions.optimize.snapshot()).toMatchObject({ plan: { models: { options: expect.any(Array) } } })
    )
    sessions.optimize.pickModel('bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0', true)

    const state = sessions.optimize.snapshot()
    if (state.step !== 'setup') throw new Error('expected the setup')
    expect(discoverModels).toHaveBeenCalledWith('bedrock')
    expect(state.plan.models).toMatchObject({
      current: 'bedrock/global.anthropic.claude-opus-5',
      picked: ['bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0'],
    })
    expect(state.plan.knobs.find(({ key }) => key === 'model')).toMatchObject({
      enabled: true,
      detail: '1 other model to try',
    })
  })

  it('shouldReviewAndApplyTheWinningInstructionsWhenTheRunFinishes', async () => {
    const optimizing = optimizingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))

    sessions.optimize.start()
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
    const state = sessions.optimize.snapshot()
    if (state.step !== 'review') throw new Error('expected the review')
    sessions.optimize.apply()
    await vi.waitFor(() =>
      expect(sessions.optimize.snapshot()).toMatchObject({ review: { applied: ['instructions.md'] } })
    )

    expect(state.review.edits).toEqual([
      expect.objectContaining({ knob: 'instructions', target: 'instructions.md', accepted: true, after: WINNER }),
    ])
    expect(state.review.best).toBeGreaterThan(state.review.baseline)
    expect(await readFile(join(workspace.root, 'instructions.md'), 'utf8')).toBe(`${WINNER}\n`)
    const space = JSON.parse(await readFile(flagValue(optimizing.mock.calls.at(-1)![0].args, '--space'), 'utf8')) as {
      variables: unknown[]
    }
    expect(space.variables).toEqual([
      expect.objectContaining({ key: 'instructions', kind: 'text', option: 'instructions' }),
    ])
  })

  it('shouldKeepARecordWhileTheRunIsActiveAndDropItWhenTheRunEnds', async () => {
    let recorded: unknown
    const optimizing = vi.fn(async (process: TemporaryEvalsProcess) => {
      process.onSpawn?.(4242)
      await vi.waitFor(async () => {
        const [name] = await readdir(join(flagValue(process.args, '--record'), '..', 'running'))
        recorded = JSON.parse(await readFile(join(flagValue(process.args, '--record'), '..', 'running', name!), 'utf8'))
        expect(recorded).toMatchObject({ pid: 4242 })
      })
      await writeOptimizerRun(flagValue(process.args, '--record'), [
        ...studyLines(0.9),
        optimizerStop(),
        optimizerPicked('win'),
      ])
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))

    sessions.optimize.start()

    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
    expect(optimizing.mock.calls[0]![0]).toMatchObject({ detached: true })
    expect(recorded).toMatchObject({
      version: 1,
      experiment: experiment.path,
      iterations: 4,
      space: expect.stringMatching(/\.space\.json$/u),
    })
    expect(await readdir(join(workspace.directory!, 'tmp/optimization/running'))).toEqual([])
  })

  it.each([
    ['lists the review of a run that finished while strands dev was closed', true],
    ['continues a run that stopped when strands dev closed', false],
  ])('shouldResumeOnStartWhenItSees a record and %s', async (_, finished) => {
    const continuing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      await writeOptimizerRun(
        flagValue(args, '--resume'),
        [...studyLines(0.9), optimizerStop(), optimizerPicked('win')],
        {
          baseline_id: 'base',
          validation: { champion_id: 'win' },
        }
      )
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: continuing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    const folder = join(workspace.directory!, 'tmp/optimization')
    const record = join(folder, '20261111-150405-capital')
    const space = join(folder, '20261111-150405-capital.space.json')
    await writeFileAt(
      space,
      JSON.stringify({ variables: [{ key: 'instructions', kind: 'text', option: 'instructions', about: '' }] })
    )
    await writeOptimizerRun(
      record,
      finished ? [...studyLines(0.9), optimizerStop(), optimizerPicked('win')] : studyLines(0.6),
      finished ? { baseline_id: 'base', validation: { champion_id: 'win' } } : undefined
    )
    await writeFileAt(
      join(folder, 'running', '20261111-150405-capital.json'),
      JSON.stringify({
        version: 1,
        experiment: experiment.path,
        record,
        space,
        iterations: 4,
        startedAt: 1,
        pid: 999999,
      })
    )

    await sessions.optimize.resume()

    await vi.waitFor(() => expect(sessions.optimize.snapshot().runs?.[0]?.state.step).toBe('review'))
    expect(sessions.optimize.snapshot()).toMatchObject({
      step: 'pick',
      runs: [
        {
          record,
          state: { review: { edits: [expect.objectContaining({ knob: 'instructions', after: WINNER })] } },
        },
      ],
    })
    expect(continuing).toHaveBeenCalledTimes(finished ? 0 : 1)
    if (!finished)
      expect(continuing.mock.calls[0]![0].args).toEqual(expect.arrayContaining(['--resume', record, '--space', space]))
    expect(await readdir(join(folder, 'running'))).toEqual([])
  })

  it.each<[string, readonly number[] | undefined, readonly string[]]>([
    ['TheSplitOfTheFirstRun', [0.7, 0.15, 0.15], ['--split', '0.7,0.15,0.15']],
    ['NoSplitWhenTheRecordIsFromBeforeTheSplit', undefined, []],
  ])('shouldResumeAStoppedRunWith%s', async (_case, split, flags) => {
    const continuing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      await writeOptimizerRun(flagValue(args, '--resume'), [
        ...studyLines(0.9),
        optimizerStop(),
        optimizerPicked('win'),
      ])
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: continuing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    const folder = join(workspace.directory!, 'tmp/optimization')
    const record = join(folder, '20261111-150405-capital')
    const space = join(folder, '20261111-150405-capital.space.json')
    await writeFileAt(
      space,
      JSON.stringify({ variables: [{ key: 'instructions', kind: 'text', option: 'instructions' }] })
    )
    await writeOptimizerRun(record, studyLines(0.6))
    await writeFileAt(
      join(folder, 'running', '20261111-150405-capital.json'),
      JSON.stringify({
        version: 1,
        experiment: experiment.path,
        record,
        space,
        iterations: 4,
        ...(split ? { split } : {}),
        startedAt: 1,
        pid: 999999,
      })
    )

    await sessions.optimize.resume()

    await vi.waitFor(() => expect(continuing).toHaveBeenCalledTimes(1))
    const args = continuing.mock.calls[0]![0].args
    const at = args.indexOf('--split')
    expect(at >= 0 ? args.slice(at, at + 2) : []).toEqual(flags)
  })

  it('shouldRecordTheSplitWhenARunStartsSoThatItCanResumeWithIt', async () => {
    let recorded: unknown
    const optimizing = vi.fn(async (process: TemporaryEvalsProcess) => {
      process.onSpawn?.(4242)
      await vi.waitFor(async () => {
        const [name] = await readdir(join(flagValue(process.args, '--record'), '..', 'running'))
        recorded = JSON.parse(await readFile(join(flagValue(process.args, '--record'), '..', 'running', name!), 'utf8'))
        expect(recorded).toMatchObject({ pid: 4242 })
      })
      await writeOptimizerRun(flagValue(process.args, '--record'), [
        ...studyLines(0.9),
        optimizerStop(),
        optimizerPicked('win'),
      ])
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(
      workspace,
      Array.from({ length: 20 }, (_, index) => `c${index}`)
    )
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.setSplit({ train: 14, validation: 3, test: 3 })

    sessions.optimize.start()

    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
    expect(recorded).toMatchObject({ split: [0.7, 0.15, 0.15] })
  })

  it('shouldGiveTheOptimizerTheChosenSplitWhenTheRunStarts', async () => {
    const optimizing = optimizingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(
      workspace,
      Array.from({ length: 20 }, (_, index) => `c${index}`)
    )
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.setSplit({ train: 14, validation: 3, test: 3 })

    sessions.optimize.start()

    await vi.waitFor(() => expect(optimizing).toHaveBeenCalledTimes(1))
    expect(flagValue(optimizing.mock.calls[0]![0].args, '--split')).toBe('0.7,0.15,0.15')
  })

  it('shouldOfferTheMeanAndEachEvaluatorAsTheObjectiveWhenTheExperimentHasSeveralEvaluators', async () => {
    const { workspace, sessions } = await sessionsFor()
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'], 'capital', ['Contains', 'Equals'])

    sessions.optimize.plan(experiment)

    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    expect(sessions.optimize.snapshot()).toMatchObject({
      plan: {
        objective: { kind: 'evaluators', evaluators: ['Contains', 'Equals'] },
        objectiveChoices: [
          { kind: 'evaluators', evaluators: ['Contains', 'Equals'] },
          { kind: 'evaluator', evaluator: 'Contains' },
          { kind: 'evaluator', evaluator: 'Equals' },
        ],
      },
    })
  })

  it('shouldChangeTheObjectiveOnlyToOneOfItsChoices', async () => {
    const { workspace, sessions } = await sessionsFor()
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'], 'capital', ['Contains', 'Equals'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))

    sessions.optimize.setObjective({ kind: 'evaluator', evaluator: 'Equals' })
    const chosen = sessions.optimize.snapshot()
    sessions.optimize.setObjective({ kind: 'evaluator', evaluator: 'Helpfulness' })

    expect(chosen).toMatchObject({ plan: { objective: { kind: 'evaluator', evaluator: 'Equals' } } })
    expect(sessions.optimize.snapshot()).toEqual(chosen)
  })

  it.each<[string, { kind: 'evaluator'; evaluator: string } | undefined, readonly string[]]>([
    ['MaximizeTheChosenEvaluator', { kind: 'evaluator', evaluator: 'Equals' }, ['--maximize', 'Equals']],
    ['NoObjectiveFlagForTheMeanOfEveryEvaluator', undefined, []],
  ])('shouldGiveTheOptimizer%sWhenTheRunStarts', async (_case, objective, flags) => {
    const optimizing = optimizingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'], 'capital', ['Contains', 'Equals'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    if (objective) sessions.optimize.setObjective(objective)

    sessions.optimize.start()

    await vi.waitFor(() => expect(optimizing).toHaveBeenCalledTimes(1))
    const args = optimizing.mock.calls[0]![0].args
    const at = args.indexOf('--maximize')
    expect(at >= 0 ? args.slice(at, at + 2) : []).toEqual(flags)
  })

  it('shouldRecordTheObjectiveWhenARunStartsSoThatItCanResumeWithIt', async () => {
    let recorded: unknown
    const optimizing = vi.fn(async (process: TemporaryEvalsProcess) => {
      process.onSpawn?.(4242)
      await vi.waitFor(async () => {
        const [name] = await readdir(join(flagValue(process.args, '--record'), '..', 'running'))
        recorded = JSON.parse(await readFile(join(flagValue(process.args, '--record'), '..', 'running', name!), 'utf8'))
        expect(recorded).toMatchObject({ pid: 4242 })
      })
      await writeOptimizerRun(flagValue(process.args, '--record'), [
        ...studyLines(0.9),
        optimizerStop(),
        optimizerPicked('win'),
      ])
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'], 'capital', ['Contains', 'Equals'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.setObjective({ kind: 'evaluator', evaluator: 'Contains' })

    sessions.optimize.start()

    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
    expect(recorded).toMatchObject({ objective: { kind: 'evaluator', evaluator: 'Contains' } })
  })

  it.each<[string, unknown, readonly string[]]>([
    ['TheObjectiveOfTheFirstRun', { kind: 'evaluator', evaluator: 'Equals' }, ['--maximize', 'Equals']],
    ['NoObjectiveFlagWhenTheRecordIsFromBeforeTheObjective', undefined, []],
  ])('shouldResumeAStoppedRunWith%s', async (_case, objective, flags) => {
    const continuing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      await writeOptimizerRun(flagValue(args, '--resume'), [
        ...studyLines(0.9),
        optimizerStop(),
        optimizerPicked('win'),
      ])
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: continuing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'], 'capital', ['Contains', 'Equals'])
    const folder = join(workspace.directory!, 'tmp/optimization')
    const record = join(folder, '20261111-150405-capital')
    const space = join(folder, '20261111-150405-capital.space.json')
    await writeFileAt(
      space,
      JSON.stringify({ variables: [{ key: 'instructions', kind: 'text', option: 'instructions' }] })
    )
    await writeOptimizerRun(record, studyLines(0.6))
    await writeFileAt(
      join(folder, 'running', '20261111-150405-capital.json'),
      JSON.stringify({
        version: 1,
        experiment: experiment.path,
        record,
        space,
        iterations: 4,
        ...(objective ? { objective } : {}),
        startedAt: 1,
        pid: 999999,
      })
    )

    await sessions.optimize.resume()

    await vi.waitFor(() => expect(continuing).toHaveBeenCalledTimes(1))
    const args = continuing.mock.calls[0]![0].args
    const at = args.indexOf('--maximize')
    expect(at >= 0 ? args.slice(at, at + 2) : []).toEqual(flags)
  })

  it('shouldKeepTheRunGoingAndListItWhenTheDeveloperGoesBackToTheList', async () => {
    const gate = held()
    const optimizing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      await writeOptimizerRun(flagValue(args, '--record'), studyLines(0.7))
      await gate.promise
      await writeOptimizerRun(flagValue(args, '--record'), [
        ...studyLines(0.9),
        optimizerStop(),
        optimizerPicked('win'),
      ])
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    const started = sessions.optimize.start()
    await vi.waitFor(() => expect(optimizing).toHaveBeenCalledTimes(1))

    sessions.optimize.reset()
    const listed = sessions.optimize.snapshot()
    sessions.optimize.openRun(started!)
    const reopened = sessions.optimize.snapshot()
    sessions.optimize.show()
    gate.resolve()

    await vi.waitFor(() => expect(sessions.optimize.snapshot().runs?.[0]?.state.step).toBe('review'))
    expect(listed).toMatchObject({
      step: 'pick',
      runs: [{ id: started, experiment: 'capital', state: { step: 'running' } }],
    })
    expect(reopened.step).toBe('running')
    expect(sessions.optimize.snapshot().step).toBe('pick')
  })

  it('shouldListTheReasonAsASentenceWhenTheOptimizerStopsWithAnError', async () => {
    const failing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      await writeOptimizerRun(flagValue(args, '--record'), [
        ...studyLines(0.6),
        optimizerStop('proposer_error', 'a proposer raised; see the proposer_error event'),
      ])
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: failing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))

    sessions.optimize.start()

    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('failed'))
    expect(sessions.optimize.snapshot()).toMatchObject({
      message: expect.stringMatching(
        /^a proposer raised; see the proposer_error event\. The full optimizer output is in /u
      ),
    })
  })

  it('shouldRunTwoOptimizationsAtOnceWhenTheDeveloperStartsAnotherFromTheList', async () => {
    const gates = [held(), held()]
    const optimizing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      const gate = gates[optimizing.mock.calls.length - 1]!
      await gate.promise
      await writeOptimizerRun(flagValue(args, '--record'), [
        ...studyLines(0.9),
        optimizerStop(),
        optimizerPicked('win'),
      ])
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const capital = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    const cities = await savedExperiment(workspace, ['d0', 'd1', 'd2', 'd3'], 'cities')
    sessions.optimize.plan(capital)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    const first = sessions.optimize.start()
    await vi.waitFor(() => expect(optimizing).toHaveBeenCalledTimes(1))
    sessions.optimize.reset()
    sessions.optimize.plan(cities)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))

    const second = sessions.optimize.start()
    await vi.waitFor(() => expect(optimizing).toHaveBeenCalledTimes(2))
    const both = sessions.optimize.snapshot()
    gates.forEach((gate) => gate.resolve())

    await vi.waitFor(() =>
      expect(sessions.optimize.snapshot().runs?.map(({ state }) => state.step)).toEqual(['review', 'review'])
    )
    expect(second).not.toBe(first)
    expect(both.runs?.map(({ id, experiment, state }) => [id, experiment, state.step])).toEqual([
      [second, 'cities', 'running'],
      [first, 'capital', 'running'],
    ])
    expect(temporaryOptimizeJobs(both).map(({ id }) => id)).toEqual([second, first])
  })

  it('shouldShowTheTestCheckWithItsConfidenceRangeWhenTheRunReportsOne', async () => {
    const tested = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      await writeOptimizerRun(flagValue(args, '--record'), [
        ...studyLines(0.9),
        optimizerStop(),
        optimizerPicked('win'),
        optimizerTested('win', 'base', 0.4, 5, [0.1, 0.7]),
      ])
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: tested })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))

    sessions.optimize.start()

    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
    expect(sessions.optimize.snapshot()).toMatchObject({
      review: { testCheck: { difference: 0.4, cases: 5, confidence: 0.9, range: [0.1, 0.7] } },
    })
  })

  it('shouldListEachPastRunWithItsOutcomeAndOpenItsReportAgain', async () => {
    const optimizing = optimizingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    const optimization = join(workspace.directory!, 'tmp/optimization')
    await writeOptimizerRun(join(optimization, '20261110-090000-capital'), [
      optimizerConfig(),
      ...optimizerCandidate({ id: 'base', number: 0, values: { instructions: BASELINE }, train: 0.5 }),
      optimizerIterationEnd(['base']),
      optimizerStop(),
    ])
    await mkdir(join(optimization, '20261110-080000-capital'), { recursive: true })
    await writeFileAt(join(optimization, '20261109-080000-capital', 'study.jsonl'), '{}\n')
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.start()
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
    const finished = sessions.optimize.snapshot()
    if (finished.step !== 'review') throw new Error('expected the review')

    sessions.optimize.reset()
    await vi.waitFor(() =>
      expect(sessions.optimize.snapshot()).toMatchObject({ pastRuns: { loading: false, runs: expect.any(Array) } })
    )
    const listed = sessions.optimize.snapshot()
    if (listed.step !== 'pick') throw new Error('expected the list')
    sessions.optimize.openPastRun(finished.review.record)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))

    expect(
      listed.pastRuns?.runs.map(({ record, experiment: name, summary, opens }) => [
        basename(record),
        name,
        summary,
        opens,
      ])
    ).toEqual([
      [finished.review.run, 'capital', '0.50 → 0.90 on training cases · 1 edit', true],
      ['20261110-090000-capital', 'capital', 'stopped early · no better candidate · 0.50 on training cases', true],
      ['20261110-080000-capital', 'capital', 'no report, because the run stopped before it started', false],
      ['20261109-080000-capital', 'capital', 'made by the older optimizer, so it cannot be opened', false],
    ])
    expect(listed.pastRuns?.runs[0]?.startedAt).toBeGreaterThan(Date.UTC(2026, 0, 1))
    expect(sessions.optimize.snapshot()).toMatchObject({
      step: 'review',
      review: { run: finished.review.run, edits: [expect.objectContaining({ after: WINNER, accepted: true })] },
    })
  })

  it('shouldKeepTheBestSoFarWhenTheUserStopsTheRun', async () => {
    const stopped = vi.fn(async ({ args, signal }: TemporaryEvalsProcess) => {
      await writeOptimizerRun(flagValue(args, '--record'), studyLines(0.8))
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
      return { code: 143, stdout: '', stderrTail: ['terminated'] }
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: stopped })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.start()
    await vi.waitFor(() => expect(stopped).toHaveBeenCalled())
    await vi.waitFor(
      () => expect(sessions.optimize.snapshot()).toMatchObject({ step: 'running', progress: { best: { number: 1 } } }),
      { timeout: 5000 }
    )

    sessions.optimize.stop()
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))

    expect(sessions.optimize.snapshot()).toMatchObject({
      review: { edits: [expect.objectContaining({ after: WINNER })] },
    })
    expect(existsSync(join(workspace.root, 'instructions.md'))).toBe(true)
  })

  it('shouldPutAnAppliedEditWhereTheAgentWatcherReloadsItAndKeepRunRecordsOutOfIt', async () => {
    const optimizing = optimizingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    const reloaded: string[] = []
    const failures: string[] = []
    const stopWatching = watchAgentProject(
      { root: workspace.root, entrypoint: workspace.entrypoint, language: 'typescript' },
      (paths) => reloaded.push(...paths),
      (error) => failures.push(error.message),
      [workspace.directory!]
    )
    try {
      sessions.optimize.plan(experiment)
      await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
      sessions.optimize.start()
      await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))

      sessions.optimize.apply()

      await vi.waitFor(() =>
        expect(sessions.optimize.snapshot()).toMatchObject({ review: { applied: ['instructions.md'] } })
      )
      await vi.waitFor(() => expect(reloaded).toContain('instructions.md'), { timeout: 5000 })
      expect(failures).toEqual([])
      expect(reloaded.filter((path) => path.includes('events.jsonl') || path.includes('strands-dev'))).toEqual([])
    } finally {
      stopWatching()
    }
  })

  it('shouldReportACancellationWhenTheUserStopsBeforeTheFirstResult', async () => {
    const neverScored = vi.fn(async ({ signal }: TemporaryEvalsProcess) => {
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
      return { code: 143, stdout: '', stderrTail: ['terminated'] }
    })
    const { workspace, sessions, notices } = await sessionsFor({ spawnOptimizer: neverScored })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.start()
    await vi.waitFor(() => expect(neverScored).toHaveBeenCalled())

    sessions.optimize.stop()

    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('cancelled'))
    expect(sessions.optimize.snapshot()).toMatchObject({ step: 'cancelled', experiment: experiment.name })
    expect(JSON.stringify(sessions.optimize.snapshot())).not.toContain('events.jsonl')
    expect(notices.map(({ status, text }) => `${status} ${text}`)).toContain(
      `success optimize · ${experiment.name} cancelled · the agent source is unchanged`
    )
  })
})

describe('TEMPORARY dev sessions on open', () => {
  it.each(['test', 'optimize'] as const)('shouldWaitForAChoiceWhenThe%sPanelOpensWithOneExperiment', async (which) => {
    const tests = testingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnTests: tests })
    await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])

    sessions[which].show()
    await sessions.experiments.reload()

    expect(sessions.experiments.snapshot().saved).toHaveLength(1)
    expect(tests).not.toHaveBeenCalled()
    expect(sessions.optimize.snapshot().step).toBe('pick')
  })

  it('shouldRunSeveralExperimentsAtOnceWhenTheUserPicksThem', async () => {
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const testing = testingProcess()
    const held = vi.fn(async (process: TemporaryEvalsProcess) => {
      await gate
      return testing(process)
    })
    const { workspace, sessions } = await sessionsFor({ spawnTests: held })
    const capital = await savedExperiment(workspace, ['c0', 'c1'])
    const cities = await savedExperiment(workspace, ['c0', 'c1', 'c2'], 'cities')

    sessions.test.run([capital, cities])
    await vi.waitFor(() => expect(held).toHaveBeenCalledTimes(2))
    const jobs = temporaryTestJobs(sessions.test.snapshot())
    release()
    await vi.waitFor(() => expect(runStatus(sessions, cities.path)).toBe('done'))
    await vi.waitFor(() => expect(runStatus(sessions, capital.path)).toBe('done'))

    expect(jobs.map(({ label }) => label).sort()).toEqual(['capital', 'cities'])
    expect(finished(sessions, cities.path).cases).toHaveLength(3)
    expect(finished(sessions, capital.path).cases).toHaveLength(2)
  })

  it('shouldStartOneRunWhenTheSameExperimentIsPickedTwiceQuickly', async () => {
    const testing = testingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnTests: testing })
    const experiment = await savedExperiment(workspace, ['c0'])

    sessions.test.run([experiment])
    sessions.test.run([experiment])
    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('done'))

    expect(testing).toHaveBeenCalledTimes(1)
  })

  it('shouldKeepTheOriginalNamesWhenItRerunsFailedCasesThatHaveNoNames', async () => {
    const failing = new Set(['question q1', 'question q3'])
    const testing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      const experiment = JSON.parse(await readFile(args[3]!, 'utf8')) as {
        cases: { name?: string; input: string }[]
      }
      const rows = experiment.cases.map((item, index) => ({ ...item, name: item.name ?? `case_${index}` }))
      const passes = rows.map(({ input }) => !failing.has(input))
      await writeFileAt(
        flagValue(args, '--output'),
        JSON.stringify({
          overall_score: 0,
          scores: passes.map(Number),
          test_passes: passes,
          reasons: passes.map((pass) => (pass ? 'ok' : 'wrong')),
          cases: rows.map((row) => ({ ...row, actual_output: 'x', evaluator: 'OutputEvaluator' })),
        })
      )
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnTests: testing })
    const path = join(workspace.directory!, 'tmp/experiments/plain.json')
    await writeFileAt(
      path,
      JSON.stringify({
        cases: [0, 1, 2, 3, 4].map((index) => ({ input: `question q${index}`, expected_output: 'y' })),
        evaluators: [{ evaluator_type: 'OutputEvaluator' }],
      })
    )
    sessions.test.run([{ name: 'plain', path, caseCount: 5 }])
    await vi.waitFor(() => expect(runStatus(sessions, path)).toBe('done'))

    sessions.test.rerunFailed(path)
    await vi.waitFor(() => expect(testing).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(runStatus(sessions, path)).toBe('done'))

    const rerun = JSON.parse(await readFile(testing.mock.calls[1]![0].args[3]!, 'utf8')) as {
      cases: { name: string; input: string }[]
    }
    expect(rerun.cases.map(({ name, input }) => [name, input])).toEqual([
      ['case_1', 'question q1'],
      ['case_3', 'question q3'],
    ])
    expect(finished(sessions, path).cases.map(({ name }) => name)).toEqual(['case_1', 'case_3'])
  })

  it('shouldShowTheLastReportWhenTheTestPanelOpensAfterARestart', async () => {
    const { workspace, sessions } = await sessionsFor({ spawnTests: testingProcess() })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2'])
    sessions.test.run([experiment])
    await remembered(workspace, experiment.name)
    const restarted = restartedTest(workspace)

    await restarted.show()

    expect(restarted.snapshot().runs).toEqual([
      { experiment, run: { status: 'done', results: finished(sessions, experiment.path) } },
    ])
  })

  it('shouldShowWhyTheLastReportCannotBeReadWhenTheTestPanelOpensAfterARestart', async () => {
    const { workspace, sessions } = await sessionsFor({ spawnTests: testingProcess() })
    const experiment = await savedExperiment(workspace, ['c0'])
    sessions.test.run([experiment])
    await remembered(workspace, experiment.name)
    await writeFileAt(finished(sessions, experiment.path).report, '{"overall_score": ')
    const restarted = restartedTest(workspace)

    await restarted.show()

    expect(restarted.snapshot().runs.map(({ run }) => run)).toEqual([
      { status: 'failed', message: expect.stringContaining('is not a usable test report') },
    ])
  })

  it('shouldKeepARunningTestWhenTheTestPanelOpensAgainDuringTheRun', async () => {
    const workspace = await workspaceFixture()
    const experiment = await savedExperiment(workspace, ['c0', 'c1'])
    const reports = join(workspace.directory!, 'tmp/reports')
    const earlier = join(reports, 'earlier-capital.json')
    await writeFileAt(
      earlier,
      JSON.stringify({ overall_score: 1, scores: [1], test_passes: [true], cases: [{ name: 'c0' }] })
    )
    await rememberTemporaryTestResults(
      reports,
      experiment.name,
      await readTemporaryTestResults(earlier, { experiment: experiment.name, seconds: 1 })
    )
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const testing = testingProcess()
    const held = vi.fn(async (process: TemporaryEvalsProcess) => {
      await gate
      return testing(process)
    })
    const restarted = restartedTest(workspace, { run: environmentRunner(workspace), spawnTests: held })
    await restarted.show()
    restarted.run([experiment])
    await vi.waitFor(() => expect(held).toHaveBeenCalled())

    await restarted.show()

    expect(restarted.snapshot().runs.map(({ run }) => run.status)).toEqual(['running'])
    release()
    await vi.waitFor(() => expect(restarted.snapshot().runs.map(({ run }) => run.status)).toEqual(['done']))
  })

  it('shouldKeepTheResultsAndWarnWhenTheLastReportCannotBeSaved', async () => {
    const { workspace, sessions, notices } = await sessionsFor({ spawnTests: testingProcess() })
    const experiment = await savedExperiment(workspace, ['c0', 'c1'])
    await writeFileAt(join(workspace.directory!, 'tmp/reports/latest'), 'a file where the folder goes')

    sessions.test.run([experiment])

    await vi.waitFor(() => expect(notices.at(-1)?.status).toBe('error'))
    expect(runStatus(sessions, experiment.path)).toBe('done')
    expect(notices.at(-1)?.text).toMatch(/^test · capital · \/test cannot show this report after a restart: /u)
  })

  it('shouldRunAndRerunCasesThatShareANameWhenTheDataStoreNeedsUniqueNames', async () => {
    const testing = strictTestingProcess(new Set(['question refund']))
    const { workspace, sessions } = await sessionsFor({ spawnTests: testing })
    const path = join(workspace.directory!, 'tmp/experiments/starter.json')
    await writeFileAt(
      path,
      JSON.stringify({
        cases: [
          { name: 'Greeting', input: 'question greeting' },
          { name: 'greeting', input: 'question refund' },
        ],
        evaluators: [{ evaluator_type: 'OutputEvaluator' }],
      })
    )
    sessions.test.run([{ name: 'starter', path, caseCount: 2 }])
    await vi.waitFor(() => expect(runStatus(sessions, path)).toBe('done'))
    const first = finished(sessions, path).cases.map(({ name, passed }) => [name, passed])

    sessions.test.rerunFailed(path)
    await vi.waitFor(() => expect(testing).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(runStatus(sessions, path)).toBe('done'))

    expect(first).toEqual([
      ['Greeting', true],
      ['greeting-2', false],
    ])
    expect(finished(sessions, path).cases.map(({ name, input }) => [name, input])).toEqual([
      ['greeting-2', 'question refund'],
    ])
  })

  it.skipIf(!existsSync(pythonExecutable))(
    'shouldKeepTheReviewAndNameTheChangedFileWhenAnApplyStopsHalfway',
    async () => {
      const optimizing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
        await writeOptimizerRun(flagValue(args, '--record'), [
          ...studyLines(0.9, { baseline: { effort: 'low' }, winner: { effort: 'high' } }),
          optimizerStop(),
          optimizerPicked('win'),
        ])
        return exit
      })
      const { workspace, sessions, notices } = await sessionsFor({ spawnOptimizer: optimizing })
      const projectPython = temporaryVenvPython(join(workspace.root, '.venv'))
      await rm(projectPython)
      await symlink(pythonExecutable, projectPython)
      const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
      sessions.optimize.plan(experiment)
      await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
      sessions.optimize.toggleKnob('effort')
      sessions.optimize.start()
      await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
      await writeFileAt(
        join(workspace.root, 'agent.py'),
        'agent = create_harness(instructions=open("instructions.md").read())\n'
      )

      sessions.optimize.apply()
      await vi.waitFor(() =>
        expect(sessions.optimize.snapshot()).toMatchObject({ review: { applied: ['instructions.md'] } })
      )

      expect(sessions.optimize.snapshot()).toMatchObject({
        step: 'review',
        review: { applyError: expect.stringContaining('agent.py') },
      })
      expect(await readFile(join(workspace.root, 'instructions.md'), 'utf8')).toBe(`${WINNER}\n`)
      expect(notices.at(-1)).toMatchObject({
        status: 'error',
        text: expect.stringContaining('applied instructions.md'),
      })
    }
  )
})

const deadProcessId = async (): Promise<number> => {
  const child = spawn(process.execPath, ['-e', ''])
  await once(child, 'exit')
  return child.pid!
}

const reportsOf = (workspace: DevWorkspace): string => join(workspace.directory!, 'tmp/reports')

const recordFor = async (
  workspace: DevWorkspace,
  experiment: ExperimentSummary,
  pid?: number
): Promise<TemporaryTestRecord> => {
  const reports = reportsOf(workspace)
  const record = {
    version: 1 as const,
    experiment: experiment.path,
    cases: experiment.path,
    rerun: false,
    report: join(reports, '20261116-090000-capital.json'),
    log: join(reports, '20261116-090000-capital.log'),
    store: join(reports, '20261116-090000-capital.cases'),
    startedAt: Date.now() - 60_000,
    ...(pid === undefined ? {} : { pid }),
  }
  await saveTemporaryRunRecord(record)
  return record
}

const finishRun = (record: TemporaryTestRecord): Promise<TemporaryEvalsExit> =>
  testingProcess()({
    command: 'python',
    args: ['-m', 'strands_evals.cli', 'run', record.cases, '--output', record.report, '--data-store', record.store],
    cwd: dirname(record.report),
    env: {},
    onLine: () => undefined,
  })

describe('TEMPORARY /test runs after strands dev closes', () => {
  it('shouldResumeARunThatEndedWhenStrandsDevClosedWithTheCasesItAlreadyFinished', async () => {
    const testing = testingProcess()
    let cutAtResume: boolean | undefined
    let record: TemporaryTestRecord | undefined
    const spawnTests = vi.fn(async (request: TemporaryEvalsProcess) => {
      cutAtResume = existsSync(join(record!.store, 'c1.json'))
      return testing(request)
    })
    const { workspace, sessions, notices } = await sessionsFor({ spawnTests })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2'])
    record = await recordFor(workspace, experiment, await deadProcessId())
    await writeFileAt(join(record.store, 'c0.json'), '{"output": "Paris"}')
    await writeFileAt(join(record.store, 'c1.json'), '{"outp')

    await Promise.all([sessions.test.resume(), sessions.test.resume()])

    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('done'))
    expect(spawnTests).toHaveBeenCalledTimes(1)
    const [{ args, detached }] = spawnTests.mock.calls[0]!
    expect([flagValue(args, '--output'), flagValue(args, '--data-store'), detached]).toEqual([
      record.report,
      record.store,
      true,
    ])
    expect(cutAtResume).toBe(false)
    expect(notices).toContainEqual({
      status: 'success',
      text: 'test · capital · resumed the run that stopped when strands dev closed',
    })
    await vi.waitFor(async () => expect(await readTemporaryRunRecords(reportsOf(workspace))).toEqual([]))
  })

  it('shouldShowTheResultsOfARunThatFinishedWhileStrandsDevWasClosed', async () => {
    const spawnTests = vi.fn()
    const { workspace, sessions, notices } = await sessionsFor({ spawnTests })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2'])
    const record = await recordFor(workspace, experiment, await deadProcessId())
    await finishRun(record)

    await sessions.test.resume()

    expect(runStatus(sessions, experiment.path)).toBe('done')
    expect(spawnTests).not.toHaveBeenCalled()
    expect(notices.at(-1)).toEqual({
      status: 'success',
      text: 'test · capital · 2 of 3 cases passed · /test shows the results',
    })
    expect(await readTemporaryRunRecords(reportsOf(workspace))).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('shouldFollowARunThatIsStillGoingAndShowItsResultsWhenItEnds', async () => {
    const spawnTests = vi.fn()
    const { workspace, sessions } = await sessionsFor({ spawnTests })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2'])
    const report = join(reportsOf(workspace), '20261116-090000-capital.json')
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', report], { stdio: 'ignore' })
    await once(live, 'spawn')
    const record = await recordFor(workspace, experiment, live.pid)

    void sessions.test.resume()
    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('running'))
    await finishRun(record)
    live.kill()

    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('done'), { timeout: 10_000 })
    expect(spawnTests).not.toHaveBeenCalled()
    await vi.waitFor(async () => expect(await readTemporaryRunRecords(reportsOf(workspace))).toEqual([]))
  })

  it('shouldRecordTheProcessOfARunWhileItGoesAndForgetItWhenTheRunEnds', async () => {
    const testing = testingProcess()
    let reports = ''
    const spawnTests = vi.fn(async (request: TemporaryEvalsProcess) => {
      request.onSpawn?.(4242)
      await vi.waitFor(async () => expect((await readTemporaryRunRecords(reports))[0]?.pid).toBe(4242))
      return testing(request)
    })
    const { workspace, sessions } = await sessionsFor({ spawnTests })
    reports = reportsOf(workspace)
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2'])

    sessions.test.run([experiment])

    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('done'))
    await vi.waitFor(async () => expect(await readTemporaryRunRecords(reports)).toEqual([]))
  })
})

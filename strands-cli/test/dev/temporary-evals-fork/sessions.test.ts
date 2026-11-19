import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { CliConfigStore } from '../../../src/config/store.js'
import { createDevWorkspace } from '../../../src/dev/create.js'
import type { ExperimentSummary, OptimizePlan } from '../../../src/dev/panels/model.js'
import * as installer from '../../../src/project/archive.js'
import {
  readTemporaryRunRecords,
  saveTemporaryRunRecord,
  type TemporaryTestRecord,
} from '../../../src/dev/temporary-evals-fork/background-runs.js'
import { temporaryVenvPython, type TemporaryCommandRequest } from '../../../src/dev/temporary-evals-fork/environment.js'
import type { TemporaryEvalsExit, TemporaryEvalsProcess } from '../../../src/dev/temporary-evals-fork/evals-process.js'
import type { TemporarySessionDependencies } from '../../../src/dev/temporary-evals-fork/host.js'
import { temporaryDevChatPart } from '../../../src/dev/temporary-evals-fork/command.js'
import { TemporaryExperiments } from '../../../src/dev/temporary-evals-fork/experiments-session.js'
import { readTemporaryTestResults, rememberTemporaryTestResults } from '../../../src/dev/temporary-evals-fork/report.js'
import type { TemporarySessionHost } from '../../../src/dev/temporary-evals-fork/host.js'
import { readTemporaryOptimizeRecords } from '../../../src/dev/temporary-evals-fork/optimize-runs.js'
import {
  TemporaryOptimize,
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
  OPTIMIZER_RUN_FOLDER,
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

const environmentRunner = () =>
  vi.fn(async ({ command, args }: TemporaryCommandRequest): Promise<string> => {
    if (args[1]?.includes('platform.python_version')) return JSON.stringify({ version: '3.12.4', paths: [] })
    if (args[0] === '-m' && args[1] === 'venv') await writeFileAt(temporaryVenvPython(args[3]!), 'fixture interpreter')
    if (args[1]?.includes('site.getsitepackages()[0]')) {
      const sitePackages = join(dirname(dirname(command)), 'lib/site-packages')
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

const setupPlan = ({ optimize }: { readonly optimize: TemporaryOptimize }): OptimizePlan => {
  const state = optimize.snapshot()
  if (state.step !== 'setup') throw new Error('the plan closed')
  return state.plan
}

const recordOf = (args: readonly string[]): string =>
  args[3] === 'resume' ? dirname(args[4]!) : flagValue(args, '--base-dir')

const spaceOf = async (args: readonly string[]): Promise<string> => {
  const task = await readFile(flagValue(args, '--agent').replace(/:agent$/u, ''), 'utf8')
  return JSON.parse(/^ {4}space_file=(".*"),$/mu.exec(task)![1]!) as string
}

const OBJECTIVE_FLAGS = ['--objective', '--constraint']

const objectiveFlags = (args: readonly string[]): string[] =>
  args.flatMap((arg, index) => (OBJECTIVE_FLAGS.includes(arg) ? [arg, args[index + 1]!] : []))

const exit = { code: 0, stdout: '', stderrTail: [] }

const proposerStopped = {
  code: 3,
  stdout: '',
  stderrTail: ["strands-evals: error: the search stopped: a proposer (block 'instructions') raised KeyError: x"],
}

const held = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const testingProcess = (failingByRun: readonly (readonly string[])[] = [['c1']]) => {
  let runs = 0
  return vi.fn(async ({ args }: TemporaryEvalsProcess) => {
    const failing = new Set(failingByRun[Math.min(runs, failingByRun.length - 1)])
    runs += 1
    const experiment = JSON.parse(await readFile(args[3]!, 'utf8')) as ReturnType<typeof experimentDocument>
    const store = flagValue(args, '--data-store')
    await mkdir(store, { recursive: true })
    await Promise.all(experiment.cases.map(({ name }) => writeFile(join(store, `${name}.json`), '{}')))
    const passes = experiment.cases.map(({ name }) => !failing.has(name))
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
}

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
    await writeOptimizerRun(recordOf(args), [...studyLines(0.9), optimizerStop(), optimizerPicked('win')])
    return exit
  })

const proposerError = (type: string, error: string): string =>
  JSON.stringify({ event: 'proposer_error', iteration: 1, block: 'instructions', redraw: 0, error_type: type, error })

const resumeRecordOf = (record: string): string => join(dirname(record), '.state/record.json')

const runLogOf = (record: string): string => join(dirname(record), 'run.log')

const optimizationName = (record: string): string => `${basename(dirname(record))}-capital`

const optimizationFiles = (workspace: DevWorkspace, stamp = '20261111-150405') => {
  const folder = join(workspace.directory!, 'experiments/capital/optimizations', stamp)
  return {
    record: join(folder, 'optimizer'),
    space: join(folder, '.state/space.json'),
    resume: join(folder, '.state/record.json'),
  }
}

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

const madeInitialCopy = async (): Promise<string> => 'initial-copy'

const sessionsFor = async (dependencies: Partial<TemporarySessionDependencies> = {}) => {
  const workspace = await workspaceFixture()
  const { context, notices } = chat()
  const sessions = temporaryDevSessions({
    workspace,
    agent: () => ({ description: 'Answers capital city questions', tools: [] }),
    context,
    dependencies: { run: environmentRunner(), initialCopy: madeInitialCopy, ...dependencies },
  })
  return { workspace, sessions, notices }
}

const experimentHome = (workspace: DevWorkspace, name = 'capital'): string =>
  join(workspace.directory!, 'experiments', name)

const experimentFile = (workspace: DevWorkspace, name: string): string =>
  join(experimentHome(workspace, name), `${name}.json`)

const savedExperiment = async (
  workspace: DevWorkspace,
  names: readonly string[],
  name = 'capital',
  evaluators?: readonly string[]
): Promise<ExperimentSummary> => {
  const path = experimentFile(workspace, name)
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

const restartedHost =
  (workspace: DevWorkspace, dependencies?: Partial<TemporarySessionDependencies>) => (): TemporarySessionHost => ({
    workspace,
    agent: () => ({}),
    ...(dependencies ? { dependencies: { initialCopy: madeInitialCopy, ...dependencies } } : {}),
  })

const restartedTest = (
  workspace: DevWorkspace,
  dependencies?: Partial<TemporarySessionDependencies>
): TemporaryTest => {
  const host = restartedHost(workspace, dependencies)
  return new TemporaryTest(host, new TemporaryExperiments(host))
}

const restartedOptimize = (
  workspace: DevWorkspace,
  dependencies?: Partial<TemporarySessionDependencies>
): TemporaryOptimize => {
  const host = restartedHost(workspace, dependencies)
  return new TemporaryOptimize(host, new TemporaryExperiments(host))
}

const remembered = async (
  sessions: ReturnType<typeof temporaryDevSessions>,
  workspace: DevWorkspace,
  experiment: ExperimentSummary
): Promise<void> =>
  vi.waitFor(() => {
    expect(runStatus(sessions, experiment.path)).toBe('done')
    expect(existsSync(join(experimentHome(workspace, experiment.name), '.state/latest.json'))).toBe(true)
  })

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
      text: 'evaluate · capital · 2 of 3 cases passed · /evaluate shows the results',
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

  it('shouldMergeTheRerunCasesIntoTheFullResultWhenTheFailedCasesRunAgain', async () => {
    const testing = testingProcess([['c1', 'c4', 'c6'], ['c6']])
    const { workspace, sessions, notices } = await sessionsFor({ spawnTests: testing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'])
    sessions.test.run([experiment])
    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('done'))

    sessions.test.rerunFailed(experiment.path)
    await vi.waitFor(() => expect(testing).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('done'))

    const results = finished(sessions, experiment.path)
    expect(results.cases.map(({ name, passed, verdicts }) => [name, passed, verdicts[0]?.reason])).toEqual([
      ['c0', true, 'matches'],
      ['c1', true, 'matches'],
      ['c2', true, 'matches'],
      ['c3', true, 'matches'],
      ['c4', true, 'matches'],
      ['c5', true, 'matches'],
      ['c6', false, 'named the wrong city'],
      ['c7', true, 'matches'],
    ])
    expect(results.overall).toBe(7 / 8)
    expect(results.report).toBe(join(experimentHome(workspace), 'capital.report.json'))
    expect(notices.at(-1)).toEqual({
      status: 'success',
      text: 'evaluate · capital · 2 of 3 rerun cases passed · 7 of 8 cases passed · /evaluate shows the results',
    })
  })

  it('shouldCountAndRecordOnlyTheRerunCasesWhileTheFailedCasesRunAgain', async () => {
    const gate = held()
    const testing = testingProcess([['c1', 'c2']])
    const spawnTests = vi.fn(async (process: TemporaryEvalsProcess) => {
      if (spawnTests.mock.calls.length > 1) await gate.promise
      return testing(process)
    })
    const { workspace, sessions } = await sessionsFor({ spawnTests })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.test.run([experiment])
    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('done'))

    sessions.test.rerunFailed(experiment.path)
    await vi.waitFor(() => expect(spawnTests).toHaveBeenCalledTimes(2))
    const rerunning = temporaryTestJobs(sessions.test.snapshot())
    const recorded = await readTemporaryRunRecords(workspace.directory!)
    gate.resolve()

    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('done'))
    expect(rerunning.map(({ label, total }) => [label, total])).toEqual([['capital', 2]])
    expect(recorded).toEqual([
      expect.objectContaining({ experiment: experiment.path, rerun: true, only: ['c1', 'c2'] }),
    ])
    expect(finished(sessions, experiment.path).cases).toHaveLength(4)
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
    const space = JSON.parse(await readFile(await spaceOf(optimizing.mock.calls.at(-1)![0].args), 'utf8')) as {
      variables: unknown[]
    }
    expect(space.variables).toEqual([
      expect.objectContaining({ key: 'instructions', kind: 'text', option: 'instructions' }),
    ])
  })

  const reviewWithMovedInstructions = async () => {
    let root = ''
    const finished = optimizingProcess()
    const optimizing = vi.fn(async (process: TemporaryEvalsProcess) => {
      await writeFileAt(join(root, 'instructions.md'), 'Answer in many words.\n')
      return finished(process)
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    root = workspace.root
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.start()
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
    return { workspace, sessions }
  }

  const firstEdit = (sessions: ReturnType<typeof temporaryDevSessions>) => {
    const state = sessions.optimize.snapshot()
    return state.step === 'review' ? state.review.edits[0] : undefined
  }

  it('shouldAcceptAnEditThatCouldNotBeAppliedWhenTheFileIsFixedAndTheUserPressesA', async () => {
    const { workspace, sessions } = await reviewWithMovedInstructions()
    expect(firstEdit(sessions)).toMatchObject({
      accepted: false,
      unavailable: expect.stringContaining('the old text is not a plain string there'),
    })
    await writeFileAt(join(workspace.root, 'instructions.md'), `${BASELINE}\n`)

    sessions.optimize.accept(0, true)

    await vi.waitFor(() =>
      expect(firstEdit(sessions)).toEqual(
        expect.objectContaining({ accepted: true, target: 'instructions.md', after: WINNER })
      )
    )
    expect(firstEdit(sessions)?.unavailable).toBeUndefined()
  })

  it('shouldCheckAnEditAgainWhenTheAgentFilesChangeWhileTheReviewIsOpen', async () => {
    const { workspace, sessions } = await reviewWithMovedInstructions()

    await writeFileAt(join(workspace.root, 'instructions.md'), `${BASELINE}\n`)

    await vi.waitFor(() => expect(firstEdit(sessions)?.unavailable).toBeUndefined(), { timeout: 5000 })
    expect(firstEdit(sessions)).toMatchObject({ accepted: false, target: 'instructions.md' })
  })

  it('shouldKeepTheNewReasonWhenTheUserPressesAAndTheFileStillCannotTakeTheEdit', async () => {
    const { workspace, sessions } = await reviewWithMovedInstructions()
    await writeFileAt(join(workspace.root, 'instructions.md'), 'Answer in other words.\n')

    sessions.optimize.accept(0, true)

    await vi.waitFor(() => expect(firstEdit(sessions)?.unavailable).toContain('not a plain string there'))
    expect(firstEdit(sessions)?.accepted).toBe(false)
  })

  it('shouldWriteTheWinningInstructionsIntoCliTomlWhenTheWorkspaceIsTheBaseCliProfile', async () => {
    const home = await temporaryDirectory()
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    const config = join(home, '.strands', 'cli.toml')
    await writeFileAt(
      config,
      `[profile]\nname = "Base"\ninstructions = "${BASELINE}"\nskills = false\nsession = false\nmemory = false\n`
    )
    vi.spyOn(installer, 'prepareWorkspaceDependencies').mockResolvedValue()
    const workspace = await createDevWorkspace({
      cwd: home,
      destination: join(home, '.strands', 'strands-dev'),
      kind: 'cli',
      snapshot: (await CliConfigStore.load(config, { persist: false })).snapshot(),
    })
    const { context } = chat()
    const sessions = temporaryDevSessions({
      workspace,
      agent: () => ({ description: 'Answers capital city questions', tools: [] }),
      context,
      dependencies: { run: environmentRunner(), initialCopy: madeInitialCopy, spawnOptimizer: optimizingProcess() },
    })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.start()
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
    const state = sessions.optimize.snapshot()
    if (state.step !== 'review') throw new Error('expected the review')

    sessions.optimize.apply()

    await vi.waitFor(async () =>
      expect((await CliConfigStore.load(config, { persist: false })).snapshot().profile.instructions).toBe(WINNER)
    )
    expect(state.review.edits).toEqual([
      expect.objectContaining({ knob: 'instructions', target: config, accepted: true, after: WINNER }),
    ])
    expect(await readFile(workspace.entrypoint, 'utf8')).toContain('Name the capital city.')
    vi.unstubAllEnvs()
  })

  it('shouldKeepARecordWhileTheRunIsActiveAndDropItWhenTheRunEnds', async () => {
    let recorded: unknown
    const optimizing = vi.fn(async (process: TemporaryEvalsProcess) => {
      process.onSpawn?.(4242)
      await vi.waitFor(async () => {
        recorded = JSON.parse(await readFile(resumeRecordOf(recordOf(process.args)), 'utf8'))
        expect(recorded).toMatchObject({ pid: 4242 })
      })
      await writeOptimizerRun(recordOf(process.args), [...studyLines(0.9), optimizerStop(), optimizerPicked('win')])
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))

    sessions.optimize.start()

    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
    const record = recordOf(optimizing.mock.calls[0]![0].args)
    const stamp = basename(dirname(record))
    expect(optimizing.mock.calls[0]![0]).toMatchObject({ detached: true })
    expect(stamp).toMatch(/^\d{8}-\d{6}$/u)
    expect(record).toBe(join(experimentHome(workspace), 'optimizations', stamp, 'optimizer'))
    expect(recorded).toMatchObject({
      version: 1,
      experiment: experiment.path,
      record,
      iterations: 4,
      space: join(dirname(record), '.state/space.json'),
    })
    expect(existsSync(resumeRecordOf(record))).toBe(false)
  })

  it.each([
    ['lists the review of a run that finished while strands dev was closed', true],
    ['continues a run that stopped when strands dev closed', false],
  ])('shouldResumeOnStartWhenItSees a record and %s', async (_, finished) => {
    const continuing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      await writeOptimizerRun(recordOf(args), [...studyLines(0.9), optimizerStop(), optimizerPicked('win')], {
        baseline_id: 'base',
        validation: { champion_id: 'win' },
      })
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: continuing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    const { record, space, resume } = optimizationFiles(workspace)
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
      resume,
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
      expect(continuing.mock.calls[0]![0].args).toEqual([
        '-m',
        'strands_evals.cli',
        'optimize',
        'resume',
        join(record, OPTIMIZER_RUN_FOLDER),
        '--rich',
        '--max-workers',
        '4',
      ])
    expect(existsSync(resume)).toBe(false)
  })

  it.each<[string, readonly number[] | undefined, readonly string[]]>([
    ['TheSplitOfTheFirstRun', [0.7, 0.15, 0.15], ['--split', '0.7,0.15,0.15']],
    ['TheDefaultSplitWhenTheRecordIsFromBeforeTheSplit', undefined, ['--split', '0.5,0.25,0.25']],
  ])('shouldStartARunThatStoppedBeforeItsRunFolderAgainWith%s', async (_case, split, flags) => {
    const continuing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      await writeOptimizerRun(recordOf(args), [...studyLines(0.9), optimizerStop(), optimizerPicked('win')])
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: continuing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    const { record, space, resume } = optimizationFiles(workspace)
    await writeFileAt(
      space,
      JSON.stringify({ variables: [{ key: 'instructions', kind: 'text', option: 'instructions' }] })
    )
    await writeFileAt(
      resume,
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
    expect(args.slice(at, at + 2)).toEqual(flags)
  })

  it('shouldResumeAStoppedRunWithTheParallelTrialsOfTheFirstRunWhenItsFolderHoldsTheRestOfThePlan', async () => {
    const continuing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      await writeOptimizerRun(recordOf(args), [...studyLines(0.9), optimizerStop(), optimizerPicked('win')])
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: continuing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    const { record, space, resume } = optimizationFiles(workspace)
    await writeFileAt(
      space,
      JSON.stringify({ variables: [{ key: 'instructions', kind: 'text', option: 'instructions' }] })
    )
    await writeOptimizerRun(record, studyLines(0.6))
    await writeFileAt(
      resume,
      JSON.stringify({
        version: 1,
        experiment: experiment.path,
        record,
        space,
        iterations: 4,
        width: 6,
        repetitions: 3,
        workers: 2,
        startedAt: 1,
        pid: 999999,
      })
    )

    await sessions.optimize.resume()

    await vi.waitFor(() => expect(continuing).toHaveBeenCalledTimes(1))
    const { args } = continuing.mock.calls[0]![0]
    expect(flagValue(args, '--max-workers')).toBe('2')
    expect(args).not.toContain('--runs-per-candidate')
    expect(args).not.toContain('--proposals-per-iteration')
  })

  it('shouldRecordTheSplitWhenARunStartsSoThatItCanResumeWithIt', async () => {
    let recorded: unknown
    const optimizing = vi.fn(async (process: TemporaryEvalsProcess) => {
      process.onSpawn?.(4242)
      await vi.waitFor(async () => {
        recorded = JSON.parse(await readFile(resumeRecordOf(recordOf(process.args)), 'utf8'))
        expect(recorded).toMatchObject({ pid: 4242 })
      })
      await writeOptimizerRun(recordOf(process.args), [...studyLines(0.9), optimizerStop(), optimizerPicked('win')])
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

  it('shouldGiveTheOptimizerTheBudgetOfThePlanWhenTheRunStarts', async () => {
    const optimizing = optimizingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.setIterations(2)

    sessions.optimize.start()

    await vi.waitFor(() => expect(optimizing).toHaveBeenCalledTimes(1))
    const { args } = optimizing.mock.calls[0]![0]
    expect(
      ['--max-iterations', '--proposals-per-iteration', '--runs-per-candidate'].map((flag) => flagValue(args, flag))
    ).toEqual(['2', '4', '1'])
  })

  it('shouldGiveTheOptimizerTheRunsPerCaseTheCandidatesPerStepAndTheParallelTrialsWhenTheRunStarts', async () => {
    const optimizing = optimizingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.setRepetitions(2)
    sessions.optimize.setWidth(6)
    sessions.optimize.setWorkers(8)

    sessions.optimize.start()

    await vi.waitFor(() => expect(optimizing).toHaveBeenCalledTimes(1))
    const { args } = optimizing.mock.calls[0]![0]
    expect([
      flagValue(args, '--runs-per-candidate'),
      flagValue(args, '--proposals-per-iteration'),
      flagValue(args, '--max-workers'),
    ]).toEqual(['2', '6', '8'])
  })

  it('shouldCountTheRunsPerCaseAndTheCandidatesPerStepInTheEstimate', async () => {
    const { workspace, sessions } = await sessionsFor()
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    const rollouts = (): number => {
      const state = sessions.optimize.snapshot()
      if (state.step !== 'setup') throw new Error('the plan closed')
      return state.plan.rollouts
    }
    const first = rollouts()

    sessions.optimize.setWidth(8)
    const wider = rollouts()
    sessions.optimize.setRepetitions(2)

    expect(wider).toBeGreaterThan(first)
    expect(rollouts()).toBe(2 * wider)
  })

  it('shouldRefuseToStartAndSayWhyWhenThePlanNeedsMoreRolloutsThanOneRunCanUse', async () => {
    const optimizing = optimizingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(
      workspace,
      Array.from({ length: 20 }, (_, index) => `c${index}`)
    )
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.setRepetitions(5)
    sessions.optimize.setWidth(8)
    sessions.optimize.setIterations(8)

    const started = sessions.optimize.start()

    const state = sessions.optimize.snapshot()
    if (state.step !== 'setup') throw new Error('the plan closed')
    expect(state.plan.rollouts).toBeGreaterThan(500)
    expect(state.plan.budgetProblem).toBe(
      `Needs about ${state.plan.rollouts} rollouts, but one run can use 500. Lower the steps, candidates, or runs.`
    )
    expect(started).toBeUndefined()
    expect(optimizing).not.toHaveBeenCalled()
  })

  it('shouldChangeADecisionSettingOnlyToOneOfItsChoicesAndCountTheFinalistsInTheEstimate', async () => {
    const { workspace, sessions } = await sessionsFor()
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    const before = setupPlan(sessions).rollouts

    sessions.optimize.setDecision('finalists', 5)
    sessions.optimize.setDecision('feasibility', 0.5)

    const plan = setupPlan(sessions)
    expect(plan.decision).toEqual({ feasibility: 0.9, crashScore: 'worst', pickRule: 'mean', finalists: 5 })
    expect(plan.validatedFinalists).toBe(5)
    expect(plan.rollouts).toBe(before + 2)
  })

  it('shouldCountTheParetoEndPhaseInTheEstimateWhenTheObjectiveIsAParetoFront', async () => {
    const { workspace, sessions } = await sessionsFor()
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'], 'capital', ['Contains', 'Equals'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    const before = setupPlan(sessions).rollouts

    sessions.optimize.setObjective({
      expression: 'Pareto(Maximize(Contains), Minimize(tokens, scale=1000))',
      constraints: '',
    })

    expect(setupPlan(sessions)).toMatchObject({ validatedFinalists: 5, rollouts: before + 6 })
  })

  it('shouldMoveToTheNearestSplitOfTheNewChoicesWhenTheTestShareChanges', async () => {
    const { workspace, sessions } = await sessionsFor()
    const experiment = await savedExperiment(
      workspace,
      Array.from({ length: 20 }, (_, index) => `c${index}`)
    )
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))

    sessions.optimize.setTestShare(0)
    sessions.optimize.setTestShare(0.25)

    const plan = setupPlan(sessions)
    expect(plan.testShare).toBe(0)
    expect(plan.split).toEqual({ train: 10, validation: 10, test: 0 })
    expect(plan.splitChoices.every(({ test }) => test === 0)).toBe(true)
  })

  it('shouldGiveTheOptimizerTheDecisionAndRecordItWhenTheRunStarts', async () => {
    let recorded: unknown
    const optimizing = vi.fn(async (process: TemporaryEvalsProcess) => {
      process.onSpawn?.(4242)
      await vi.waitFor(async () => {
        recorded = JSON.parse(await readFile(resumeRecordOf(recordOf(process.args)), 'utf8'))
        expect(recorded).toMatchObject({ pid: 4242 })
      })
      await writeOptimizerRun(recordOf(process.args), [...studyLines(0.9), optimizerStop(), optimizerPicked('win')])
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.setDecision('feasibility', 0.95)
    sessions.optimize.setDecision('crashScore', 'none')

    sessions.optimize.start()

    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
    const { args } = optimizing.mock.calls[0]![0]
    expect([flagValue(args, '--feasibility-threshold'), flagValue(args, '--agent-failure-score')]).toEqual([
      '0.95',
      'none',
    ])
    expect(recorded).toMatchObject({
      decision: { feasibility: 0.95, crashScore: 'none', pickRule: 'mean', finalists: 3 },
    })
  })

  it('shouldStartFromTheMeanOfEveryEvaluatorAndOfferPresetsAndEveryMetric', async () => {
    const { workspace, sessions } = await sessionsFor()
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'], 'capital', ['Contains', 'Equals'])

    sessions.optimize.plan(experiment)

    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    const state = sessions.optimize.snapshot()
    if (state.step !== 'setup') throw new Error('expected the setup')
    expect(state.plan.objective).toEqual({ expression: '', constraints: '' })
    expect(state.plan.objectivePresets.map(({ label }) => label).slice(0, 4)).toEqual([
      'the mean of every evaluator',
      'Contains only',
      'Equals only',
      'fewer tokens, each evaluator at least 0.8',
    ])
    expect(state.plan.metrics).toEqual(
      expect.arrayContaining(['Contains', 'Equals', 'tokens', 'seconds', 'model_calls'])
    )
    expect(state.plan).not.toHaveProperty('objectiveProblem')
  })

  it('shouldNameTheProblemAndNotStartWhenTheObjectiveDoesNotFitTheExperiment', async () => {
    const optimizing = optimizingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'], 'capital', ['Contains', 'Equals'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))

    sessions.optimize.setObjective({ expression: 'Maximize(Helpfulness)', constraints: '' })
    const started = sessions.optimize.start()
    sessions.optimize.setObjective({ expression: 'Minimize(tokens)', constraints: '' })

    expect(started).toBeUndefined()
    expect(optimizing).not.toHaveBeenCalled()
    expect(sessions.optimize.snapshot()).toMatchObject({
      plan: { objectiveWarning: expect.stringContaining('Every goal is a usage number') },
    })
    expect(sessions.optimize.snapshot()).not.toHaveProperty('plan.objectiveProblem')
  })

  it.each<[string, { expression: string; constraints: string } | undefined, readonly string[]]>([
    [
      'TheObjectiveAndItsConstraints',
      { expression: 'Minimize(tokens)', constraints: 'Contains >= 0.8, seconds <= 30' },
      ['--objective', 'minimize:tokens', '--constraint', 'Contains>=0.8', '--constraint', 'seconds<=30'],
    ],
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
    expect(objectiveFlags(optimizing.mock.calls[0]![0].args)).toEqual(flags)
  })

  it('shouldRecordTheObjectiveWhenARunStartsSoThatItCanResumeWithIt', async () => {
    let recorded: unknown
    const optimizing = vi.fn(async (process: TemporaryEvalsProcess) => {
      process.onSpawn?.(4242)
      await vi.waitFor(async () => {
        recorded = JSON.parse(await readFile(resumeRecordOf(recordOf(process.args)), 'utf8'))
        expect(recorded).toMatchObject({ pid: 4242 })
      })
      await writeOptimizerRun(recordOf(process.args), [...studyLines(0.9), optimizerStop(), optimizerPicked('win')])
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'], 'capital', ['Contains', 'Equals'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.setObjective({ expression: 'Maximize(Contains)', constraints: 'tokens <= 4000' })

    sessions.optimize.start()

    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
    expect(recorded).toMatchObject({ objective: { expression: 'Maximize(Contains)', constraints: 'tokens <= 4000' } })
  })

  it.each<[string, unknown, readonly string[]]>([
    [
      'TheObjectiveOfTheFirstRun',
      { expression: 'Minimize(seconds)', constraints: 'Equals >= 0.5' },
      ['--objective', 'minimize:seconds', '--constraint', 'Equals>=0.5'],
    ],
    [
      'AnObjectiveSavedBeforeTheApiNotation',
      { kind: 'evaluator', evaluator: 'Equals' },
      ['--objective', 'maximize:Equals'],
    ],
    ['NoObjectiveFlagWhenTheRecordIsFromBeforeTheObjective', undefined, []],
  ])('shouldStartARunThatStoppedBeforeItsRunFolderAgainWith%s', async (_case, objective, flags) => {
    const continuing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      await writeOptimizerRun(recordOf(args), [...studyLines(0.9), optimizerStop(), optimizerPicked('win')])
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: continuing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'], 'capital', ['Contains', 'Equals'])
    const { record, space, resume } = optimizationFiles(workspace)
    await writeFileAt(
      space,
      JSON.stringify({ variables: [{ key: 'instructions', kind: 'text', option: 'instructions' }] })
    )
    await writeFileAt(
      resume,
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
    expect(objectiveFlags(continuing.mock.calls[0]![0].args)).toEqual(flags)
  })

  it('shouldStartARunThatStoppedBeforeItsRunFolderAgainWithTheDecisionOfTheFirstRun', async () => {
    const continuing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      await writeOptimizerRun(recordOf(args), [...studyLines(0.9), optimizerStop(), optimizerPicked('win')])
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: continuing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'], 'capital', ['Contains', 'Equals'])
    const { record, space, resume } = optimizationFiles(workspace)
    await writeFileAt(
      space,
      JSON.stringify({ variables: [{ key: 'instructions', kind: 'text', option: 'instructions' }] })
    )
    await writeFileAt(
      resume,
      JSON.stringify({
        version: 1,
        experiment: experiment.path,
        record,
        space,
        iterations: 4,
        decision: { feasibility: 0.8, crashScore: 'worst', pickRule: 'mean', finalists: 1 },
        startedAt: 1,
        pid: 999999,
      })
    )

    await sessions.optimize.resume()

    await vi.waitFor(() => expect(continuing).toHaveBeenCalledTimes(1))
    const { args } = continuing.mock.calls[0]![0]
    expect([flagValue(args, '--feasibility-threshold'), flagValue(args, '--n-finalists')]).toEqual(['0.8', '1'])
  })

  it('shouldKeepTheRunGoingAndListItWhenTheDeveloperGoesBackToTheList', async () => {
    const gate = held()
    const optimizing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      await writeOptimizerRun(recordOf(args), studyLines(0.7))
      await gate.promise
      await writeOptimizerRun(recordOf(args), [...studyLines(0.9), optimizerStop(), optimizerPicked('win')])
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
      await writeOptimizerRun(
        recordOf(args),
        [...studyLines(0.6), optimizerStop('proposer_error', 'a proposer raised; see the proposer_error event')],
        { baseline_id: 'base' }
      )
      return proposerStopped
    })
    const { workspace, sessions, notices } = await sessionsFor({ spawnOptimizer: failing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))

    sessions.optimize.start()

    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('failed'))
    const record = recordOf(failing.mock.calls[0]![0].args)
    expect(sessions.optimize.snapshot()).toMatchObject({
      message: `a proposer raised; see the proposer_error event. The full optimizer output is in ${runLogOf(record)}.`,
      record,
    })
    expect(notices.at(-1)).toEqual({
      status: 'error',
      text: `optimize · run ${optimizationName(record)} failed · /optimize shows why`,
    })
  })

  it('shouldNameTheProposerErrorAndTheCredentialsItUsesWhenTheProposerCannotSignIn', async () => {
    const failing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      await writeOptimizerRun(
        recordOf(args),
        [
          ...studyLines(0.6),
          proposerError('ProfileNotFound', 'The config profile (dev) could not be found'),
          optimizerStop('proposer_error', 'a proposer raised; see the proposer_error event'),
        ],
        { baseline_id: 'base' }
      )
      return proposerStopped
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: failing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))

    sessions.optimize.start()

    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('failed'))
    const record = recordOf(failing.mock.calls[0]![0].args)
    expect(sessions.optimize.snapshot()).toMatchObject({
      message:
        'The proposer failed with ProfileNotFound: The config profile (dev) could not be found. ' +
        "The proposer is the optimizer's own AWS Bedrock model. It uses the AWS credentials and region of the shell " +
        'that started strands dev, not the chat provider. Set AWS_PROFILE or AWS credentials that can call Bedrock, ' +
        `then start the run again. The full optimizer output is in ${runLogOf(record)}.`,
      record,
    })
  })

  it('shouldComeBackToTheOpenExperimentWhenTheDeveloperLeavesItsSetup', async () => {
    const { workspace, sessions } = await sessionsFor()
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.openExperiment(experiment)
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))

    sessions.optimize.reset()

    expect(sessions.optimize.snapshot()).toMatchObject({ step: 'pick', experiment })
  })

  it.each([
    ['TheDeveloperGoesBackToTheExperiments', (optimize: TemporaryOptimize) => optimize.openExperiment(undefined)],
    ['ThePanelOpensAgain', (optimize: TemporaryOptimize) => optimize.show()],
  ])('shouldListTheExperimentsAgainWhen%s', async (_case, leave) => {
    const { workspace, sessions } = await sessionsFor()
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.openExperiment(experiment)

    leave(sessions.optimize)

    expect(sessions.optimize.snapshot()).toMatchObject({ step: 'pick' })
    expect(sessions.optimize.snapshot()).not.toHaveProperty('experiment')
  })

  it('shouldMakeTheInitialCopyBeforeTheOptimizerStartsWhenARunStarts', async () => {
    const order: string[] = []
    const initialCopy = vi.fn(async (): Promise<string> => {
      order.push('initial copy')
      return 'initial-copy'
    })
    const optimizing = vi.fn(async (): Promise<TemporaryEvalsExit> => {
      order.push('optimizer')
      return { code: 1, stdout: '', stderrTail: ['stopped'] }
    })
    const { workspace, sessions } = await sessionsFor({ initialCopy, spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))

    sessions.optimize.start()

    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('failed'))
    expect(order).toEqual(['initial copy', 'optimizer'])
    expect(initialCopy).toHaveBeenCalledWith(workspace, expect.any(AbortSignal))
  })

  it('shouldStopBeforeTheOptimizerAndSayWhyWhenTheInitialCopyCannotBeMade', async () => {
    const optimizing = vi.fn()
    const { workspace, sessions } = await sessionsFor({
      initialCopy: async () => {
        throw new Error('npm install failed in the initial copy')
      },
      spawnOptimizer: optimizing,
    })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))

    sessions.optimize.start()

    await vi.waitFor(() =>
      expect(sessions.optimize.snapshot()).toMatchObject({
        step: 'failed',
        message: 'npm install failed in the initial copy',
      })
    )
    expect(optimizing).not.toHaveBeenCalled()
  })

  it.each([
    ['AnEvaluatorThatAsksAModel', ['OutputEvaluator'], 1],
    ['OnlyChecksThatAskNoModel', ['Equals', 'Contains'], 0],
  ])('shouldCountTheJudgeCallsOfTheEvaluatorsWhenTheExperimentHas%s', async (_case, evaluators, perRollout) => {
    const { workspace, sessions } = await sessionsFor()
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'], 'capital', evaluators)

    sessions.optimize.plan(experiment)

    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    const state = sessions.optimize.snapshot()
    if (state.step !== 'setup') throw new Error('the plan did not open')
    expect(state.plan.judgeCalls).toBe(state.plan.rollouts * perRollout)
  })

  it.each([
    ['TheAgentHasAShellTool', [{ name: 'shell', description: 'Runs commands' }], ['shell']],
    ['TheAgentOnlyReads', [{ name: 'read', description: 'Reads files' }], []],
  ])('shouldNameTheFileToolsOfTheAgentForTheRunConfirmWhen%s', async (_case, tools, fileTools) => {
    const workspace = await workspaceFixture()
    const sessions = temporaryDevSessions({ workspace, agent: () => ({ model: 'us.model', tools }) })

    expect(sessions.test.agent()).toEqual({ model: 'us.model', folder: workspace.root, fileTools })
    expect(sessions.optimize.agent()).toEqual({ model: 'us.model', folder: workspace.root, fileTools })
  })

  it('shouldDropTheRecordOfARunThatFailsSoThatTheNextStartDoesNotRunItAgain', async () => {
    const failing = vi.fn(async (process: TemporaryEvalsProcess) => {
      process.onSpawn?.(4242)
      await vi.waitFor(async () =>
        expect(JSON.parse(await readFile(resumeRecordOf(recordOf(process.args)), 'utf8'))).toMatchObject({
          pid: 4242,
        })
      )
      return { code: 1, stdout: '', stderrTail: ['strands-evals optimize: error: the agent file did not load'] }
    })
    const { workspace, sessions, notices } = await sessionsFor({ spawnOptimizer: failing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.start()
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('failed'))
    const restarted = restartedOptimize(workspace, { run: environmentRunner(), spawnOptimizer: failing })

    await restarted.resume()

    const record = recordOf(failing.mock.calls[0]![0].args)
    expect(sessions.optimize.snapshot()).toMatchObject({
      message:
        'strands-evals optimize run stopped with exit code 1: the agent file did not load\n' +
        `The full optimizer output is in ${runLogOf(record)}.`,
      record,
    })
    expect(notices.at(-1)).toEqual({ status: 'error', text: 'optimize · capital stopped · /optimize shows why' })
    expect(existsSync(resumeRecordOf(record))).toBe(false)
    expect(await readTemporaryOptimizeRecords(workspace.directory!)).toEqual([])
    expect(restarted.snapshot().runs).toEqual([])
    expect(failing).toHaveBeenCalledTimes(1)
  })

  it('shouldRunTwoOptimizationsAtOnceWhenTheDeveloperStartsAnotherFromTheList', async () => {
    const gates = [held(), held()]
    const optimizing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      const gate = gates[optimizing.mock.calls.length - 1]!
      await gate.promise
      await writeOptimizerRun(recordOf(args), [...studyLines(0.9), optimizerStop(), optimizerPicked('win')])
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
      await writeOptimizerRun(recordOf(args), [
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
    const stoppedEarly = optimizationFiles(workspace, '20261110-090000').record
    const neverStarted = optimizationFiles(workspace, '20261110-080000').record
    const olderOptimizer = optimizationFiles(workspace, '20261109-080000').record
    await writeOptimizerRun(stoppedEarly, [
      optimizerConfig(),
      ...optimizerCandidate({ id: 'base', number: 0, values: { instructions: BASELINE }, train: 0.5 }),
      optimizerIterationEnd(['base']),
      optimizerStop(),
    ])
    await mkdir(neverStarted, { recursive: true })
    await writeFileAt(join(olderOptimizer, 'study.jsonl'), '{}\n')
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

    const latest = optimizationFiles(workspace, basename(dirname(finished.review.record))).record
    expect(finished.review.run).toBe(optimizationName(latest))
    expect(
      listed.pastRuns?.runs.map(({ record, experiment: name, summary, opens }) => [record, name, summary, opens])
    ).toEqual([
      [latest, 'capital', '0.50 → 0.90 on training cases · 1 edit', true],
      [stoppedEarly, 'capital', 'stopped early · no better candidate · 0.50 on training cases', true],
      [neverStarted, 'capital', 'no report, because the run stopped before it started', false],
      [olderOptimizer, 'capital', 'made by the older optimizer, so it cannot be opened', false],
    ])
    expect(listed.pastRuns?.runs.map(({ startedAt }) => startedAt).slice(1)).toEqual([
      Date.UTC(2026, 10, 10, 9),
      Date.UTC(2026, 10, 10, 8),
      Date.UTC(2026, 10, 9, 8),
    ])
    expect(listed.pastRuns?.runs[0]?.startedAt).toBeGreaterThan(Date.UTC(2026, 0, 1))
    expect(sessions.optimize.snapshot()).toMatchObject({
      step: 'review',
      review: { run: finished.review.run, edits: [expect.objectContaining({ after: WINNER, accepted: true })] },
    })
  })

  it('shouldTellTheReloadedAgentWhatApplyChangedInIt', async () => {
    const optimizing = optimizingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.start()
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
    const before = sessions.optimize.appliedChanges()

    sessions.optimize.apply()
    await vi.waitFor(() =>
      expect(sessions.optimize.snapshot()).toMatchObject({ review: { applied: ['instructions.md'] } })
    )
    const reloaded = temporaryDevChatPart(
      workspace,
      { root: workspace.root, entrypoint: workspace.entrypoint, language: 'python' },
      () => ({})
    )

    expect(before).toEqual([])
    expect(sessions.optimize.appliedChanges()).toEqual([
      expect.objectContaining({
        experiment: 'capital',
        edits: [expect.objectContaining({ knob: 'instructions', target: 'instructions.md', after: WINNER })],
      }),
    ])
    expect(reloaded.instructions).toContain('Changes that strands dev made to this agent in this session.')
    expect(reloaded.instructions).toContain('/optimize applied 1 edit from run')
    expect(reloaded.instructions).toContain(`now ${JSON.stringify(WINNER)}`)
  })

  it('shouldKeepTheBestSoFarWhenTheUserStopsTheRun', async () => {
    const stopped = vi.fn(async ({ args, signal }: TemporaryEvalsProcess) => {
      await writeOptimizerRun(recordOf(args), studyLines(0.8))
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
    const path = experimentFile(workspace, 'plain')
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
    expect(finished(sessions, path).cases.map(({ name, input }) => [name, input])).toEqual([
      ['case_0', 'question q0'],
      ['case_1', 'question q1'],
      ['case_2', 'question q2'],
      ['case_3', 'question q3'],
      ['case_4', 'question q4'],
    ])
  })

  it('shouldShowTheLastReportWhenTheTestPanelOpensAfterARestart', async () => {
    const { workspace, sessions } = await sessionsFor({ spawnTests: testingProcess() })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2'])
    sessions.test.run([experiment])
    await remembered(sessions, workspace, experiment)
    const restarted = restartedTest(workspace)

    await restarted.show()

    expect(restarted.snapshot().runs).toEqual([
      { experiment, run: { status: 'done', results: finished(sessions, experiment.path) } },
    ])
    expect(finished(sessions, experiment.path).report).toBe(join(experimentHome(workspace), 'capital.report.json'))
  })

  it('shouldShowWhyTheLastReportCannotBeReadWhenTheTestPanelOpensAfterARestart', async () => {
    const { workspace, sessions } = await sessionsFor({ spawnTests: testingProcess() })
    const experiment = await savedExperiment(workspace, ['c0'])
    sessions.test.run([experiment])
    await remembered(sessions, workspace, experiment)
    await writeFileAt(join(experimentHome(workspace), 'capital.report.json'), '{"overall_score": ')
    const restarted = restartedTest(workspace)

    await restarted.show()

    expect(restarted.snapshot().runs.map(({ run }) => run)).toEqual([
      { status: 'failed', message: expect.stringContaining('is not a usable evaluation report') },
    ])
  })

  it('shouldKeepARunningTestWhenTheTestPanelOpensAgainDuringTheRun', async () => {
    const workspace = await workspaceFixture()
    const experiment = await savedExperiment(workspace, ['c0', 'c1'])
    const earlier = join(experimentHome(workspace), 'runs/20261116-080000/report.json')
    await writeFileAt(
      earlier,
      JSON.stringify({ overall_score: 1, scores: [1], test_passes: [true], cases: [{ name: 'c0' }] })
    )
    await rememberTemporaryTestResults(
      experimentHome(workspace),
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
    const restarted = restartedTest(workspace, { run: environmentRunner(), spawnTests: held })
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
    await writeFileAt(join(experimentHome(workspace), '.state'), 'a file where the folder goes')

    sessions.test.run([experiment])

    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('done'))
    expect(finished(sessions, experiment.path).cases).toHaveLength(2)
    expect(notices).toEqual([
      {
        status: 'error',
        text: expect.stringMatching(/^evaluate · capital · \/evaluate cannot show this report after a restart: /u),
      },
      { status: 'success', text: 'evaluate · capital · 1 of 2 cases passed · /evaluate shows the results' },
    ])
  })

  it('shouldRunAndRerunCasesThatShareANameWhenTheDataStoreNeedsUniqueNames', async () => {
    const testing = strictTestingProcess(new Set(['question refund']))
    const { workspace, sessions } = await sessionsFor({ spawnTests: testing })
    const path = experimentFile(workspace, 'starter')
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

    const rerun = JSON.parse(await readFile(testing.mock.calls[1]![0].args[3]!, 'utf8')) as {
      cases: { name: string; input: string }[]
    }
    expect(first).toEqual([
      ['Greeting', true],
      ['greeting-2', false],
    ])
    expect(rerun.cases.map(({ name, input }) => [name, input])).toEqual([['greeting-2', 'question refund']])
    expect(finished(sessions, path).cases.map(({ name, input, passed }) => [name, input, passed])).toEqual([
      ['Greeting', 'question greeting', true],
      ['greeting-2', 'question refund', false],
    ])
  })

  it.skipIf(!existsSync(pythonExecutable))(
    'shouldKeepTheReviewAndNameTheChangedFileWhenAnApplyStopsHalfway',
    async () => {
      const optimizing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
        await writeOptimizerRun(recordOf(args), [
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

const testRunOf = (workspace: DevWorkspace): string => join(experimentHome(workspace), 'runs/20261116-090000')

const recordFor = async (
  workspace: DevWorkspace,
  experiment: ExperimentSummary,
  pid?: number
): Promise<TemporaryTestRecord> => {
  const run = testRunOf(workspace)
  const record = {
    version: 1 as const,
    experiment: experiment.path,
    cases: experiment.path,
    rerun: false,
    report: join(run, 'report.json'),
    log: join(run, 'run.log'),
    store: join(run, '.state/cases'),
    startedAt: Date.now() - 60_000,
    ...(pid === undefined ? {} : { pid }),
  }
  await saveTemporaryRunRecord(record)
  return record
}

const finishRun = (record: TemporaryTestRecord, failing: readonly string[] = ['c1']): Promise<TemporaryEvalsExit> =>
  testingProcess([failing])({
    command: 'python',
    args: ['-m', 'strands_evals.cli', 'run', record.cases, '--output', record.report, '--data-store', record.store],
    cwd: dirname(record.report),
    env: {},
    onLine: () => undefined,
  })

describe('TEMPORARY /evaluate runs after strands dev closes', () => {
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
      text: 'evaluate · capital · resumed the run that stopped when strands dev closed',
    })
    await vi.waitFor(async () => expect(await readTemporaryRunRecords(workspace.directory!)).toEqual([]))
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
      text: 'evaluate · capital · 2 of 3 cases passed · /evaluate shows the results',
    })
    expect(await readTemporaryRunRecords(workspace.directory!)).toEqual([])
  })

  it('shouldMergeARerunThatFinishedWhileStrandsDevWasClosedIntoTheFullResult', async () => {
    const { workspace, sessions, notices } = await sessionsFor({ spawnTests: testingProcess() })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2'])
    sessions.test.run([experiment])
    await remembered(sessions, workspace, experiment)
    const cases = join(testRunOf(workspace), '.state/experiment.json')
    await writeFileAt(cases, JSON.stringify(experimentDocument(['c1'])))
    const record = {
      ...(await recordFor(workspace, experiment, await deadProcessId())),
      cases,
      rerun: true,
      only: ['c1'],
    }
    await saveTemporaryRunRecord(record)
    await finishRun(record, [])

    await sessions.test.resume()

    expect(finished(sessions, experiment.path).cases.map(({ name, passed }) => [name, passed])).toEqual([
      ['c0', true],
      ['c1', true],
      ['c2', true],
    ])
    expect(notices.at(-1)).toEqual({
      status: 'success',
      text: 'evaluate · capital · 1 of 1 rerun case passed · 3 of 3 cases passed · /evaluate shows the results',
    })
    expect(await readTemporaryRunRecords(workspace.directory!)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('shouldFollowARunThatIsStillGoingAndShowItsResultsWhenItEnds', async () => {
    const spawnTests = vi.fn()
    const { workspace, sessions } = await sessionsFor({ spawnTests })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2'])
    const report = join(testRunOf(workspace), 'report.json')
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', report], { stdio: 'ignore' })
    await once(live, 'spawn')
    const record = await recordFor(workspace, experiment, live.pid)

    void sessions.test.resume()
    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('running'))
    await finishRun(record)
    live.kill()

    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('done'), { timeout: 10_000 })
    expect(spawnTests).not.toHaveBeenCalled()
    await vi.waitFor(async () => expect(await readTemporaryRunRecords(workspace.directory!)).toEqual([]))
  })

  it('shouldRecordTheProcessOfARunWhileItGoesAndForgetItWhenTheRunEnds', async () => {
    const testing = testingProcess()
    let directory = ''
    const spawnTests = vi.fn(async (request: TemporaryEvalsProcess) => {
      request.onSpawn?.(4242)
      await vi.waitFor(async () => expect((await readTemporaryRunRecords(directory))[0]?.pid).toBe(4242))
      return testing(request)
    })
    const { workspace, sessions } = await sessionsFor({ spawnTests })
    directory = workspace.directory!
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2'])

    sessions.test.run([experiment])

    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('done'))
    await vi.waitFor(async () => expect(await readTemporaryRunRecords(directory)).toEqual([]))
  })
})

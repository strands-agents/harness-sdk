import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { DEFAULT_HARNESS_AGENT_CONFIG } from '@strands-agents/harness'
import { describe, expect, it, vi } from 'vitest'

import { CliConfigStore } from '../../../src/config/store.js'
import { createDevWorkspace } from '../../../src/dev/create.js'
import type { ExperimentSummary, OptimizePlan } from '../../../src/dev/panels/model.js'
import * as installer from '../../../src/project/archive.js'
import {
  readTemporaryOptimizeRecords,
  readTemporaryRunRecords,
  saveTemporaryRunRecord,
  type TemporaryTestRecord,
} from '../../../src/dev/temporary-evals-fork/background-runs.js'
import { temporaryVenvPython, type TemporaryCommandRequest } from '../../../src/dev/temporary-evals-fork/environment.js'
import type { TemporaryEvalsExit, TemporaryEvalsProcess } from '../../../src/dev/temporary-evals-fork/evals-process.js'
import type { TemporarySessionDependencies } from '../../../src/dev/temporary-evals-fork/host.js'
import { temporaryDevChatPart, temporaryDevCommands } from '../../../src/dev/temporary-evals-fork/command.js'
import { TemporaryExperiments } from '../../../src/dev/temporary-evals-fork/experiments-session.js'
import { readTemporaryTestResults, rememberTemporaryTestResults } from '../../../src/dev/temporary-evals-fork/report.js'
import type { TemporarySessionHost } from '../../../src/dev/temporary-evals-fork/host.js'
import type { AutoOptimizeRun, AutoOptimizeWorker } from '../../../src/dev/temporary-evals-fork/auto-optimize.js'
import {
  answerOptimizeReview,
  applyOptimizeEdits,
  optimizeReviewContext,
} from '../../../src/dev/temporary-evals-fork/review-run.js'
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
  optimizerTrial,
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
    openPanel: vi.fn(() => true),
  }
  return { context, notices }
}

const madeInitialCopy = async (): Promise<string> => 'initial-copy'

const sessionsFor = async (
  dependencies: Partial<TemporarySessionDependencies> = {},
  settings: Pick<TemporarySessionHost, 'settings'> = {}
) => {
  const workspace = await workspaceFixture()
  const { context, notices } = chat()
  const sessions = temporaryDevSessions({
    workspace,
    agent: () => ({ description: 'Answers capital city questions', tools: [] }),
    context,
    dependencies: {
      run: environmentRunner(),
      initialCopy: madeInitialCopy,
      harnessDefaults: async () => ({ options: { ...DEFAULT_HARNESS_AGENT_CONFIG }, webSearch: false }),
      ...dependencies,
    },
    ...settings,
  })
  return { workspace, sessions, notices }
}

const RECORD_WAIT_MS = 10_000
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

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

// The chat reruns the failed cases by passing their names to strands-evals run --case.
const rerunFailed = (sessions: ReturnType<typeof temporaryDevSessions>, path: string): void => {
  const entry = sessions.test.snapshot().runs.find(({ experiment }) => experiment.path === path)!
  if (entry.run.status !== 'done') throw new Error('expected a finished run')
  sessions.test.runOnly(
    entry.experiment,
    entry.run.results.cases.filter(({ passed }) => !passed).map(({ name }) => name)
  )
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

  it('shouldOpenAFileThroughTheLatestChatScreenAndSaySoWhenItHasNoEditor', async () => {
    const { workspace, sessions } = await sessionsFor()
    const openFile = vi.fn(async (_path: string): Promise<void> => {})

    await expect(sessions.openFile('/w/a.json')).rejects.toThrow('This terminal cannot open an editor.')
    temporaryDevSessions({ workspace, agent: () => ({}), context: { ...chat().context, openFile } })
    await sessions.openFile('/w/a.json')

    expect(openFile).toHaveBeenCalledWith(resolve(workspace.root, '/w/a.json'))
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
      text: `evaluate · capital · 2 of 3 cases passed · report in ${join(experimentHome(workspace), 'capital.report.json')}`,
    })
  })

  it('shouldPointAtTheRunLogOrGiveTheErrorWhenATestRunStopsWithoutAReport', async () => {
    const crashing = vi.fn(async () => ({ code: 1, stdout: '', stderrTail: ['boom'] }))
    const { workspace, sessions, notices } = await sessionsFor({ spawnTests: crashing })
    const experiment = await savedExperiment(workspace, ['c0'])
    sessions.test.run([experiment, { name: 'gone', path: join(workspace.root, 'gone.json'), caseCount: 1 }])

    await vi.waitFor(() => expect(notices).toHaveLength(2))

    expect(notices.map(({ text }) => text).sort()).toEqual([
      expect.stringMatching(
        new RegExp(
          `^evaluate · capital stopped · run log in ${escaped(join(experimentHome(workspace), 'runs'))}${escaped(sep)}.+${escaped(sep)}run\\.log$`,
          'u'
        )
      ),
      expect.stringMatching(/^evaluate · gone stopped · .*ENOENT/u),
    ])
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

    rerunFailed(sessions, experiment.path)
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

    rerunFailed(sessions, experiment.path)
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
      text: `evaluate · capital · 2 of 3 rerun cases passed · 7 of 8 cases passed · report in ${join(experimentHome(workspace), 'capital.report.json')}`,
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

    rerunFailed(sessions, experiment.path)
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
      ['systemPrompt', false],
      ['model', false],
      ['effort', false],
      ['caching', false],
      ['builtinTools', false],
      ['tools', false],
      ['mcpServers', false],
      ['backgroundTasks', false],
      ['contextManager', false],
      ['skills', false],
      ['builtinPlugins', false],
      ['plugins', false],
      ['interventions', false],
    ])
    expect(after.plan.iterations).toBe(2)
    expect(after.plan.rollouts).toBeLessThan(before.plan.rollouts)
  })

  it('shouldReviewAndApplyTheWinningInstructionsAndSayWhichOptionIsNewInTheCallWhenTheRunFinishes', async () => {
    const optimizing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      await writeOptimizerRun(recordOf(args), [
        ...studyLines(0.9, { baseline: { background_tasks: true }, winner: { background_tasks: false } }),
        optimizerStop(),
        optimizerPicked('win'),
      ])
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.toggleKnob('backgroundTasks')

    sessions.optimize.start()
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
    const state = sessions.optimize.snapshot()
    if (state.step !== 'review') throw new Error('expected the review')
    sessions.optimize.accept(1, false)
    sessions.optimize.apply()
    await vi.waitFor(() =>
      expect(sessions.optimize.snapshot()).toMatchObject({ review: { applied: ['instructions.md'] } })
    )

    expect(state.review.edits).toEqual([
      expect.objectContaining({ knob: 'instructions', target: 'instructions.md', accepted: true, after: WINNER }),
      expect.objectContaining({
        knob: 'backgroundTasks',
        before: 'on (the harness default; not in the call)',
        after: 'off',
        added: 'background_tasks is new in the call: applying writes background_tasks = false',
      }),
    ])
    expect(state.review.best).toBeGreaterThan(state.review.baseline)
    expect(await readFile(join(workspace.root, 'instructions.md'), 'utf8')).toBe(`${WINNER}\n`)
    const space = JSON.parse(await readFile(await spaceOf(optimizing.mock.calls.at(-1)![0].args), 'utf8')) as {
      variables: unknown[]
    }
    expect(space.variables).toEqual([
      expect.objectContaining({ key: 'instructions', kind: 'text', option: 'instructions' }),
      { key: 'background_tasks', kind: 'choice', option: 'background_tasks', values: [true, false], default: true },
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

  it('shouldPutNothingOnScreenWhenAFinishedRunHasNoEditThatCanBeApplied', async () => {
    const { sessions } = await reviewWithMovedInstructions()

    expect(firstEdit(sessions)?.unavailable).toBeDefined()
    expect(sessions.ask.pending()).toBeUndefined()
  })

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

  it('shouldKeepARecordWhileTheRunIsActiveAndUntilItsEditIsAnswered', async () => {
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
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(resumeRecordOf(record), 'utf8'))).toMatchObject({ record, awaitsReview: true })
    )
    expect(JSON.parse(await readFile(resumeRecordOf(record), 'utf8'))).not.toHaveProperty('pid')

    await vi.waitFor(() => expect(sessions.ask.pending()).toBeDefined())
    sessions.ask.respond(sessions.ask.pending()!.id, { verdict: 'reject' })

    await vi.waitFor(() => expect(existsSync(resumeRecordOf(record))).toBe(false))
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
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(resume, 'utf8'))).toMatchObject({ record, awaitsReview: true })
    )
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

  it('shouldGiveTheOptimizerTheSplitAndRecordItWhenARunStartsSoThatItCanResumeWithIt', async () => {
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

    sessions.optimize.start()

    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
    expect(recorded).toMatchObject({ split: [0.5, 0.25, 0.25] })
    expect(flagValue(optimizing.mock.calls[0]![0].args, '--split')).toBe('0.5,0.25,0.25')
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
    sessions.optimize.setRepetitions(3)
    sessions.optimize.setWidth(7)
    sessions.optimize.setWorkers(6)
    sessions.optimize.setWidth(0)

    sessions.optimize.start()

    await vi.waitFor(() => expect(optimizing).toHaveBeenCalledTimes(1))
    const { args } = optimizing.mock.calls[0]![0]
    expect([
      flagValue(args, '--runs-per-candidate'),
      flagValue(args, '--proposals-per-iteration'),
      flagValue(args, '--max-workers'),
    ]).toEqual(['3', '7', '6'])
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
    sessions.optimize.setDecision('finalists', 0)
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
    sessions.optimize.reset()
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
      text: `optimize · run ${optimizationName(record)} failed · ask the chat why`,
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
    expect(notices.at(-1)).toEqual({ status: 'error', text: 'optimize · capital stopped · ask the chat why' })
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

  it('shouldApplyTheEditOfTheRunWhoseQuestionWasAnsweredWhenTwoRunsWaitForReview', async () => {
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizingProcess() })
    const capital = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    const cities = await savedExperiment(workspace, ['d0', 'd1', 'd2', 'd3'], 'cities')
    sessions.optimize.plan(capital)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    const first = sessions.optimize.start()
    await vi.waitFor(() => expect(sessions.ask.pending()).toBeDefined())
    const firstQuestion = sessions.ask.pending()!
    sessions.optimize.reset()
    sessions.optimize.plan(cities)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    const second = sessions.optimize.start()
    await vi.waitFor(() =>
      expect(sessions.optimize.snapshot().runs?.map(({ state }) => state.step)).toEqual(['review', 'review'])
    )

    sessions.ask.respond(firstQuestion.id, { verdict: 'accept' })

    const reviewOf = (id: string | undefined) => {
      const run = sessions.optimize.snapshot().runs?.find((candidate) => candidate.id === id)
      return run?.state.step === 'review' ? run.state.review : undefined
    }
    await vi.waitFor(() => expect(reviewOf(first)).toMatchObject({ applied: ['instructions.md'], reviewed: true }))
    expect(reviewOf(second)?.applied).toBeUndefined()
    expect(reviewOf(second)?.reviewed).toBeUndefined()
  })

  it('shouldOpenTheReviewOfTheRunWhoseStatusLineIsOpenedAheadOfTheOneOnScreen', async () => {
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizingProcess() })
    const capital = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    const cities = await savedExperiment(workspace, ['d0', 'd1', 'd2', 'd3'], 'cities')
    sessions.optimize.plan(capital)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    const first = sessions.optimize.start()
    await vi.waitFor(() => expect(sessions.ask.pending()?.topic).toBe(first))
    sessions.optimize.reset()
    sessions.optimize.plan(cities)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    const second = sessions.optimize.start()
    await vi.waitFor(() =>
      expect(sessions.optimize.snapshot().runs?.map(({ state }) => state.step)).toEqual(['review', 'review'])
    )
    const optimize = temporaryDevCommands(workspace, {
      root: workspace.root,
      entrypoint: workspace.entrypoint,
      language: 'python',
    }).find(({ spec }) => spec.name === 'optimize')!
    const { context } = chat()

    expect(optimize.openJob?.(context, second!)).toBe(true)

    expect(sessions.ask.pending()?.topic).toBe(second)
    expect(context.openPanel).toHaveBeenCalledWith('ask')
    sessions.ask.respond(sessions.ask.pending()!.id, { verdict: 'reject' })
    expect(sessions.ask.pending()?.topic).toBe(first)
  })

  it('shouldLeaveTheStatusLineOfARunWithNothingToReviewToTheRunsView', async () => {
    const gate = held()
    const optimizing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      await gate.promise
      await writeOptimizerRun(recordOf(args), [...studyLines(0.9), optimizerStop(), optimizerPicked('win')])
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    const running = sessions.optimize.start()
    await vi.waitFor(() => expect(optimizing).toHaveBeenCalledOnce())
    const optimize = temporaryDevCommands(workspace, {
      root: workspace.root,
      entrypoint: workspace.entrypoint,
      language: 'python',
    }).find(({ spec }) => spec.name === 'optimize')!
    const { context } = chat()

    expect(optimize.openJob?.(context, running!)).toBe(false)
    expect(optimize.openJob?.(context, 'no-such-run')).toBe(false)

    expect(context.openPanel).not.toHaveBeenCalled()
    gate.resolve()
    await vi.waitFor(() => expect(sessions.optimize.snapshot().runs?.[0]?.state.step).toBe('review'))
  })

  it('shouldDropTheJobLineOnceEveryEditOfARunWasAnsweredOnScreen', () => {
    const edit = { knob: 'instructions', kind: 'text', label: 'instructions', before: '', after: 'x', accepted: false }
    const review = { run: 'r1', record: 'r1', baseline: 0.1, best: 0.9, measuredOn: 'validation cases', edits: [edit] }
    const state = (reviewed: boolean) => ({
      step: 'pick' as const,
      runs: [
        {
          id: 'run-1',
          experiment: 'capital',
          startedAt: 0,
          state: { step: 'review' as const, review: { ...review, ...(reviewed ? { reviewed } : {}) } },
        },
      ],
    })

    expect(temporaryOptimizeJobs(state(false) as never)).toHaveLength(1)
    expect(temporaryOptimizeJobs(state(true) as never)).toEqual([])
  })

  it('shouldCountOnlyTheEditsTheScreenOffersInTheJobLine', () => {
    const edit = { knob: 'instructions', kind: 'text', label: 'instructions', before: '', after: 'x', accepted: false }
    const review = { run: 'r1', record: 'r1', baseline: 0.1, best: 0.9, measuredOn: 'validation cases' }
    const state = (edits: readonly object[]) => ({
      step: 'pick' as const,
      runs: [
        {
          id: 'run-1',
          experiment: 'capital',
          startedAt: 0,
          state: { step: 'review' as const, review: { ...review, edits } },
        },
      ],
    })

    const mixed = temporaryOptimizeJobs(state([edit, { ...edit, unavailable: 'set in code' }]) as never)
    const none = temporaryOptimizeJobs(state([{ ...edit, unavailable: 'set in code' }]) as never)

    expect(mixed.map(({ label, waiting }) => [label, waiting])).toEqual([['r1 · 1 to review', true]])
    expect(none).toEqual([])
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

  it('shouldShowTheEditsOnScreenWhenARunFinishesRatherThanOnlySayingSoInTheChat', async () => {
    const optimizing = optimizingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))

    sessions.optimize.start()
    await vi.waitFor(() => expect(sessions.ask.pending()).toBeDefined())

    const question = sessions.ask.pending()!
    expect(question.steps[0]?.fields.map(({ kind }) => kind)).toEqual(['select', 'diff'])
    expect(question.steps[0]?.fields[1]).toMatchObject({ kind: 'diff', path: expect.any(String) })
  })

  it('shouldApplyOnlyWhatTheDeveloperAcceptsInThatQuestion', async () => {
    const optimizing = optimizingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.start()
    await vi.waitFor(() => expect(sessions.ask.pending()).toBeDefined())

    sessions.ask.respond(sessions.ask.pending()!.id, { verdict: 'reject' })

    await vi.waitFor(() =>
      expect(sessions.optimize.snapshot()).toMatchObject({
        review: { reviewed: true, edits: [expect.objectContaining({ accepted: false, decided: true })] },
      })
    )
    expect(sessions.optimize.appliedChanges()).toEqual([])
  })

  describe('a chat message sent beside the diff of a finished run', () => {
    /** A finished run with two edits, instructions and effort, and the diff of the first on screen. */
    const twoEditsOnScreen = async () => {
      const optimizing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
        await writeOptimizerRun(recordOf(args), [
          ...studyLines(0.9, { baseline: { effort: 'low' }, winner: { effort: 'high' } }),
          optimizerStop(),
          optimizerPicked('win'),
        ])
        return exit
      })
      const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
      const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
      sessions.optimize.plan(experiment)
      await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
      sessions.optimize.toggleKnob('effort')
      sessions.optimize.start()
      await vi.waitFor(() => expect(sessions.ask.pending()?.question).toBe('Apply this change to instructions?'))
      const run = optimizationName(recordOf(optimizing.mock.calls[0]![0].args))
      const instructions = (): Promise<string> => readFile(join(workspace.root, 'instructions.md'), 'utf8')
      return { workspace, sessions, run, instructions }
    }

    it('shouldSayWhichDiffIsOnScreenAndHowToAnswerItForTheDeveloper', async () => {
      const { workspace, sessions, run } = await twoEditsOnScreen()

      const context = optimizeReviewContext(sessions)!

      expect(context).toContain(`a diff from the finished optimization run ${run}`)
      expect(context).toContain('It asks "Apply this change to instructions?"')
      expect(context).toContain('"Apply this change" and "Leave it as it is", and they have picked neither')
      expect(context).toContain(
        `The diff shows edit 0 (1 of the 2 that this run offers): instructions in instructions.md: now ` +
          `${JSON.stringify(BASELINE)}, would become ${JSON.stringify(WINNER)}`
      )
      expect(context).toContain(
        '- edit 1, effort in agent.py: low (the harness default; not in the call) → high: not answered yet'
      )
      expect(context).toContain(
        `call strands_dev_answer_review with run "${run}", edit 0, and answer "apply" or "leave"`
      )
      const ask = temporaryDevCommands(workspace, {
        root: workspace.root,
        entrypoint: workspace.entrypoint,
        language: 'python',
      }).find(({ spec }) => spec.name === 'ask')!
      expect(ask.screenContext?.()).toBe(context)
    })

    it('shouldSayNothingOfADiffWhenAQuestionOfTheAgentIsInFrontOfIt', async () => {
      const { sessions } = await twoEditsOnScreen()

      void sessions.ask.ask({
        name: 'experiment',
        question: 'Which experiment?',
        steps: [{ key: 'one', title: 'One', fields: [{ kind: 'text', key: 'answer', label: 'answer' }] }],
      })

      expect(sessions.ask.pending()?.question).toBe('Which experiment?')
      expect(optimizeReviewContext(sessions)).toBeUndefined()
    })

    it('shouldPickTheChoiceInTheDevelopersPlaceAndShowTheNextEdit', async () => {
      const { sessions, run, instructions } = await twoEditsOnScreen()

      const answered = await answerOptimizeReview(sessions, { run, edit: 0, apply: true })

      expect(answered).toEqual({
        run,
        settled: false,
        next: {
          edit: 1,
          change: 'effort in agent.py: low (the harness default; not in the call) → high',
          at: 1,
          of: 2,
        },
      })
      expect(sessions.ask.pending()?.question).toBe('Apply this change to effort?')
      expect(optimizeReviewContext(sessions)).toMatch(
        /- edit 0, instructions in instructions\.md: .*: answered on screen: apply/
      )
      // Nothing is written until every edit has its answer, as when the developer answers on screen.
      expect(await instructions()).toBe(`${BASELINE}\n`)
    })

    it('shouldWriteWhatWasAcceptedAndCloseTheDiffWhenTheLastEditIsAnswered', async () => {
      const { workspace, sessions, run, instructions } = await twoEditsOnScreen()
      await answerOptimizeReview(sessions, { run, edit: 0, apply: true })

      const answered = await answerOptimizeReview(sessions, { run, edit: 1, apply: false })

      expect(answered).toEqual({ run, settled: true, applied: ['instructions.md'] })
      expect(sessions.ask.pending()).toBeUndefined()
      expect(optimizeReviewContext(sessions)).toBeUndefined()
      expect(await instructions()).toBe(`${WINNER}\n`)
      expect(await readFile(workspace.entrypoint, 'utf8')).toContain('effort="low"')
      expect(temporaryOptimizeJobs(sessions.optimize.snapshot())).toEqual([])
    })

    it('shouldWriteNothingWhenEveryEditIsLeftAsItIs', async () => {
      const { sessions, run, instructions } = await twoEditsOnScreen()
      await answerOptimizeReview(sessions, { run, edit: 0, apply: false })

      const answered = await answerOptimizeReview(sessions, { run, edit: 1, apply: false })

      expect(answered).toEqual({ run, settled: true })
      expect(sessions.ask.pending()).toBeUndefined()
      expect(await instructions()).toBe(`${BASELINE}\n`)
      expect(sessions.optimize.appliedChanges()).toEqual([])
    })

    it.each([
      ['another edit of the run', (run: string) => ({ run, edit: 1 }), 'The diff on screen is edit 0 of run'],
      ['another run', () => ({ run: '20260101-000000-other', edit: 0 }), 'The diff on screen is edit 0 of run'],
    ])('shouldRefuseAnAnswerMeantFor%sAndLeaveTheDiffAsItIs', async (_case, meant, showing) => {
      const { sessions, run, instructions } = await twoEditsOnScreen()
      const question = sessions.ask.pending()

      const refused = answerOptimizeReview(sessions, { ...meant(run), apply: true })

      await expect(refused).rejects.toThrow("is not the diff on the developer's screen now, so nothing was picked")
      await expect(refused).rejects.toThrow(showing)
      expect(sessions.ask.pending()).toBe(question)
      expect(await instructions()).toBe(`${BASELINE}\n`)
    })

    describe('edits that the developer names in chat with no diff of them on screen', () => {
      const answers = (sessions: ReturnType<typeof temporaryDevSessions>): string[] => {
        const state = sessions.optimize.snapshot()
        const edits = state.step === 'review' ? state.review.edits : []
        return edits.map(
          ({ knob, accepted, decided }) => `${knob}: ${!decided ? 'waiting' : accepted ? 'apply' : 'leave'}`
        )
      }
      const onScreen = (sessions: ReturnType<typeof temporaryDevSessions>, verdict: 'accept' | 'reject' | undefined) =>
        sessions.ask.respond(sessions.ask.pending()!.id, verdict ? { verdict } : undefined)
      const effortOnScreen = (sessions: ReturnType<typeof temporaryDevSessions>) =>
        vi.waitFor(() => expect(sessions.ask.pending()?.question).toBe('Apply this change to effort?'))

      it('shouldKeepTheAnswerGivenOnScreenForAnEditThatWasNotNamed', async () => {
        const { sessions, run, instructions } = await twoEditsOnScreen()
        onScreen(sessions, 'accept')
        await effortOnScreen(sessions)
        onScreen(sessions, undefined)
        await vi.waitFor(() => expect(sessions.ask.pending()).toBeUndefined())

        const applied = await applyOptimizeEdits(sessions, { run, edits: [1] })

        // The instructions were answered "apply" on screen, and naming effort in chat does not take that back.
        expect(answers(sessions)).toEqual(['instructions: apply', 'effort: apply'])
        expect(applied).toMatchObject({ run, settled: true, applied: ['instructions.md'] })
        expect(await instructions()).toBe(`${WINNER}\n`)
      })

      it('shouldWriteNothingWhileAnotherEditStillWaitsAndLeaveItsDiffOnScreen', async () => {
        const { sessions, run, instructions } = await twoEditsOnScreen()
        const question = sessions.ask.pending()

        const applied = await applyOptimizeEdits(sessions, { run, edits: [1] })

        expect(applied).toEqual({ run, settled: false, waiting: 1, shown: true })
        expect(answers(sessions)).toEqual(['instructions: waiting', 'effort: apply'])
        expect(sessions.ask.pending()).toBe(question)
        expect(await instructions()).toBe(`${BASELINE}\n`)
      })

      it('shouldMoveTheScreenToTheEditThatStillWaitsWhenTheNamedOneWasShowing', async () => {
        const { sessions, run, instructions } = await twoEditsOnScreen()

        const applied = await applyOptimizeEdits(sessions, { run, edits: [0] })

        expect(applied).toEqual({ run, settled: false, waiting: 1, shown: true })
        expect(sessions.ask.pending()?.question).toBe('Apply this change to effort?')
        expect(answers(sessions)).toEqual(['instructions: apply', 'effort: waiting'])
        expect(await instructions()).toBe(`${BASELINE}\n`)
      })

      it('shouldApplyAnEditThatWasLeftOnScreenOnceTheDeveloperNamesItAndKeepTheOtherLeft', async () => {
        const { workspace, sessions, run, instructions } = await twoEditsOnScreen()
        onScreen(sessions, 'reject')
        await effortOnScreen(sessions)
        onScreen(sessions, 'reject')
        await vi.waitFor(() => expect(sessions.optimize.snapshot()).toMatchObject({ review: { reviewed: true } }))

        const applied = await applyOptimizeEdits(sessions, { run, edits: [0] })

        expect(applied).toEqual({ run, settled: true, applied: ['instructions.md'] })
        expect(answers(sessions)).toEqual(['instructions: apply', 'effort: leave'])
        expect(await instructions()).toBe(`${WINNER}\n`)
        expect(await readFile(workspace.entrypoint, 'utf8')).toContain('effort="low"')
      })

      it.each<[string, (run: string) => { run: string; edits: number[] }, string]>([
        [
          'a run that does not exist',
          () => ({ run: '20260101-000000-other', edits: [0] }),
          'No finished optimization is named 20260101-000000-other.',
        ],
        ['no edit', (run) => ({ run, edits: [] }), 'Name at least one edit to apply.'],
        ['an edit that the run does not have', (run) => ({ run, edits: [4] }), 'has no edit 4.'],
      ])('shouldRefuseAndChangeNothingWhenTheCallNames%s', async (_case, named, message) => {
        const { sessions, run, instructions } = await twoEditsOnScreen()

        await expect(applyOptimizeEdits(sessions, named(run))).rejects.toThrow(message)

        expect(answers(sessions)).toEqual(['instructions: waiting', 'effort: waiting'])
        expect(await instructions()).toBe(`${BASELINE}\n`)
      })

      it('shouldRefuseARunWhoseEditsWereWrittenAlready', async () => {
        const { sessions, run } = await twoEditsOnScreen()
        onScreen(sessions, 'accept')
        await effortOnScreen(sessions)
        onScreen(sessions, 'reject')
        await vi.waitFor(() =>
          expect(sessions.optimize.snapshot()).toMatchObject({ review: { applied: ['instructions.md'] } })
        )

        await expect(applyOptimizeEdits(sessions, { run, edits: [1] })).rejects.toThrow(
          `The edits of run ${run} were written already: instructions.md.`
        )
        expect(answers(sessions)).toEqual(['instructions: apply', 'effort: leave'])
      })
    })

    it('shouldRefuseAnAnswerWhenTheDeveloperClosedTheDiff', async () => {
      const { sessions, run } = await twoEditsOnScreen()
      sessions.ask.respond(sessions.ask.pending()!.id, undefined)
      await vi.waitFor(() => expect(sessions.ask.pending()).toBeUndefined())

      await expect(answerOptimizeReview(sessions, { run, edit: 0, apply: true })).rejects.toThrow(
        'No optimization diff is on screen.'
      )
      expect(optimizeReviewContext(sessions)).toBeUndefined()
    })
  })

  it('shouldKeepTheReviewWaitingWhenTheDeveloperSendsAChatMessageInstead', async () => {
    const optimizing = optimizingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.start()
    await vi.waitFor(() => expect(sessions.ask.pending()).toBeDefined())
    const question = sessions.ask.pending()!

    expect(sessions.ask.dropForTurn()).toBe(false)

    expect(sessions.ask.pending()).toBe(question)
    expect(temporaryOptimizeJobs(sessions.optimize.snapshot()).map(({ label }) => label)).toEqual([
      expect.stringContaining('1 to review'),
    ])
  })

  const closedOnAReview = async (optimizing = optimizingProcess()) => {
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    const run = sessions.optimize.start()!
    await vi.waitFor(() => expect(sessions.ask.pending()).toBeDefined())
    const record = recordOf(optimizing.mock.calls[0]![0].args)
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(resumeRecordOf(record), 'utf8'))).toMatchObject({ awaitsReview: true })
    )
    return { workspace, sessions, run, record }
  }

  const reopened = (workspace: DevWorkspace, settings: Pick<TemporarySessionHost, 'settings'> = {}) => {
    const { context, notices } = chat()
    const again = vi.fn()
    const host = (): TemporarySessionHost => ({
      workspace,
      agent: () => ({}),
      context,
      dependencies: { initialCopy: madeInitialCopy, run: environmentRunner(), spawnOptimizer: again },
      ...settings,
    })
    const optimize = new TemporaryOptimize(host, new TemporaryExperiments(host))
    optimize.onReview = vi.fn()
    return { optimize, notices, again }
  }

  it('shouldBringBackTheReviewOfARunWhenStrandsDevOpensAgainWithoutPuttingItOverTheChat', async () => {
    const { workspace, record } = await closedOnAReview()
    const { optimize, notices, again } = reopened(workspace)

    await optimize.resume()

    expect(optimize.snapshot().runs).toMatchObject([
      { record, state: { step: 'review', review: { edits: [expect.objectContaining({ after: WINNER })] } } },
    ])
    expect(temporaryOptimizeJobs(optimize.snapshot()).map(({ label }) => label)).toEqual([
      expect.stringContaining('1 to review'),
    ])
    expect(notices).toContainEqual({
      status: 'success',
      text: `optimize · run ${optimizationName(record)} · 1 edit still to review · ↓ Enter`,
    })
    expect(optimize.onReview).not.toHaveBeenCalled()
    expect(again).not.toHaveBeenCalled()
    expect(existsSync(resumeRecordOf(record))).toBe(true)
  })

  it('shouldStillBringTheReviewBackWhenTheRecordCouldNotBeMarkedAsWaiting', async () => {
    const optimizing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      await writeOptimizerRun(recordOf(args), [...studyLines(0.9), optimizerStop(), optimizerPicked('win')], {
        baseline_id: 'base',
        validation: { champion_id: 'win' },
      })
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.start()
    await vi.waitFor(() => expect(sessions.ask.pending()).toBeDefined())
    const record = recordOf(optimizing.mock.calls[0]![0].args)
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(resumeRecordOf(record), 'utf8'))).toMatchObject({ awaitsReview: true })
    )
    const { awaitsReview: _unmarked, ...asTheRunLeftIt } = JSON.parse(
      await readFile(resumeRecordOf(record), 'utf8')
    ) as Record<string, unknown>
    await writeFileAt(resumeRecordOf(record), JSON.stringify({ ...asTheRunLeftIt, pid: 999999 }))
    const { optimize, again } = reopened(workspace)

    await optimize.resume()

    expect(optimize.snapshot().runs).toMatchObject([
      { record, state: { step: 'review', review: { edits: [expect.objectContaining({ after: WINNER })] } } },
    ])
    expect(optimize.onReview).toHaveBeenCalledOnce()
    expect(again).not.toHaveBeenCalled()
  })

  it('shouldForgetTheReviewOfARunOnceItIsAnsweredAfterStrandsDevOpensAgain', async () => {
    const { workspace, record } = await closedOnAReview()
    const { optimize, notices } = reopened(workspace)
    await optimize.resume()
    const [run] = optimize.snapshot().runs ?? []

    optimize.finishReview(run!.id)

    await vi.waitFor(() => expect(existsSync(resumeRecordOf(record))).toBe(false))
    expect(temporaryOptimizeJobs(optimize.snapshot())).toEqual([])
    expect(notices).toEqual([{ status: 'success', text: `optimize · run ${optimizationName(record)} · reviewed` }])
    const later = reopened(workspace)
    await later.optimize.resume()
    expect(later.optimize.snapshot().runs ?? []).toEqual([])
  })

  it('shouldSayThatAnEditNoLongerFitsWhenTheAgentChangedBeforeStrandsDevOpenedAgain', async () => {
    const { workspace, record } = await closedOnAReview()
    await writeFileAt(join(workspace.root, 'instructions.md'), 'Rewritten by hand.\n')
    const { optimize, notices } = reopened(workspace)

    await optimize.resume()

    expect(temporaryOptimizeJobs(optimize.snapshot())).toEqual([])
    expect(notices).toContainEqual({
      status: 'success',
      text: `optimize · run ${optimizationName(record)} · its edits no longer fit the agent as it is now`,
    })
    expect(existsSync(resumeRecordOf(record))).toBe(false)
  })

  it('shouldTakeTheQuestionOffTheScreenWhenTheEditIsAppliedAnotherWay', async () => {
    const { sessions, run, record } = await closedOnAReview()

    sessions.optimize.accept(0, true, run)
    sessions.optimize.apply(run)

    await vi.waitFor(() => expect(sessions.ask.pending()).toBeUndefined())
    await vi.waitFor(() =>
      expect(sessions.optimize.snapshot()).toMatchObject({
        review: {
          applied: ['instructions.md'],
          reviewed: true,
          edits: [expect.objectContaining({ accepted: true })],
        },
      })
    )
    expect(temporaryOptimizeJobs(sessions.optimize.snapshot())).toEqual([])
    await vi.waitFor(() => expect(existsSync(resumeRecordOf(record))).toBe(false))
  })

  it('shouldKeepTheRunWaitingWhenTheDeveloperClosesItsQuestionWithoutAnAnswer', async () => {
    const { workspace, sessions, run, record } = await closedOnAReview()
    const optimize = temporaryDevCommands(workspace, {
      root: workspace.root,
      entrypoint: workspace.entrypoint,
      language: 'python',
    }).find(({ spec }) => spec.name === 'optimize')!
    const { context } = chat()

    sessions.ask.respond(sessions.ask.pending()!.id, undefined)
    await new Promise((done) => setTimeout(done, 20))

    expect(sessions.ask.pending()).toBeUndefined()
    expect(temporaryOptimizeJobs(sessions.optimize.snapshot()).map(({ label }) => label)).toEqual([
      expect.stringContaining('1 to review'),
    ])
    expect(sessions.optimize.snapshot()).not.toMatchObject({ review: { reviewed: true } })
    expect(sessions.optimize.appliedChanges()).toEqual([])
    expect(existsSync(resumeRecordOf(record))).toBe(true)

    expect(optimize.openJob?.(context, run)).toBe(true)
    expect(sessions.ask.pending()?.topic).toBe(run)
    sessions.ask.respond(sessions.ask.pending()!.id, { verdict: 'accept' })

    await vi.waitFor(() =>
      expect(sessions.optimize.snapshot()).toMatchObject({ review: { applied: ['instructions.md'], reviewed: true } })
    )
    expect(temporaryOptimizeJobs(sessions.optimize.snapshot())).toEqual([])
  })

  it('shouldWriteNothingUntilEveryEditHasAnAnswerAndCarryOnWhereTheDeveloperLeftOff', async () => {
    const optimizing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      await writeOptimizerRun(recordOf(args), [
        ...studyLines(0.9, { baseline: { effort: 'low' }, winner: { effort: 'high' } }),
        optimizerStop(),
        optimizerPicked('win'),
      ])
      return exit
    })
    const { workspace, sessions, notices } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.toggleKnob('effort')
    const run = sessions.optimize.start()!
    await vi.waitFor(() => expect(sessions.ask.pending()).toBeDefined())
    const record = recordOf(optimizing.mock.calls[0]![0].args)
    const asking = (): (string | undefined)[] => [
      sessions.ask.pending()?.titleParts?.[0],
      sessions.ask.pending()?.question,
    ]
    expect(asking()).toEqual(['edit 1 of 2', 'Apply this change to instructions?'])

    sessions.ask.respond(sessions.ask.pending()!.id, { verdict: 'accept' })
    await vi.waitFor(() => expect(asking()).toEqual(['edit 2 of 2', 'Apply this change to effort?']))
    sessions.ask.respond(sessions.ask.pending()!.id, undefined)
    await new Promise((done) => setTimeout(done, 20))

    expect(await readFile(join(workspace.root, 'instructions.md'), 'utf8')).toBe(`${BASELINE}\n`)
    expect(sessions.optimize.appliedChanges()).toEqual([])
    expect(temporaryOptimizeJobs(sessions.optimize.snapshot()).map(({ label }) => label)).toEqual([
      expect.stringContaining('1 to review'),
    ])
    expect(notices.at(-1)).toEqual({
      status: 'success',
      text: `optimize · run ${optimizationName(record)} · 1 of 2 edits answered · nothing is written until all are · ↓ Enter`,
    })

    const optimize = temporaryDevCommands(workspace, {
      root: workspace.root,
      entrypoint: workspace.entrypoint,
      language: 'python',
    }).find(({ spec }) => spec.name === 'optimize')!
    expect(optimize.openJob?.(chat().context, run)).toBe(true)
    expect(asking()).toEqual(['edit 2 of 2', 'Apply this change to effort?'])
    sessions.ask.respond(sessions.ask.pending()!.id, { verdict: 'reject' })

    await vi.waitFor(() =>
      expect(sessions.optimize.snapshot()).toMatchObject({ review: { applied: ['instructions.md'], reviewed: true } })
    )
    expect(await readFile(join(workspace.root, 'instructions.md'), 'utf8')).toBe(`${WINNER}\n`)
    expect(await readFile(workspace.entrypoint, 'utf8')).toContain('effort="low"')
    expect(temporaryOptimizeJobs(sessions.optimize.snapshot())).toEqual([])
  })

  it('shouldWriteTheEditsOfARunOnlyOnceWhenApplyIsReachedTwice', async () => {
    const { sessions, run } = await closedOnAReview()
    sessions.optimize.accept(0, true, run)
    sessions.optimize.apply(run)
    await vi.waitFor(() =>
      expect(sessions.optimize.snapshot()).toMatchObject({ review: { applied: ['instructions.md'] } })
    )

    sessions.optimize.apply(run)
    await new Promise((done) => setTimeout(done, 50))

    expect(sessions.optimize.appliedChanges()).toHaveLength(1)
    expect(sessions.optimize.snapshot()).toMatchObject({ review: { applied: ['instructions.md'] } })
    expect(sessions.optimize.snapshot()).not.toMatchObject({ review: { applyError: expect.anything() } })
  })

  it('shouldDropTheJobLineOnceAnAcceptedEditIsWritten', async () => {
    const optimizing = optimizingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.start()
    await vi.waitFor(() => expect(sessions.ask.pending()).toBeDefined())

    sessions.ask.respond(sessions.ask.pending()!.id, { verdict: 'accept' })

    await vi.waitFor(() =>
      expect(sessions.optimize.snapshot()).toMatchObject({ review: { applied: ['instructions.md'], reviewed: true } })
    )
    expect(temporaryOptimizeJobs(sessions.optimize.snapshot())).toEqual([])
  })

  it('shouldSayWhatWasAppliedAgainInTheChatThatTheReloadOpens', async () => {
    const optimizing = optimizingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.start()
    await vi.waitFor(() => expect(sessions.ask.pending()).toBeDefined())
    sessions.ask.respond(sessions.ask.pending()!.id, { verdict: 'accept' })
    await vi.waitFor(() =>
      expect(sessions.optimize.snapshot()).toMatchObject({ review: { applied: ['instructions.md'] } })
    )
    const optimize = temporaryDevCommands(workspace, {
      root: workspace.root,
      entrypoint: workspace.entrypoint,
      language: 'python',
    }).find(({ spec }) => spec.name === 'optimize')!
    const reloaded = chat()
    const later = chat()

    optimize.attach?.(reloaded.context)
    optimize.attach?.(later.context)

    const applied = {
      status: 'success',
      text: 'optimize · applied instructions.md · run the experiment again from /experiment to check your agent',
    }
    expect(reloaded.notices).toContainEqual(applied)
    expect(later.notices).not.toContainEqual(applied)
  })

  it('shouldNotSayWhatWasAppliedToAChatThatOpensLongAfterTheWrite', async () => {
    const optimizing = optimizingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.start()
    await vi.waitFor(() => expect(sessions.ask.pending()).toBeDefined())
    sessions.ask.respond(sessions.ask.pending()!.id, { verdict: 'accept' })
    await vi.waitFor(() =>
      expect(sessions.optimize.snapshot()).toMatchObject({ review: { applied: ['instructions.md'] } })
    )
    const muchLater = chat()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)

    sessions.optimize.reannounce()
    clock.mockRestore()

    expect(muchLater.notices).toEqual([])
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

  it('shouldCountTheWholeRunInTheJobLineSoItIsNotFullWhenOnlyTheSearchIsDone', async () => {
    const begin = held()
    const end = held()
    const searched = [
      ...studyLines(0.9),
      optimizerTrial({ candidate: 'base', caseName: 'c0' }),
      optimizerTrial({ candidate: 'win', caseName: 'c0' }),
      optimizerStop(),
    ]
    const optimizing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      await begin.promise
      await writeOptimizerRun(recordOf(args), searched)
      await end.promise
      await writeOptimizerRun(recordOf(args), [...searched, optimizerPicked('win')])
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    const plan = setupPlan(sessions)
    const job = (): object | undefined => temporaryOptimizeJobs(sessions.optimize.snapshot())[0]

    sessions.optimize.start()
    await vi.waitFor(() => expect(optimizing).toHaveBeenCalledOnce())
    const starting = job()
    begin.resolve()

    // The search stopped with both versions measured, which the count of versions would call done.
    const afterSearch = plan.split.validation * (plan.validatedFinalists + 1) + plan.split.test * 2
    await vi.waitFor(() => expect(job()).toMatchObject({ done: 2, total: 2 + afterSearch }), { timeout: 5000 })
    expect(starting).toMatchObject({ done: 0, total: plan.rollouts })
    expect(afterSearch).toBeGreaterThan(0)
    end.resolve()
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
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

  describe('an optimization that starts by itself every so many chat turns', () => {
    const everyFive: Pick<TemporarySessionHost, 'settings'> = {
      settings: () => ({ autoAcceptOptimizationResults: false, autoOptimize: 5 }),
    }
    const FIVE = ['one', 'two', 'three', 'four', 'five']

    it('shouldMakeAnExperimentAwayFromTheChatAndStartTheOptimizerOnItWhenThatManyTurnsEnd', async () => {
      const optimizer = optimizingProcess()
      const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizer }, everyFive)
      const order: string[] = []
      // The agent in a process of its own, played here: it saves the experiment it is asked for.
      const worker = vi.fn<AutoOptimizeWorker>(async ({ prompt }) => {
        order.push('agent')
        await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'], /save it as (\S+)/u.exec(prompt)![1])
        return { code: 0 }
      })
      optimizer.mockImplementationOnce(async (process) => {
        order.push('optimizer')
        return optimizingProcess()(process)
      })
      const optimize = temporaryDevCommands(
        workspace,
        { root: workspace.root, entrypoint: workspace.entrypoint, language: 'python' },
        () => ({}),
        everyFive.settings,
        {
          worker,
          history: { unattendedConverter: async ({ name }) => `save it as ${name}` },
          now: () => new Date(2026, 10, 23, 15, 2),
        }
      ).find(({ spec }) => spec.name === 'optimize')!
      const { context, notices } = chat()

      // The turn that set the cadence is not counted.
      for (const prompt of ['optimize every 5 turns', ...FIVE.slice(0, 4)]) optimize.turnEnded?.(context, { prompt })
      await new Promise((done) => setTimeout(done, 20))
      const before = worker.mock.calls.length
      optimize.turnEnded?.(context, { prompt: 'five' })
      await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'), { timeout: 5000 })
      await sessions.auto.settled()

      expect(before).toBe(0)
      expect(order).toEqual(['agent', 'optimizer'])
      expect(recordOf(optimizer.mock.calls[0]![0].args)).toContain(join('experiments', 'history-20261123-1502'))
      // The chat is sent no request and asked nothing: it is told of the work in one notice, and of the run's end.
      expect(context.submit).not.toHaveBeenCalled()
      expect(notices.map(({ text }) => text).filter((text) => text.startsWith('auto-optimize'))).toEqual([
        'auto-optimize · made history-20261123-1502 from your chats (4 cases) · optimizing on it in the background',
      ])
    })

    it('shouldWaitUntilTheEditsOfAFinishedRunHaveTheirAnswer', async () => {
      const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizingProcess() }, everyFive)
      const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
      sessions.optimize.plan(experiment)
      await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
      sessions.optimize.start()
      await vi.waitFor(() => expect(sessions.ask.pending()).toBeDefined())
      const work = vi.fn<AutoOptimizeRun>(async () => ({ experiment: 'history-20261123-1502', cases: 4 }))

      for (const prompt of ['optimize every 5 turns', ...FIVE]) await sessions.auto.turnEnded({ prompt }, work)
      const whileTheDiffWaits = work.mock.calls.length
      sessions.ask.respond(sessions.ask.pending()!.id, { verdict: 'reject' })
      await vi.waitFor(() => expect(sessions.optimize.snapshot()).toMatchObject({ review: { reviewed: true } }))
      await sessions.auto.turnEnded({ prompt: 'six' }, work)

      expect(whileTheDiffWaits).toBe(0)
      expect(work).toHaveBeenCalledOnce()
    })

    it('shouldLetAnOptimizationThatStartedMeanwhileEndBeforeItsOwnBegins', async () => {
      const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizingProcess() }, everyFive)
      const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
      const reached: string[] = []
      const work = vi.fn<AutoOptimizeRun>(async ({ idle }) => {
        // The developer starts a run of their own while the experiment is made.
        sessions.optimize.plan(experiment)
        await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
        sessions.optimize.start()
        await vi.waitFor(() => expect(sessions.ask.pending()).toBeDefined())
        void idle().then(() => reached.push('idle'))
        await new Promise((done) => setTimeout(done, 20))
        reached.push('waited')
        sessions.ask.respond(sessions.ask.pending()!.id, { verdict: 'reject' })
        await vi.waitFor(() => expect(reached).toContain('idle'))
        return { experiment: 'history-20261123-1502', cases: 4 }
      })

      for (const prompt of ['optimize every 5 turns', ...FIVE]) await sessions.auto.turnEnded({ prompt }, work)
      await sessions.auto.settled()

      expect(reached).toEqual(['waited', 'idle'])
    })

    it('shouldChangeASettingThroughTheChatThatIsOpenAndSayWhenItCannot', async () => {
      const { workspace, sessions } = await sessionsFor()
      const unsaved = sessions.setSettings({ autoOptimize: 20 })
      await expect(unsaved).rejects.toThrow('No chat is open to change the settings through.')
      const setSettings = vi.fn(async () => true)
      temporaryDevSessions({ workspace, agent: () => ({}), context: { ...chat().context, setSettings } })

      await sessions.setSettings({ autoOptimize: 20 })
      setSettings.mockResolvedValueOnce(false)

      expect(setSettings).toHaveBeenCalledExactlyOnceWith({ autoOptimize: 20 })
      await expect(sessions.setSettings({ autoOptimize: 5 })).rejects.toThrow('The setting could not be saved.')
    })

    it('shouldGiveTheSettingsOfTheWorkspaceAsTheyAreNow', async () => {
      let every = 5
      const { sessions } = await sessionsFor(
        {},
        { settings: () => ({ autoAcceptOptimizationResults: true, autoOptimize: every }) }
      )

      const before = sessions.settings()
      every = 20

      expect(before).toMatchObject({ autoOptimize: 5, autoAcceptOptimizationResults: true })
      expect(sessions.settings()).toMatchObject({ autoOptimize: 20 })
      expect(await sessions.auto.status()).toEqual({ everyTurns: 20, turnsSince: 0 })
    })
  })

  describe('with auto-accept', () => {
    /** The settings of a workspace whose finished runs are written without a review, or not. */
    const accepting = (on: () => boolean = () => true): Pick<TemporarySessionHost, 'settings'> => ({
      settings: () => ({ autoAcceptOptimizationResults: on(), autoOptimize: 0 }),
    })

    const planned = async (
      optimizing: NonNullable<TemporarySessionDependencies['spawnOptimizer']>,
      on: () => boolean = () => true
    ) => {
      const opened = await sessionsFor({ spawnOptimizer: optimizing }, accepting(on))
      const experiment = await savedExperiment(opened.workspace, ['c0', 'c1', 'c2', 'c3'])
      opened.sessions.optimize.plan(experiment)
      await vi.waitFor(() => expect(opened.sessions.optimize.snapshot().step).toBe('setup'))
      return opened
    }

    const instructionsOf = (workspace: DevWorkspace): Promise<string> =>
      readFile(join(workspace.root, 'instructions.md'), 'utf8')

    /** A run whose end waits for the test, so the setting can change while the run goes. */
    const heldRun = () => {
      const end = held()
      const finishing = optimizingProcess()
      const optimizing = vi.fn(async (process: TemporaryEvalsProcess) => {
        await end.promise
        return finishing(process)
      })
      return { end, optimizing }
    }

    it('shouldTakeTheSettingFromTheChatThatOpensTheWorkspaceAsItIsNow', async () => {
      let on = false
      const { workspace, sessions } = await sessionsFor()
      const project = { root: workspace.root, entrypoint: workspace.entrypoint, language: 'python' as const }
      const commands = temporaryDevCommands(workspace, project, () => ({}), accepting(() => on).settings)
      commands.find(({ spec }) => spec.name === 'ask')!.attach?.(chat().context)

      const before = sessions.optimize.autoApplies()
      on = true

      expect(before).toBe(false)
      expect(sessions.optimize.autoApplies()).toBe(true)
    })

    it('shouldWriteTheEditsOfAFinishedRunWithoutShowingThemWhenItIsOn', async () => {
      const optimizing = optimizingProcess()
      const { workspace, sessions, notices } = await planned(optimizing)
      const asked = vi.spyOn(sessions.ask, 'ask')
      const waited: boolean[] = []
      sessions.optimize.subscribe(() =>
        waited.push(temporaryOptimizeJobs(sessions.optimize.snapshot()).some(({ waiting }) => waiting === true))
      )

      sessions.optimize.start()

      await vi.waitFor(() =>
        expect(sessions.optimize.snapshot()).toMatchObject({
          step: 'review',
          review: {
            auto: true,
            reviewed: true,
            applied: ['instructions.md'],
            edits: [expect.objectContaining({ knob: 'instructions', accepted: true, decided: true })],
          },
        })
      )
      expect(await instructionsOf(workspace)).toBe(`${WINNER}\n`)
      expect(asked).not.toHaveBeenCalled()
      expect(waited).not.toContain(true)
      expect(temporaryOptimizeJobs(sessions.optimize.snapshot())).toEqual([])
      const record = recordOf(optimizing.mock.calls[0]![0].args)
      expect(notices.map(({ text }) => text).filter((text) => text.startsWith('optimize · '))).toEqual([
        `optimize · run ${optimizationName(record)} finished · auto-accept is on · applying 1 edit`,
        'optimize · auto-accept applied instructions.md · run the experiment again from /experiment to check your agent',
      ])
      expect(sessions.optimize.appliedChanges()).toEqual([
        expect.objectContaining({ auto: true, edits: [expect.objectContaining({ after: WINNER })] }),
      ])
      await vi.waitFor(() => expect(existsSync(resumeRecordOf(record))).toBe(false))
    })

    const APPLIED = {
      status: 'success',
      text: 'optimize · auto-accept applied instructions.md · run the experiment again from /experiment to check your agent',
    }

    /** The chat that opens `after` milliseconds past the write of a run's edits, and what it was told. */
    const chatOpenedAfterTheWrite = async (after: number) => {
      const { workspace, sessions } = await planned(optimizingProcess())
      sessions.optimize.start()
      await vi.waitFor(() =>
        expect(sessions.optimize.snapshot()).toMatchObject({ review: { applied: ['instructions.md'] } })
      )
      const optimize = temporaryDevCommands(workspace, {
        root: workspace.root,
        entrypoint: workspace.entrypoint,
        language: 'python',
      }).find(({ spec }) => spec.name === 'optimize')!
      const opened = chat()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + after)
      optimize.attach?.(opened.context)
      clock.mockRestore()
      return opened.notices
    }

    it('shouldSayWhatWasAppliedInTheChatThatTheReloadOpensOnceTheAgentReportedTheRun', async () => {
      // The reload waits for the turn that reports the run, which outlasts the wait after an answer on screen.
      expect(await chatOpenedAfterTheWrite(60_000)).toContainEqual(APPLIED)
    })

    it('shouldNotSayWhatWasAppliedToAChatThatOpensLongAfterTheWrite', async () => {
      expect(await chatOpenedAfterTheWrite(600_000)).not.toContainEqual(APPLIED)
    })

    it('shouldReadTheSettingWhenTheRunEndsSoTurningItOnWhileARunGoesCounts', async () => {
      let on = false
      const { end, optimizing } = heldRun()
      const { workspace, sessions } = await planned(optimizing, () => on)
      sessions.optimize.start()
      await vi.waitFor(() => expect(optimizing).toHaveBeenCalledOnce())

      on = true
      end.resolve()

      await vi.waitFor(() =>
        expect(sessions.optimize.snapshot()).toMatchObject({ review: { auto: true, applied: ['instructions.md'] } })
      )
      expect(await instructionsOf(workspace)).toBe(`${WINNER}\n`)
      expect(sessions.ask.pending()).toBeUndefined()
    })

    it('shouldShowTheEditsForReviewWhenItWasTurnedOffBeforeTheRunEnded', async () => {
      let on = true
      const { end, optimizing } = heldRun()
      const { workspace, sessions } = await planned(optimizing, () => on)
      sessions.optimize.start()
      await vi.waitFor(() => expect(optimizing).toHaveBeenCalledOnce())

      on = false
      end.resolve()

      await vi.waitFor(() => expect(sessions.ask.pending()).toMatchObject({ name: 'optimize' }))
      expect(sessions.optimize.snapshot()).not.toMatchObject({ review: { auto: true } })
      expect(sessions.optimize.snapshot()).not.toMatchObject({ review: { applied: expect.anything() } })
      expect(await instructionsOf(workspace)).toBe(`${BASELINE}\n`)
    })

    it('shouldStillAskAboutTheBestSoFarOfARunTheDeveloperStopped', async () => {
      const stopped = vi.fn(async ({ args, signal }: TemporaryEvalsProcess) => {
        await writeOptimizerRun(recordOf(args), studyLines(0.8))
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
        return { code: 143, stdout: '', stderrTail: ['terminated'] }
      })
      const { workspace, sessions, notices } = await planned(stopped)
      sessions.optimize.start()
      await vi.waitFor(
        () =>
          expect(sessions.optimize.snapshot()).toMatchObject({ step: 'running', progress: { best: { number: 1 } } }),
        { timeout: 5000 }
      )

      sessions.optimize.stop()

      await vi.waitFor(() => expect(sessions.ask.pending()).toMatchObject({ name: 'optimize' }))
      expect(sessions.optimize.snapshot()).toMatchObject({
        step: 'review',
        review: { edits: [expect.objectContaining({ after: WINNER })] },
      })
      expect(sessions.optimize.snapshot()).not.toMatchObject({ review: { auto: true } })
      expect(await instructionsOf(workspace)).toBe(`${BASELINE}\n`)
      expect(notices.map(({ text }) => text)).toContainEqual(expect.stringContaining('finished · showing 1 edit'))
    })

    it('shouldLeaveAReviewThatWaitedWhenStrandsDevClosedWaitingWhenItOpensAgain', async () => {
      const { workspace, record } = await closedOnAReview()
      const { optimize, notices } = reopened(workspace, accepting())

      await optimize.resume()

      expect(optimize.snapshot().runs).toMatchObject([{ record, state: { step: 'review' } }])
      expect(optimize.snapshot().runs).not.toMatchObject([{ state: { review: { auto: true } } }])
      expect(temporaryOptimizeJobs(optimize.snapshot()).map(({ label }) => label)).toEqual([
        expect.stringContaining('1 to review'),
      ])
      expect(notices).toContainEqual({
        status: 'success',
        text: `optimize · run ${optimizationName(record)} · 1 edit still to review · ↓ Enter`,
      })
      expect(await instructionsOf(workspace)).toBe(`${BASELINE}\n`)
    })

    it('shouldWriteTheEditsOfARunThatFinishedWhileStrandsDevWasClosedWhenItOpensAgain', async () => {
      const withResult = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
        await writeOptimizerRun(recordOf(args), [...studyLines(0.9), optimizerStop(), optimizerPicked('win')], {
          baseline_id: 'base',
          validation: { champion_id: 'win' },
        })
        return exit
      })
      const { workspace, record } = await closedOnAReview(withResult)
      const { awaitsReview: _unmarked, ...asTheRunLeftIt } = JSON.parse(
        await readFile(resumeRecordOf(record), 'utf8')
      ) as Record<string, unknown>
      await writeFileAt(resumeRecordOf(record), JSON.stringify({ ...asTheRunLeftIt, pid: 999999 }))
      const { optimize, notices, again } = reopened(workspace, accepting())

      await optimize.resume()

      expect(optimize.snapshot().runs).toMatchObject([
        { record, state: { step: 'review', review: { auto: true, applied: ['instructions.md'] } } },
      ])
      expect(await instructionsOf(workspace)).toBe(`${WINNER}\n`)
      expect(optimize.onReview).not.toHaveBeenCalled()
      expect(again).not.toHaveBeenCalled()
      expect(notices.map(({ text }) => text)).toContainEqual(
        'optimize · auto-accept applied instructions.md · run the experiment again from /experiment to check your agent'
      )
    })
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
  it('shouldWaitForAChoiceWhenTheTestPanelOpensWithOneExperiment', async () => {
    const tests = testingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnTests: tests })
    await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])

    sessions.test.show()
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
    const held = vi.fn(
      (process: TemporaryEvalsProcess): Promise<TemporaryEvalsExit> =>
        new Promise((resolve) => {
          process.signal?.addEventListener('abort', () => resolve({ code: 143, stdout: '', stderrTail: [] }), {
            once: true,
          })
          void gate.then(() => (process.signal?.aborted ? undefined : resolve(testing(process))))
        })
    )
    const { workspace, sessions } = await sessionsFor({ spawnTests: held })
    const capital = await savedExperiment(workspace, ['c0', 'c1'])
    const cities = await savedExperiment(workspace, ['c0', 'c1', 'c2'], 'cities')

    sessions.test.run([capital, cities])
    await vi.waitFor(() => expect(held).toHaveBeenCalledTimes(2))
    const jobs = temporaryTestJobs(sessions.test.snapshot())
    // Each experiment is its own run, so stopping one leaves the other running.
    sessions.test.stop(capital.path)
    await vi.waitFor(() => expect(runStatus(sessions, capital.path)).toBe('failed'))
    expect(runStatus(sessions, cities.path)).toBe('running')
    release()
    await vi.waitFor(() => expect(runStatus(sessions, cities.path)).toBe('done'))

    expect(jobs.map(({ label }) => label).sort()).toEqual(['capital', 'cities'])
    expect(finished(sessions, cities.path).cases).toHaveLength(3)
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

    rerunFailed(sessions, path)
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
        text: expect.stringMatching(/^evaluate · capital · this report is not kept as the latest after a restart: /u),
      },
      {
        status: 'success',
        // The latest copy was not written, so the notice points at the report of the run itself.
        text: expect.stringMatching(
          new RegExp(
            `^evaluate · capital · 1 of 2 cases passed · report in ${escaped(join(experimentHome(workspace), 'runs'))}${escaped(sep)}\\d{8}-\\d{6}${escaped(sep)}report\\.json$`,
            'u'
          )
        ),
      },
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

    rerunFailed(sessions, path)
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
      text: `evaluate · capital · 2 of 3 cases passed · report in ${join(experimentHome(workspace), 'capital.report.json')}`,
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
      text: `evaluate · capital · 1 of 1 rerun case passed · 3 of 3 cases passed · report in ${join(experimentHome(workspace), 'capital.report.json')}`,
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

  it('shouldRecordTheProcessOfARunWhileItGoesAndForgetItWhenTheRunEnds', { timeout: 3 * RECORD_WAIT_MS }, async () => {
    const testing = testingProcess()
    let directory = ''
    const spawnTests = vi.fn(async (request: TemporaryEvalsProcess) => {
      request.onSpawn?.(4242)
      await vi.waitFor(async () => expect((await readTemporaryRunRecords(directory))[0]?.pid).toBe(4242), {
        timeout: RECORD_WAIT_MS,
      })
      return testing(request)
    })
    const { workspace, sessions } = await sessionsFor({ spawnTests })
    directory = workspace.directory!
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2'])

    sessions.test.run([experiment])

    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('done'), { timeout: RECORD_WAIT_MS })
    await vi.waitFor(async () => expect(await readTemporaryRunRecords(directory)).toEqual([]))
  })
})

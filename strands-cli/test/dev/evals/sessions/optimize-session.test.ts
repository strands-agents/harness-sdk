import { existsSync } from 'node:fs'
import { readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CliConfigStore } from '../../../../src/config/store.js'
import { createDevWorkspace } from '../../../../src/dev/create.js'
import type { ExperimentSummary, OptimizePlan } from '../../../../src/dev/evals/model.js'
import * as installer from '../../../../src/project/archive.js'
import { readEvalsOptimizeRecords } from '../../../../src/dev/evals/runs/background-runs.js'
import { evalsVenvPython } from '../../../../src/dev/evals/runs/environment.js'
import type { EvalsProcess } from '../../../../src/dev/evals/runs/evals-process.js'
import type { EvalsSessionDependencies } from '../../../../src/dev/evals/host.js'
import { evalsDevChatPart, evalsDevCommands } from '../../../../src/dev/evals/chat/command.js'
import { EvalsExperiments } from '../../../../src/dev/evals/sessions/experiments-session.js'
import type { EvalsSessionHost } from '../../../../src/dev/evals/host.js'
import type { AutoOptimizeRun, AutoOptimizeWorker } from '../../../../src/dev/evals/sessions/auto-optimize.js'
import {
  answerOptimizeReview,
  applyOptimizeEdits,
  optimizeReviewContext,
} from '../../../../src/dev/evals/sessions/review-run.js'
import { EvalsOptimize, evalsOptimizeJobs } from '../../../../src/dev/evals/sessions/optimize-session.js'
import { evalsDevSessions } from '../../../../src/dev/evals/sessions/sessions.js'
import type { DevWorkspace } from '../../../../src/dev/workspace.js'
import { watchAgentProject } from '../../../../src/project/watch.js'
import { pythonExecutable } from '../../../fixtures/python-runtime.js'
import { temporaryDirectory } from '../../../fixtures/tempdir.js'
import {
  environmentRunner,
  OPTIMIZER_RUN_FOLDER,
  optimizerCandidate,
  optimizerConfig,
  optimizerIterationEnd,
  optimizerPicked,
  optimizerStop,
  optimizerTested,
  optimizerTrial,
  writeFileAt,
  writeOptimizerRun,
} from '../../../fixtures/optimizer-run.js'
import {
  BASELINE,
  chat,
  exit,
  experimentHome,
  flagValue,
  held,
  restartedHost,
  savedExperiment,
  sessionsFor,
} from '../../../fixtures/evals-sessions.js'

const WINNER = 'Answer in one word.\nName the capital city.'

const setupPlan = ({ optimize }: { readonly optimize: EvalsOptimize }): OptimizePlan => {
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

const proposerStopped = {
  code: 3,
  stdout: '',
  stderrTail: ["strands-evals: error: the search stopped: a proposer (block 'instructions') raised KeyError: x"],
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
  vi.fn(async ({ args }: EvalsProcess) => {
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

const restartedOptimize = (
  workspace: DevWorkspace,
  dependencies?: Partial<EvalsSessionDependencies>
): EvalsOptimize => {
  const host = restartedHost(workspace, dependencies)
  return new EvalsOptimize(host, new EvalsExperiments(host))
}

const CASES = ['c0', 'c1', 'c2', 'c3']

const TWENTY_CASES = Array.from({ length: 20 }, (_, index) => `c${index}`)

/** The sessions of a workspace with a saved experiment whose optimize plan is open. */
const plannedSessions = async (
  dependencies: Partial<EvalsSessionDependencies> = {},
  {
    names = CASES,
    evaluators,
    host,
  }: { names?: readonly string[]; evaluators?: readonly string[]; host?: Pick<EvalsSessionHost, 'settings'> } = {}
) => {
  const made = await sessionsFor(dependencies, host)
  const experiment = await savedExperiment(made.workspace, names, 'capital', evaluators)
  made.sessions.optimize.plan(experiment)
  await vi.waitFor(() => expect(made.sessions.optimize.snapshot().step).toBe('setup'))
  return { ...made, experiment }
}

/** An optimizer that finishes once its record holds its process, with what the record said then. */
const recordingOptimizer = () => {
  let seen: unknown
  const optimizing = vi.fn(async (process: EvalsProcess) => {
    process.onSpawn?.(4242)
    await vi.waitFor(async () => {
      seen = JSON.parse(await readFile(resumeRecordOf(recordOf(process.args)), 'utf8'))
      expect(seen).toMatchObject({ pid: 4242 })
    })
    await writeOptimizerRun(recordOf(process.args), [...studyLines(0.9), optimizerStop(), optimizerPicked('win')])
    return exit
  })
  return { optimizing, recorded: (): unknown => seen }
}

/** A finished run with its first edit on the developer's screen as a question. */
const reviewOnScreen = async (optimizing = optimizingProcess(), host?: Pick<EvalsSessionHost, 'settings'>) => {
  const made = await plannedSessions({ spawnOptimizer: optimizing }, host ? { host } : {})
  const run = made.sessions.optimize.start()!
  await vi.waitFor(() => expect(made.sessions.ask.pending()).toBeDefined())
  return { ...made, optimizing, run }
}

const devCommand = (workspace: DevWorkspace, name: string) =>
  evalsDevCommands(workspace, {
    root: workspace.root,
    entrypoint: workspace.entrypoint,
    language: 'python',
  }).find(({ spec }) => spec.name === name)!

/** The files of a run that strands dev closed on: its search space and the record it resumes from. */
const interruptedRun = async (workspace: DevWorkspace, experiment: ExperimentSummary, recorded: object = {}) => {
  const files = optimizationFiles(workspace)
  await writeFileAt(
    files.space,
    JSON.stringify({ variables: [{ key: 'instructions', kind: 'text', option: 'instructions' }] })
  )
  await writeFileAt(
    files.resume,
    JSON.stringify({
      version: 1,
      experiment: experiment.path,
      record: files.record,
      space: files.space,
      iterations: 4,
      startedAt: 1,
      pid: 999999,
      ...recorded,
    })
  )
  return files
}

describe('optimization session', () => {
  it('shouldPlanTheSplitAndUpdateTheEstimateWhenTheBudgetChanges', async () => {
    const { sessions } = await plannedSessions({}, { names: TWENTY_CASES })
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
    const optimizing = vi.fn(async ({ args }: EvalsProcess) => {
      await writeOptimizerRun(recordOf(args), [
        ...studyLines(0.9, { baseline: { background_tasks: true }, winner: { background_tasks: false } }),
        optimizerStop(),
        optimizerPicked('win'),
      ])
      return exit
    })
    const { workspace, sessions } = await plannedSessions({ spawnOptimizer: optimizing })
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
    let bestDiff = ''
    const optimizing = vi.fn(async ({ args }: EvalsProcess) => {
      await writeFileAt(join(root, 'instructions.md'), 'Answer in many words.\n')
      const folder = await writeOptimizerRun(recordOf(args), [
        ...studyLines(0.9),
        optimizerStop(),
        optimizerPicked('win'),
      ])
      bestDiff = join(folder, 'best.diff')
      await writeFile(bestDiff, `-${BASELINE}\n+${WINNER}\n`)
      return exit
    })
    const { workspace, sessions, notices } = await sessionsFor({ spawnOptimizer: optimizing })
    root = workspace.root
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    sessions.optimize.start()
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
    return { workspace, sessions, notices, bestDiff: (): string => bestDiff }
  }

  it('shouldNameTheEditThatCannotBeWrittenAndWhereItsTextIsWhenARunFinishes', async () => {
    const { notices, bestDiff } = await reviewWithMovedInstructions()

    await vi.waitFor(() => expect(notices.map(({ text }) => text)).toContainEqual(expect.stringContaining('finished')))
    const finished = notices.map(({ text }) => text).find((text) => text.includes('finished'))!
    expect(finished).toContain('strands dev cannot write 1 edit (instructions: ')
    expect(finished).toContain('the old text is not a plain string there')
    expect(finished).toContain(`its text is in ${bestDiff()}`)
    expect(finished).not.toContain('no edits to apply')
  })

  const firstEdit = (sessions: ReturnType<typeof evalsDevSessions>) => {
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
    const sessions = evalsDevSessions({
      workspace,
      agent: () => ({ description: 'Answers capital city questions', tools: [] }),
      context,
      dependencies: { run: environmentRunner(), spawnOptimizer: optimizingProcess() },
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
    const { optimizing, recorded } = recordingOptimizer()
    const { workspace, sessions, experiment } = await plannedSessions({ spawnOptimizer: optimizing })

    sessions.optimize.start()

    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
    const record = recordOf(optimizing.mock.calls[0]![0].args)
    const stamp = basename(dirname(record))
    expect(optimizing.mock.calls[0]![0]).toMatchObject({ detached: true })
    expect(stamp).toMatch(/^\d{8}-\d{6}$/u)
    expect(record).toBe(join(experimentHome(workspace), 'optimizations', stamp, 'optimizer'))
    expect(recorded()).toMatchObject({
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
    const continuing = vi.fn(async ({ args }: EvalsProcess) => {
      await writeOptimizerRun(recordOf(args), [...studyLines(0.9), optimizerStop(), optimizerPicked('win')], {
        baseline_id: 'base',
        validation: { champion_id: 'win' },
      })
      return exit
    })
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: continuing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    const { record, resume } = await interruptedRun(workspace, experiment)
    await writeOptimizerRun(
      record,
      finished ? [...studyLines(0.9), optimizerStop(), optimizerPicked('win')] : studyLines(0.6),
      finished ? { baseline_id: 'base', validation: { champion_id: 'win' } } : undefined
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
    const continuing = optimizingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: continuing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    await interruptedRun(workspace, experiment, { split })

    await sessions.optimize.resume()

    await vi.waitFor(() => expect(continuing).toHaveBeenCalledTimes(1))
    const args = continuing.mock.calls[0]![0].args
    const at = args.indexOf('--split')
    expect(args.slice(at, at + 2)).toEqual(flags)
  })

  it('shouldResumeAStoppedRunWithTheParallelTrialsOfTheFirstRunWhenItsFolderHoldsTheRestOfThePlan', async () => {
    const continuing = optimizingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: continuing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    const { record } = await interruptedRun(workspace, experiment, {
      width: 6,
      repetitions: 3,
      workers: 2,
    })
    await writeOptimizerRun(record, studyLines(0.6))

    await sessions.optimize.resume()

    await vi.waitFor(() => expect(continuing).toHaveBeenCalledTimes(1))
    const { args } = continuing.mock.calls[0]![0]
    expect(flagValue(args, '--max-workers')).toBe('2')
    expect(args).not.toContain('--runs-per-candidate')
    expect(args).not.toContain('--proposals-per-iteration')
  })

  it('shouldGiveTheOptimizerTheSplitAndRecordItWhenARunStartsSoThatItCanResumeWithIt', async () => {
    const { optimizing, recorded } = recordingOptimizer()
    const { sessions } = await plannedSessions({ spawnOptimizer: optimizing }, { names: TWENTY_CASES })

    sessions.optimize.start()

    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
    expect(recorded()).toMatchObject({ split: [0.5, 0.25, 0.25] })
    expect(flagValue(optimizing.mock.calls[0]![0].args, '--split')).toBe('0.5,0.25,0.25')
  })

  it('shouldGiveTheOptimizerTheBudgetOfThePlanWhenTheRunStarts', async () => {
    const optimizing = optimizingProcess()
    const { sessions } = await plannedSessions({ spawnOptimizer: optimizing })
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
    const { sessions } = await plannedSessions({ spawnOptimizer: optimizing })
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
    const { sessions } = await plannedSessions()
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
    const { sessions } = await plannedSessions({ spawnOptimizer: optimizing }, { names: TWENTY_CASES })
    sessions.optimize.setRepetitions(5)
    sessions.optimize.setWidth(8)
    sessions.optimize.setIterations(8)

    const started = sessions.optimize.start()

    const state = sessions.optimize.snapshot()
    if (state.step !== 'setup') throw new Error('the plan closed')
    expect(state.plan.rollouts).toBeGreaterThan(500)
    expect(state.plan.budgetProblem).toBe(
      `Needs about ${state.plan.rollouts} rollouts, but this run can use 500. Lower the steps, candidates, or runs, or raise --max-rollouts.`
    )
    expect(started).toBeUndefined()
    expect(optimizing).not.toHaveBeenCalled()
  })

  it('shouldStartALargerRunAndGiveTheOptimizerItsRolloutCapSplitAndPassedFlagsWhenTheCapIsRaised', async () => {
    const { optimizing, recorded } = recordingOptimizer()
    const { sessions } = await plannedSessions({ spawnOptimizer: optimizing }, { names: TWENTY_CASES })
    sessions.optimize.setRepetitions(5)
    sessions.optimize.setWidth(8)
    sessions.optimize.setIterations(8)
    sessions.optimize.setMaxRollouts(5000)
    sessions.optimize.setSplit([0.6, 0.2, 0.2])
    sessions.optimize.setSeed(-3)
    sessions.optimize.setPassed(['--rerun-passes', '1'])

    expect(sessions.optimize.start()).toBeDefined()

    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
    const { args } = optimizing.mock.calls[0]![0]
    expect(args.filter((argument) => argument === '--seed')).toHaveLength(1)
    expect(['--max-rollouts', '--split', '--seed', '--rerun-passes'].map((flag) => flagValue(args, flag))).toEqual([
      '5000',
      '0.6,0.2,0.2',
      '-3',
      '1',
    ])
    expect(recorded()).toMatchObject({ maxRollouts: 5000, passed: ['--rerun-passes', '1'] })
  })

  it('shouldChangeADecisionSettingOnlyToOneOfItsChoicesAndCountTheFinalistsInTheEstimate', async () => {
    const { sessions } = await plannedSessions()
    const before = setupPlan(sessions).rollouts

    sessions.optimize.setDecision('finalists', 5)
    sessions.optimize.setDecision('finalists', 0)
    sessions.optimize.setDecision('feasibility', 0.5)

    const plan = setupPlan(sessions)
    expect(plan.decision).toEqual({ feasibility: 0.9, crashScore: 'worst', pickRule: 'mean', finalists: 5 })
    expect(plan.rollouts).toBe(before + 2)
  })

  it('shouldCountTheParetoEndPhaseInTheEstimateWhenTheObjectiveIsAParetoFront', async () => {
    const { sessions } = await plannedSessions({}, { evaluators: ['Contains', 'Equals'] })
    const before = setupPlan(sessions).rollouts

    sessions.optimize.setObjective({
      expression: 'Pareto(Maximize(Contains), Minimize(tokens, scale=1000))',
      constraints: '',
    })

    expect(setupPlan(sessions).rollouts).toBe(before + 6)
  })

  it('shouldGiveTheOptimizerTheDecisionAndRecordItWhenTheRunStarts', async () => {
    const { optimizing, recorded } = recordingOptimizer()
    const { sessions } = await plannedSessions({ spawnOptimizer: optimizing })
    sessions.optimize.setDecision('feasibility', 0.95)
    sessions.optimize.setDecision('crashScore', 'none')

    sessions.optimize.start()

    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
    const { args } = optimizing.mock.calls[0]![0]
    expect([flagValue(args, '--feasibility-threshold'), flagValue(args, '--agent-failure-score')]).toEqual([
      '0.95',
      'none',
    ])
    expect(recorded()).toMatchObject({
      decision: { feasibility: 0.95, crashScore: 'none', pickRule: 'mean', finalists: 3 },
    })
  })

  it('shouldStartFromTheMeanOfEveryEvaluatorAndOfferPresetsAndEveryMetric', async () => {
    const { sessions } = await plannedSessions({}, { evaluators: ['Contains', 'Equals'] })
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
    const { sessions } = await plannedSessions({ spawnOptimizer: optimizing }, { evaluators: ['Contains', 'Equals'] })

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
    const { sessions } = await plannedSessions({ spawnOptimizer: optimizing }, { evaluators: ['Contains', 'Equals'] })
    if (objective) sessions.optimize.setObjective(objective)

    sessions.optimize.start()

    await vi.waitFor(() => expect(optimizing).toHaveBeenCalledTimes(1))
    expect(objectiveFlags(optimizing.mock.calls[0]![0].args)).toEqual(flags)
  })

  it('shouldRecordTheObjectiveWhenARunStartsSoThatItCanResumeWithIt', async () => {
    const { optimizing, recorded } = recordingOptimizer()
    const { sessions } = await plannedSessions({ spawnOptimizer: optimizing }, { evaluators: ['Contains', 'Equals'] })
    sessions.optimize.setObjective({ expression: 'Maximize(Contains)', constraints: 'tokens <= 4000' })

    sessions.optimize.start()

    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
    expect(recorded()).toMatchObject({ objective: { expression: 'Maximize(Contains)', constraints: 'tokens <= 4000' } })
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
    const continuing = optimizingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: continuing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'], 'capital', ['Contains', 'Equals'])
    await interruptedRun(workspace, experiment, { objective })

    await sessions.optimize.resume()

    await vi.waitFor(() => expect(continuing).toHaveBeenCalledTimes(1))
    expect(objectiveFlags(continuing.mock.calls[0]![0].args)).toEqual(flags)
  })

  it('shouldStartARunThatStoppedBeforeItsRunFolderAgainWithTheDecisionOfTheFirstRun', async () => {
    const continuing = optimizingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: continuing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'], 'capital', ['Contains', 'Equals'])
    await interruptedRun(workspace, experiment, {
      decision: { feasibility: 0.8, crashScore: 'worst', pickRule: 'mean', finalists: 1 },
    })

    await sessions.optimize.resume()

    await vi.waitFor(() => expect(continuing).toHaveBeenCalledTimes(1))
    const { args } = continuing.mock.calls[0]![0]
    expect([flagValue(args, '--feasibility-threshold'), flagValue(args, '--n-finalists')]).toEqual(['0.8', '1'])
  })

  it('shouldKeepTheRunGoingAndListItWhenTheDeveloperGoesBackToTheList', async () => {
    const gate = held()
    const optimizing = vi.fn(async ({ args }: EvalsProcess) => {
      await writeOptimizerRun(recordOf(args), studyLines(0.7))
      await gate.promise
      await writeOptimizerRun(recordOf(args), [...studyLines(0.9), optimizerStop(), optimizerPicked('win')])
      return exit
    })
    const { sessions } = await plannedSessions({ spawnOptimizer: optimizing })
    const started = sessions.optimize.start()
    await vi.waitFor(() => expect(optimizing).toHaveBeenCalledTimes(1))

    sessions.optimize.reset()
    const listed = sessions.optimize.snapshot()
    gate.resolve()

    await vi.waitFor(() => expect(sessions.optimize.snapshot().runs?.[0]?.state.step).toBe('review'))
    expect(listed).toMatchObject({
      step: 'pick',
      runs: [{ id: started, experiment: 'capital', state: { step: 'running' } }],
    })
    expect(sessions.optimize.snapshot().step).toBe('pick')
  })

  it('shouldListTheReasonAsASentenceWhenTheOptimizerStopsWithAnError', async () => {
    const failing = vi.fn(async ({ args }: EvalsProcess) => {
      await writeOptimizerRun(
        recordOf(args),
        [...studyLines(0.6), optimizerStop('proposer_error', 'a proposer raised; see the proposer_error event')],
        { baseline_id: 'base' }
      )
      return proposerStopped
    })
    const { sessions, notices } = await plannedSessions({ spawnOptimizer: failing })

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
    const failing = vi.fn(async ({ args }: EvalsProcess) => {
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
    const { sessions } = await plannedSessions({ spawnOptimizer: failing })

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

  it.each([
    ['AnEvaluatorThatAsksAModel', ['OutputEvaluator'], 1],
    ['OnlyChecksThatAskNoModel', ['Equals', 'Contains'], 0],
  ])('shouldCountTheJudgeCallsOfTheEvaluatorsWhenTheExperimentHas%s', async (_case, evaluators, perRollout) => {
    const { sessions } = await plannedSessions({}, { evaluators })
    const state = sessions.optimize.snapshot()
    if (state.step !== 'setup') throw new Error('the plan did not open')
    expect(state.plan.judgeCalls).toBe(state.plan.rollouts * perRollout)
  })

  it('shouldDropTheRecordOfARunThatFailsSoThatTheNextStartDoesNotRunItAgain', async () => {
    const failing = vi.fn(async (process: EvalsProcess) => {
      process.onSpawn?.(4242)
      await vi.waitFor(async () =>
        expect(JSON.parse(await readFile(resumeRecordOf(recordOf(process.args)), 'utf8'))).toMatchObject({
          pid: 4242,
        })
      )
      return { code: 1, stdout: '', stderrTail: ['strands-evals optimize: error: the agent file did not load'] }
    })
    const { workspace, sessions, notices } = await plannedSessions({ spawnOptimizer: failing })
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
    expect(await readEvalsOptimizeRecords(workspace.directory!)).toEqual([])
    expect(restarted.snapshot().runs).toEqual([])
    expect(failing).toHaveBeenCalledTimes(1)
  })

  it('shouldRunTwoOptimizationsAtOnceWhenTheDeveloperStartsAnotherFromTheList', async () => {
    const gates = [held(), held()]
    const optimizing = vi.fn(async ({ args }: EvalsProcess) => {
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
    expect(evalsOptimizeJobs(both).map(({ id }) => id)).toEqual([second, first])
  })

  /** Two finished runs that wait for review, with the question of the first one on screen. */
  const twoRunsToReview = async () => {
    const { workspace, sessions } = await sessionsFor({ spawnOptimizer: optimizingProcess() })
    const capital = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    const cities = await savedExperiment(workspace, ['d0', 'd1', 'd2', 'd3'], 'cities')
    sessions.optimize.plan(capital)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    const first = sessions.optimize.start()
    await vi.waitFor(() => expect(sessions.ask.pending()?.topic).toBe(first))
    const firstQuestion = sessions.ask.pending()!
    sessions.optimize.reset()
    sessions.optimize.plan(cities)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
    const second = sessions.optimize.start()
    await vi.waitFor(() =>
      expect(sessions.optimize.snapshot().runs?.map(({ state }) => state.step)).toEqual(['review', 'review'])
    )
    return { workspace, sessions, first, second, firstQuestion }
  }

  it('shouldApplyTheEditOfTheRunWhoseQuestionWasAnsweredWhenTwoRunsWaitForReview', async () => {
    const { sessions, first, second, firstQuestion } = await twoRunsToReview()

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
    const { workspace, sessions, first, second } = await twoRunsToReview()
    const optimize = devCommand(workspace, 'optimize')
    const { context } = chat()

    expect(optimize.openJob?.(context, second!)).toBe(true)

    expect(sessions.ask.pending()?.topic).toBe(second)
    expect(context.openPanel).toHaveBeenCalledWith('ask')
    sessions.ask.respond(sessions.ask.pending()!.id, { verdict: 'reject' })
    expect(sessions.ask.pending()?.topic).toBe(first)
  })

  it('shouldLeaveTheStatusLineOfARunWithNothingToReviewToTheRunsView', async () => {
    const gate = held()
    const optimizing = vi.fn(async ({ args }: EvalsProcess) => {
      await gate.promise
      await writeOptimizerRun(recordOf(args), [...studyLines(0.9), optimizerStop(), optimizerPicked('win')])
      return exit
    })
    const { workspace, sessions } = await plannedSessions({ spawnOptimizer: optimizing })
    const running = sessions.optimize.start()
    await vi.waitFor(() => expect(optimizing).toHaveBeenCalledOnce())
    const optimize = devCommand(workspace, 'optimize')
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

    expect(evalsOptimizeJobs(state(false) as never)).toHaveLength(1)
    expect(evalsOptimizeJobs(state(true) as never)).toEqual([])
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

    const mixed = evalsOptimizeJobs(state([edit, { ...edit, unavailable: 'set in code' }]) as never)
    const none = evalsOptimizeJobs(state([{ ...edit, unavailable: 'set in code' }]) as never)

    expect(mixed.map(({ label, waiting }) => [label, waiting])).toEqual([['r1 · 1 to review', true]])
    expect(none).toEqual([])
  })

  it('shouldShowTheTestCheckWithItsConfidenceRangeWhenTheRunReportsOne', async () => {
    const tested = vi.fn(async ({ args }: EvalsProcess) => {
      await writeOptimizerRun(recordOf(args), [
        ...studyLines(0.9),
        optimizerStop(),
        optimizerPicked('win'),
        optimizerTested('win', 'base', 0.4, 5, [0.1, 0.7]),
      ])
      return exit
    })
    const { sessions } = await plannedSessions({ spawnOptimizer: tested })

    sessions.optimize.start()

    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
    expect(sessions.optimize.snapshot()).toMatchObject({
      review: { testCheck: { difference: 0.4, cases: 5, confidence: 0.9, range: [0.1, 0.7] } },
    })
  })

  it('shouldShowTheEditsOnScreenWhenARunFinishesRatherThanOnlySayingSoInTheChat', async () => {
    const { sessions } = await reviewOnScreen()

    const question = sessions.ask.pending()!
    expect(question.fields.map(({ kind }) => kind)).toEqual(['select', 'diff'])
    expect(question.fields[1]).toMatchObject({ kind: 'diff', path: expect.any(String) })
  })

  it('shouldApplyOnlyWhatTheDeveloperAcceptsInThatQuestion', async () => {
    const { sessions } = await reviewOnScreen()

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
      const optimizing = vi.fn(async ({ args }: EvalsProcess) => {
        await writeOptimizerRun(recordOf(args), [
          ...studyLines(0.9, { baseline: { effort: 'low' }, winner: { effort: 'high' } }),
          optimizerStop(),
          optimizerPicked('win'),
        ])
        return exit
      })
      const { workspace, sessions } = await plannedSessions({ spawnOptimizer: optimizing })
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
      const ask = devCommand(workspace, 'ask')
      expect(ask.screenContext?.()).toBe(context)
    })

    it('shouldSayNothingOfADiffWhenAQuestionOfTheAgentIsInFrontOfIt', async () => {
      const { sessions } = await twoEditsOnScreen()

      void sessions.ask.ask({
        name: 'experiment',
        question: 'Which experiment?',
        fields: [{ kind: 'number', key: 'answer', label: 'answer' }],
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
      expect(evalsOptimizeJobs(sessions.optimize.snapshot())).toEqual([])
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
      const answers = (sessions: ReturnType<typeof evalsDevSessions>): string[] => {
        const state = sessions.optimize.snapshot()
        const edits = state.step === 'review' ? state.review.edits : []
        return edits.map(
          ({ knob, accepted, decided }) => `${knob}: ${!decided ? 'waiting' : accepted ? 'apply' : 'leave'}`
        )
      }
      const onScreen = (sessions: ReturnType<typeof evalsDevSessions>, verdict: 'accept' | 'reject' | undefined) =>
        sessions.ask.respond(sessions.ask.pending()!.id, verdict ? { verdict } : undefined)
      const effortOnScreen = (sessions: ReturnType<typeof evalsDevSessions>) =>
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
    const { sessions } = await reviewOnScreen()
    const question = sessions.ask.pending()!

    expect(sessions.ask.dropForTurn()).toBe(false)

    expect(sessions.ask.pending()).toBe(question)
    expect(evalsOptimizeJobs(sessions.optimize.snapshot()).map(({ label }) => label)).toEqual([
      expect.stringContaining('1 to review'),
    ])
  })

  const closedOnAReview = async (optimizing = optimizingProcess()) => {
    const { workspace, sessions, run } = await reviewOnScreen(optimizing)
    const record = recordOf(optimizing.mock.calls[0]![0].args)
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(resumeRecordOf(record), 'utf8'))).toMatchObject({ awaitsReview: true })
    )
    return { workspace, sessions, run, record }
  }

  const reopened = (workspace: DevWorkspace, settings: Pick<EvalsSessionHost, 'settings'> = {}) => {
    const { context, notices } = chat()
    const again = vi.fn()
    const host = (): EvalsSessionHost => ({
      workspace,
      agent: () => ({}),
      context,
      dependencies: { run: environmentRunner(), spawnOptimizer: again },
      ...settings,
    })
    const optimize = new EvalsOptimize(host, new EvalsExperiments(host))
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
    expect(evalsOptimizeJobs(optimize.snapshot()).map(({ label }) => label)).toEqual([
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
    const optimizing = vi.fn(async ({ args }: EvalsProcess) => {
      await writeOptimizerRun(recordOf(args), [...studyLines(0.9), optimizerStop(), optimizerPicked('win')], {
        baseline_id: 'base',
        validation: { champion_id: 'win' },
      })
      return exit
    })
    const { workspace, sessions } = await plannedSessions({ spawnOptimizer: optimizing })
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
    expect(evalsOptimizeJobs(optimize.snapshot())).toEqual([])
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

    expect(evalsOptimizeJobs(optimize.snapshot())).toEqual([])
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
    expect(evalsOptimizeJobs(sessions.optimize.snapshot())).toEqual([])
    await vi.waitFor(() => expect(existsSync(resumeRecordOf(record))).toBe(false))
  })

  it('shouldKeepTheRunWaitingWhenTheDeveloperClosesItsQuestionWithoutAnAnswer', async () => {
    const { workspace, sessions, run, record } = await closedOnAReview()
    const optimize = devCommand(workspace, 'optimize')
    const { context } = chat()

    sessions.ask.respond(sessions.ask.pending()!.id, undefined)
    await new Promise((done) => setTimeout(done, 20))

    expect(sessions.ask.pending()).toBeUndefined()
    expect(evalsOptimizeJobs(sessions.optimize.snapshot()).map(({ label }) => label)).toEqual([
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
    expect(evalsOptimizeJobs(sessions.optimize.snapshot())).toEqual([])
  })

  it('shouldWriteNothingUntilEveryEditHasAnAnswerAndCarryOnWhereTheDeveloperLeftOff', async () => {
    const optimizing = vi.fn(async ({ args }: EvalsProcess) => {
      await writeOptimizerRun(recordOf(args), [
        ...studyLines(0.9, { baseline: { effort: 'low' }, winner: { effort: 'high' } }),
        optimizerStop(),
        optimizerPicked('win'),
      ])
      return exit
    })
    const { workspace, sessions, notices } = await plannedSessions({ spawnOptimizer: optimizing })
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
    expect(evalsOptimizeJobs(sessions.optimize.snapshot()).map(({ label }) => label)).toEqual([
      expect.stringContaining('1 to review'),
    ])
    expect(notices.at(-1)).toEqual({
      status: 'success',
      text: `optimize · run ${optimizationName(record)} · 1 of 2 edits answered · nothing is written until all are · ↓ Enter`,
    })

    const optimize = devCommand(workspace, 'optimize')
    expect(optimize.openJob?.(chat().context, run)).toBe(true)
    expect(asking()).toEqual(['edit 2 of 2', 'Apply this change to effort?'])
    sessions.ask.respond(sessions.ask.pending()!.id, { verdict: 'reject' })

    await vi.waitFor(() =>
      expect(sessions.optimize.snapshot()).toMatchObject({ review: { applied: ['instructions.md'], reviewed: true } })
    )
    expect(await readFile(join(workspace.root, 'instructions.md'), 'utf8')).toBe(`${WINNER}\n`)
    expect(await readFile(workspace.entrypoint, 'utf8')).toContain('effort="low"')
    expect(evalsOptimizeJobs(sessions.optimize.snapshot())).toEqual([])
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
    const { sessions } = await reviewOnScreen()

    sessions.ask.respond(sessions.ask.pending()!.id, { verdict: 'accept' })

    await vi.waitFor(() =>
      expect(sessions.optimize.snapshot()).toMatchObject({ review: { applied: ['instructions.md'], reviewed: true } })
    )
    expect(evalsOptimizeJobs(sessions.optimize.snapshot())).toEqual([])
  })

  it('shouldSayWhatWasAppliedAgainInTheChatThatTheReloadOpens', async () => {
    const { workspace, sessions } = await reviewOnScreen()
    sessions.ask.respond(sessions.ask.pending()!.id, { verdict: 'accept' })
    await vi.waitFor(() =>
      expect(sessions.optimize.snapshot()).toMatchObject({ review: { applied: ['instructions.md'] } })
    )
    const optimize = devCommand(workspace, 'optimize')
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
    const { sessions } = await reviewOnScreen()
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
    const { workspace, sessions } = await plannedSessions({ spawnOptimizer: optimizing })
    sessions.optimize.start()
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
    const before = sessions.optimize.appliedChanges()

    sessions.optimize.apply()
    await vi.waitFor(() =>
      expect(sessions.optimize.snapshot()).toMatchObject({ review: { applied: ['instructions.md'] } })
    )
    const reloaded = evalsDevChatPart(
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
    const optimizing = vi.fn(async ({ args }: EvalsProcess) => {
      await begin.promise
      await writeOptimizerRun(recordOf(args), searched)
      await end.promise
      await writeOptimizerRun(recordOf(args), [...searched, optimizerPicked('win')])
      return exit
    })
    const { sessions } = await plannedSessions({ spawnOptimizer: optimizing })
    const plan = setupPlan(sessions)
    const job = (): object | undefined => evalsOptimizeJobs(sessions.optimize.snapshot())[0]

    sessions.optimize.start()
    await vi.waitFor(() => expect(optimizing).toHaveBeenCalledOnce())
    const starting = job()
    begin.resolve()

    // The search stopped with both versions measured, which the count of versions would call done.
    const afterSearch = plan.split.validation * (plan.decision.finalists + 1) + plan.split.test * 2
    await vi.waitFor(() => expect(job()).toMatchObject({ done: 2, total: 2 + afterSearch }), { timeout: 5000 })
    expect(starting).toMatchObject({ done: 0, total: plan.rollouts })
    expect(afterSearch).toBeGreaterThan(0)
    end.resolve()
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('review'))
  })

  it('shouldKeepTheBestSoFarWhenTheUserStopsTheRun', async () => {
    const stopped = vi.fn(async ({ args, signal }: EvalsProcess) => {
      await writeOptimizerRun(recordOf(args), studyLines(0.8))
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
      return { code: 143, stdout: '', stderrTail: ['terminated'] }
    })
    const { workspace, sessions } = await plannedSessions({ spawnOptimizer: stopped })
    sessions.optimize.start()
    await vi.waitFor(() => expect(stopped).toHaveBeenCalled())
    await vi.waitFor(
      () => expect(sessions.optimize.snapshot()).toMatchObject({ step: 'running', progress: { best: 0.8 } }),
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
    const everyFive: Pick<EvalsSessionHost, 'settings'> = {
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
      const optimize = evalsDevCommands(
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

      expect(before).toBe(0)
      expect(order).toEqual(['agent', 'optimizer'])
      expect(recordOf(optimizer.mock.calls[0]![0].args)).toContain(join('experiments', 'history-20261123-1502'))
      // The chat is told of the work in one notice, and of the run's end.
      await vi.waitFor(() =>
        expect(notices.map(({ text }) => text).filter((text) => text.startsWith('auto-optimize'))).toEqual([
          'auto-optimize · made history-20261123-1502 from your chats (4 cases) · optimizing on it in the background',
        ])
      )
    })

    it('shouldWaitUntilTheEditsOfAFinishedRunHaveTheirAnswer', async () => {
      const { sessions } = await reviewOnScreen(optimizingProcess(), everyFive)
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

      await vi.waitFor(() => expect(reached).toEqual(['waited', 'idle']))
    })

    it('shouldChangeASettingThroughTheChatThatIsOpenAndSayWhenItCannot', async () => {
      const { workspace, sessions } = await sessionsFor()
      const unsaved = sessions.setSettings({ autoOptimize: 20 })
      await expect(unsaved).rejects.toThrow('No chat is open to change the settings through.')
      const setSettings = vi.fn(async () => true)
      evalsDevSessions({ workspace, agent: () => ({}), context: { ...chat().context, setSettings } })

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
    const accepting = (on: () => boolean = () => true): Pick<EvalsSessionHost, 'settings'> => ({
      settings: () => ({ autoAcceptOptimizationResults: on(), autoOptimize: 0 }),
    })

    const planned = async (
      optimizing: NonNullable<EvalsSessionDependencies['spawnOptimizer']>,
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
      const optimizing = vi.fn(async (process: EvalsProcess) => {
        await end.promise
        return finishing(process)
      })
      return { end, optimizing }
    }

    it('shouldTakeTheSettingFromTheChatThatOpensTheWorkspaceAsItIsNow', async () => {
      let on = false
      const { workspace, sessions } = await sessionsFor()
      const project = { root: workspace.root, entrypoint: workspace.entrypoint, language: 'python' as const }
      const commands = evalsDevCommands(workspace, project, () => ({}), accepting(() => on).settings)
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
        waited.push(evalsOptimizeJobs(sessions.optimize.snapshot()).some(({ waiting }) => waiting === true))
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
      expect(evalsOptimizeJobs(sessions.optimize.snapshot())).toEqual([])
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
      const optimize = devCommand(workspace, 'optimize')
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
      const stopped = vi.fn(async ({ args, signal }: EvalsProcess) => {
        await writeOptimizerRun(recordOf(args), studyLines(0.8))
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
        return { code: 143, stdout: '', stderrTail: ['terminated'] }
      })
      const { workspace, sessions, notices } = await planned(stopped)
      sessions.optimize.start()
      await vi.waitFor(
        () => expect(sessions.optimize.snapshot()).toMatchObject({ step: 'running', progress: { best: 0.8 } }),
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
      expect(evalsOptimizeJobs(optimize.snapshot()).map(({ label }) => label)).toEqual([
        expect.stringContaining('1 to review'),
      ])
      expect(notices).toContainEqual({
        status: 'success',
        text: `optimize · run ${optimizationName(record)} · 1 edit still to review · ↓ Enter`,
      })
      expect(await instructionsOf(workspace)).toBe(`${BASELINE}\n`)
    })

    it('shouldWriteTheEditsOfARunThatFinishedWhileStrandsDevWasClosedWhenItOpensAgain', async () => {
      const withResult = vi.fn(async ({ args }: EvalsProcess) => {
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
    const neverScored = vi.fn(async ({ signal }: EvalsProcess) => {
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
      return { code: 143, stdout: '', stderrTail: ['terminated'] }
    })
    const { sessions, notices, experiment } = await plannedSessions({ spawnOptimizer: neverScored })
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

  it.skipIf(!existsSync(pythonExecutable))(
    'shouldKeepTheReviewAndNameTheChangedFileWhenAnApplyStopsHalfway',
    async () => {
      const optimizing = vi.fn(async ({ args }: EvalsProcess) => {
        await writeOptimizerRun(recordOf(args), [
          ...studyLines(0.9, { baseline: { effort: 'low' }, winner: { effort: 'high' } }),
          optimizerStop(),
          optimizerPicked('win'),
        ])
        return exit
      })
      // The plan reads the agent with the project's Python, so the real interpreter is in place before the plan.
      const { workspace, sessions, notices } = await sessionsFor({ spawnOptimizer: optimizing })
      const projectPython = evalsVenvPython(join(workspace.root, '.venv'))
      await rm(projectPython)
      await symlink(pythonExecutable, projectPython)
      sessions.optimize.plan(await savedExperiment(workspace, CASES))
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

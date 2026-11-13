import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { ExperimentSummary } from '../../../src/dev/panels/model.js'
import { temporaryVenvPython, type TemporaryCommandRequest } from '../../../src/dev/temporary-evals-fork/environment.js'
import type { TemporaryEvalsProcess } from '../../../src/dev/temporary-evals-fork/evals-process.js'
import type { TemporarySessionDependencies } from '../../../src/dev/temporary-evals-fork/host.js'
import { TemporaryExperiments } from '../../../src/dev/temporary-evals-fork/experiments-session.js'
import { readTemporaryTestResults, rememberTemporaryTestResults } from '../../../src/dev/temporary-evals-fork/report.js'
import type { TemporarySessionHost } from '../../../src/dev/temporary-evals-fork/host.js'
import {
  TemporaryTest,
  temporaryDevSessions,
  temporaryTestJobs,
} from '../../../src/dev/temporary-evals-fork/sessions.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import type { ChatNotice, DevChatCommandContext } from '../../../src/ui/chat/types.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

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

const experimentDocument = (names: readonly string[]) => ({
  cases: names.map((name) => ({
    name,
    session_id: `session-${name}`,
    input: `question ${name}`,
    expected_output: `answer ${name}`,
    metadata: null,
  })),
  evaluators: [{ evaluator_type: 'OutputEvaluator' }],
})

const flagValue = (args: readonly string[], flag: string): string => args[args.indexOf(flag) + 1]!

const exit = { code: 0, stdout: '', stderrTail: [] }

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

const studyLines = (best: number): string[] => [
  JSON.stringify({
    type: 'study',
    cases: ['c0', 'c1'],
    validation: ['c2'],
    test: ['c3'],
    width: 4,
    repetitions: 1,
    objectives: [{ kind: 'Maximize', metric: 'OutputEvaluator', weight: 1 }],
  }),
  JSON.stringify({ type: 'run', iterations: 1, patience: null }),
  JSON.stringify({
    type: 'candidate',
    number: 0,
    role: 'baseline',
    params: { instructions: BASELINE },
    status: 'complete',
    estimates: { OutputEvaluator: { mean: 0.5, ci: [0.4, 0.6], n: 2 } },
    best_after: [0],
  }),
  JSON.stringify({
    type: 'candidate',
    number: 1,
    role: 'step',
    step: 1,
    params: { instructions: WINNER },
    status: 'complete',
    estimates: { OutputEvaluator: { mean: best, ci: [best - 0.1, best + 0.1], n: 2 } },
    best_after: [1],
  }),
]

const optimizingProcess = () =>
  vi.fn(async ({ args }: TemporaryEvalsProcess) => {
    const record = flagValue(args, '--record')
    await writeFileAt(
      join(record, 'study.jsonl'),
      [
        ...studyLines(0.9),
        JSON.stringify({ type: 'selected', best: [1] }),
        JSON.stringify({ type: 'finished', best: [1], reason: 'candidates' }),
        '',
      ].join('\n')
    )
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
  name = 'capital'
): Promise<ExperimentSummary> => {
  const path = join(workspace.directory!, `tmp/experiments/${name}.json`)
  await writeFileAt(path, JSON.stringify(experimentDocument(names)))
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
      ['effort', false],
      ['tools', false],
    ])
    expect(after.plan.iterations).toBe(2)
    expect(after.plan.rollouts).toBeLessThan(before.plan.rollouts)
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
    expect(optimizing.mock.calls.at(-1)![0].args).toEqual(expect.arrayContaining(['--tune', 'instructions']))
  })

  it('shouldKeepTheBestSoFarWhenTheUserStopsTheRun', async () => {
    const stopped = vi.fn(async ({ args, signal }: TemporaryEvalsProcess) => {
      await writeFileAt(join(flagValue(args, '--record'), 'study.jsonl'), [...studyLines(0.8), ''].join('\n'))
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
    expect(JSON.stringify(sessions.optimize.snapshot())).not.toContain('study.jsonl')
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

  it('shouldKeepTheReviewAndNameTheChangedFileWhenAnApplyStopsHalfway', async () => {
    const optimizing = vi.fn(async ({ args }: TemporaryEvalsProcess) => {
      const lines = studyLines(0.9).map((line) => {
        const event = JSON.parse(line) as { type: string; number?: number; params?: Record<string, string> }
        if (event.type !== 'candidate') return line
        return JSON.stringify({
          ...event,
          params: { ...event.params, effort: event.number === 0 ? 'low' : 'high' },
        })
      })
      await writeFileAt(
        join(flagValue(args, '--record'), 'study.jsonl'),
        [...lines, JSON.stringify({ type: 'finished', best: [1], reason: 'candidates' }), ''].join('\n')
      )
      return exit
    })
    const { workspace, sessions, notices } = await sessionsFor({ spawnOptimizer: optimizing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.optimize.plan(experiment)
    await vi.waitFor(() => expect(sessions.optimize.snapshot().step).toBe('setup'))
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
    expect(notices.at(-1)).toMatchObject({ status: 'error', text: expect.stringContaining('applied instructions.md') })
  })
})

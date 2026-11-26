import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ExperimentSummary } from '../../../../src/dev/evals/model.js'
import {
  readEvalsRunRecords,
  saveEvalsRunRecord,
  type EvaluationRecord,
} from '../../../../src/dev/evals/runs/background-runs.js'
import type { EvalsExit, EvalsProcess } from '../../../../src/dev/evals/runs/evals-process.js'
import type { EvalsSessionDependencies } from '../../../../src/dev/evals/host.js'
import { EvalsExperiments } from '../../../../src/dev/evals/sessions/experiments-session.js'
import { readEvaluationResults, rememberEvaluationResults } from '../../../../src/dev/evals/runs/evaluate.js'
import { EvalsEvaluate, evalsEvaluateJobs } from '../../../../src/dev/evals/sessions/evaluate-session.js'
import { evalsDevSessions } from '../../../../src/dev/evals/sessions/sessions.js'
import type { DevWorkspace } from '../../../../src/dev/workspace.js'
import { environmentRunner, writeFileAt } from '../../../fixtures/optimizer-run.js'
import {
  exit,
  experimentDocument,
  experimentFile,
  experimentHome,
  finished,
  flagValue,
  held,
  restartedHost,
  savedExperiment,
  sessionsFor,
  workspaceFixture,
} from '../../../fixtures/evals-sessions.js'

const testingProcess = (failingByRun: readonly (readonly string[])[] = [['c1']]) => {
  let runs = 0
  return vi.fn(async ({ args }: EvalsProcess) => {
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

const RECORD_WAIT_MS = 10_000

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

// The chat reruns the failed cases by passing their names to strands-evals run --case.
const rerunFailed = (sessions: ReturnType<typeof evalsDevSessions>, path: string): void => {
  const entry = sessions.evaluate.snapshot().runs.find(({ experiment }) => experiment.path === path)!
  if (entry.run.status !== 'done') throw new Error('expected a finished run')
  sessions.evaluate.runOnly(
    entry.experiment,
    entry.run.results.cases.filter(({ passed }) => !passed).map(({ name }) => name)
  )
}

const runStatus = (sessions: ReturnType<typeof evalsDevSessions>, path: string) =>
  sessions.evaluate.snapshot().runs.find(({ experiment }) => experiment.path === path)?.run.status

const restartedTest = (workspace: DevWorkspace, dependencies?: Partial<EvalsSessionDependencies>): EvalsEvaluate => {
  const host = restartedHost(workspace, dependencies)
  return new EvalsEvaluate(host, new EvalsExperiments(host))
}

const remembered = async (
  sessions: ReturnType<typeof evalsDevSessions>,
  workspace: DevWorkspace,
  experiment: ExperimentSummary
): Promise<void> =>
  vi.waitFor(() => {
    expect(runStatus(sessions, experiment.path)).toBe('done')
    expect(existsSync(join(experimentHome(workspace, experiment.name), '.state/latest.json'))).toBe(true)
  })

const strictTestingProcess = (failing: ReadonlySet<string>) =>
  vi.fn(async ({ args }: EvalsProcess) => {
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
): Promise<EvaluationRecord> => {
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
  await saveEvalsRunRecord(record)
  return record
}

const finishRun = (record: EvaluationRecord, failing: readonly string[] = ['c1']): Promise<EvalsExit> =>
  testingProcess([failing])({
    command: 'python',
    args: ['-m', 'strands_evals.cli', 'run', record.cases, '--output', record.report, '--data-store', record.store],
    cwd: dirname(record.report),
    env: {},
    onLine: () => undefined,
  })

describe('evaluation session', () => {
  it('shouldShowTheFailedCaseAndPostANoticeWhenATestRunFinishes', async () => {
    const { workspace, sessions, notices } = await sessionsFor({ spawnEvaluation: testingProcess() })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2'])

    sessions.evaluate.run([experiment])
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
    const { workspace, sessions, notices } = await sessionsFor({ spawnEvaluation: crashing })
    const experiment = await savedExperiment(workspace, ['c0'])
    sessions.evaluate.run([experiment, { name: 'gone', path: join(workspace.root, 'gone.json'), caseCount: 1 }])

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
    const spawnEvaluation = vi.fn(
      ({ signal }: EvalsProcess) =>
        new Promise<EvalsExit>((resolve) =>
          signal?.addEventListener('abort', () => resolve({ code: 143, stdout: '', stderrTail: [] }), { once: true })
        )
    )
    const { workspace, sessions, notices } = await sessionsFor({ spawnEvaluation })
    const experiment = await savedExperiment(workspace, ['c0', 'c1'])
    sessions.evaluate.run([experiment])
    await vi.waitFor(() => expect(spawnEvaluation).toHaveBeenCalledTimes(1))

    sessions.evaluate.stop(experiment.path)

    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('failed'))
    const run = sessions.evaluate.snapshot().runs.find((entry) => entry.experiment.path === experiment.path)?.run
    expect(run).toEqual({ status: 'failed', message: 'You stopped the run.' })
    expect(notices).toEqual([])
  })

  it('shouldRerunOnlyTheFailedCasesWhenAsked', async () => {
    const testing = testingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnEvaluation: testing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2'])
    sessions.evaluate.run([experiment])
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
    const { workspace, sessions, notices } = await sessionsFor({ spawnEvaluation: testing })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'])
    sessions.evaluate.run([experiment])
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
    const spawnEvaluation = vi.fn(async (process: EvalsProcess) => {
      if (spawnEvaluation.mock.calls.length > 1) await gate.promise
      return testing(process)
    })
    const { workspace, sessions } = await sessionsFor({ spawnEvaluation })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])
    sessions.evaluate.run([experiment])
    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('done'))

    rerunFailed(sessions, experiment.path)
    await vi.waitFor(() => expect(spawnEvaluation).toHaveBeenCalledTimes(2))
    const rerunning = evalsEvaluateJobs(sessions.evaluate.snapshot())
    const recorded = await readEvalsRunRecords(workspace.directory!)
    gate.resolve()

    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('done'))
    expect(rerunning.map(({ label, total }) => [label, total])).toEqual([['capital', 2]])
    expect(recorded).toEqual([expect.objectContaining({ experiment: experiment.path, only: ['c1', 'c2'] })])
    expect(finished(sessions, experiment.path).cases).toHaveLength(4)
  })
})

describe('evaluation session on open', () => {
  it('shouldWaitForAChoiceWhenTheTestPanelOpensWithOneExperiment', async () => {
    const tests = testingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnEvaluation: tests })
    await savedExperiment(workspace, ['c0', 'c1', 'c2', 'c3'])

    sessions.evaluate.show()

    expect(await sessions.experiments.reload()).toHaveLength(1)
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
      (process: EvalsProcess): Promise<EvalsExit> =>
        new Promise((resolve) => {
          process.signal?.addEventListener('abort', () => resolve({ code: 143, stdout: '', stderrTail: [] }), {
            once: true,
          })
          void gate.then(() => (process.signal?.aborted ? undefined : resolve(testing(process))))
        })
    )
    const { workspace, sessions } = await sessionsFor({ spawnEvaluation: held })
    const capital = await savedExperiment(workspace, ['c0', 'c1'])
    const cities = await savedExperiment(workspace, ['c0', 'c1', 'c2'], 'cities')

    sessions.evaluate.run([capital, cities])
    await vi.waitFor(() => expect(held).toHaveBeenCalledTimes(2))
    const jobs = evalsEvaluateJobs(sessions.evaluate.snapshot())
    // Each experiment is its own run, so stopping one leaves the other running.
    sessions.evaluate.stop(capital.path)
    await vi.waitFor(() => expect(runStatus(sessions, capital.path)).toBe('failed'))
    expect(runStatus(sessions, cities.path)).toBe('running')
    release()
    await vi.waitFor(() => expect(runStatus(sessions, cities.path)).toBe('done'))

    expect(jobs.map(({ label }) => label).sort()).toEqual(['capital', 'cities'])
    expect(finished(sessions, cities.path).cases).toHaveLength(3)
  })

  it('shouldStartOneRunWhenTheSameExperimentIsPickedTwiceQuickly', async () => {
    const testing = testingProcess()
    const { workspace, sessions } = await sessionsFor({ spawnEvaluation: testing })
    const experiment = await savedExperiment(workspace, ['c0'])

    sessions.evaluate.run([experiment])
    sessions.evaluate.run([experiment])
    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('done'))

    expect(testing).toHaveBeenCalledTimes(1)
  })

  it('shouldKeepTheOriginalNamesWhenItRerunsFailedCasesThatHaveNoNames', async () => {
    const failing = new Set(['question q1', 'question q3'])
    const testing = vi.fn(async ({ args }: EvalsProcess) => {
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
    const { workspace, sessions } = await sessionsFor({ spawnEvaluation: testing })
    const path = experimentFile(workspace, 'plain')
    await writeFileAt(
      path,
      JSON.stringify({
        cases: [0, 1, 2, 3, 4].map((index) => ({ input: `question q${index}`, expected_output: 'y' })),
        evaluators: [{ evaluator_type: 'OutputEvaluator' }],
      })
    )
    sessions.evaluate.run([{ name: 'plain', path, caseCount: 5 }])
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
    const { workspace, sessions } = await sessionsFor({ spawnEvaluation: testingProcess() })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2'])
    sessions.evaluate.run([experiment])
    await remembered(sessions, workspace, experiment)
    const restarted = restartedTest(workspace)

    await restarted.show()

    expect(restarted.snapshot().runs).toEqual([
      { experiment, run: { status: 'done', results: finished(sessions, experiment.path) } },
    ])
    expect(finished(sessions, experiment.path).report).toBe(join(experimentHome(workspace), 'capital.report.json'))
  })

  it('shouldShowWhyTheLastReportCannotBeReadWhenTheTestPanelOpensAfterARestart', async () => {
    const { workspace, sessions } = await sessionsFor({ spawnEvaluation: testingProcess() })
    const experiment = await savedExperiment(workspace, ['c0'])
    sessions.evaluate.run([experiment])
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
    await rememberEvaluationResults(
      experimentHome(workspace),
      await readEvaluationResults(earlier, { experiment: experiment.name, seconds: 1 })
    )
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const testing = testingProcess()
    const held = vi.fn(async (process: EvalsProcess) => {
      await gate
      return testing(process)
    })
    const restarted = restartedTest(workspace, { run: environmentRunner(), spawnEvaluation: held })
    await restarted.show()
    restarted.run([experiment])
    await vi.waitFor(() => expect(held).toHaveBeenCalled())

    await restarted.show()

    expect(restarted.snapshot().runs.map(({ run }) => run.status)).toEqual(['running'])
    release()
    await vi.waitFor(() => expect(restarted.snapshot().runs.map(({ run }) => run.status)).toEqual(['done']))
  })

  it('shouldKeepTheResultsAndWarnWhenTheLastReportCannotBeSaved', async () => {
    const { workspace, sessions, notices } = await sessionsFor({ spawnEvaluation: testingProcess() })
    const experiment = await savedExperiment(workspace, ['c0', 'c1'])
    await writeFileAt(join(experimentHome(workspace), '.state'), 'a file where the folder goes')

    sessions.evaluate.run([experiment])

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
    const { workspace, sessions } = await sessionsFor({ spawnEvaluation: testing })
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
    sessions.evaluate.run([{ name: 'starter', path, caseCount: 2 }])
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
})

describe('/evaluate runs after strands dev closes', () => {
  it('shouldResumeARunThatEndedWhenStrandsDevClosedWithTheCasesItAlreadyFinished', async () => {
    const testing = testingProcess()
    let cutAtResume: boolean | undefined
    let record: EvaluationRecord | undefined
    const spawnEvaluation = vi.fn(async (request: EvalsProcess) => {
      cutAtResume = existsSync(join(record!.store, 'c1.json'))
      return testing(request)
    })
    const { workspace, sessions, notices } = await sessionsFor({ spawnEvaluation })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2'])
    record = await recordFor(workspace, experiment, await deadProcessId())
    await writeFileAt(join(record.store, 'c0.json'), '{"output": "Paris"}')
    await writeFileAt(join(record.store, 'c1.json'), '{"outp')

    await Promise.all([sessions.evaluate.resume(), sessions.evaluate.resume()])

    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('done'))
    expect(spawnEvaluation).toHaveBeenCalledTimes(1)
    const [{ args, detached }] = spawnEvaluation.mock.calls[0]!
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
    await vi.waitFor(async () => expect(await readEvalsRunRecords(workspace.directory!)).toEqual([]))
  })

  it('shouldShowTheResultsOfARunThatFinishedWhileStrandsDevWasClosed', async () => {
    const spawnEvaluation = vi.fn()
    const { workspace, sessions, notices } = await sessionsFor({ spawnEvaluation })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2'])
    const record = await recordFor(workspace, experiment, await deadProcessId())
    await finishRun(record)

    await sessions.evaluate.resume()

    expect(runStatus(sessions, experiment.path)).toBe('done')
    expect(spawnEvaluation).not.toHaveBeenCalled()
    expect(notices.at(-1)).toEqual({
      status: 'success',
      text: `evaluate · capital · 2 of 3 cases passed · report in ${join(experimentHome(workspace), 'capital.report.json')}`,
    })
    expect(await readEvalsRunRecords(workspace.directory!)).toEqual([])
  })

  it('shouldMergeARerunThatFinishedWhileStrandsDevWasClosedIntoTheFullResult', async () => {
    const { workspace, sessions, notices } = await sessionsFor({ spawnEvaluation: testingProcess() })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2'])
    sessions.evaluate.run([experiment])
    await remembered(sessions, workspace, experiment)
    const cases = join(testRunOf(workspace), '.state/experiment.json')
    await writeFileAt(cases, JSON.stringify(experimentDocument(['c1'])))
    const record = {
      ...(await recordFor(workspace, experiment, await deadProcessId())),
      cases,
      rerun: true,
      only: ['c1'],
    }
    await saveEvalsRunRecord(record)
    await finishRun(record, [])

    await sessions.evaluate.resume()

    expect(finished(sessions, experiment.path).cases.map(({ name, passed }) => [name, passed])).toEqual([
      ['c0', true],
      ['c1', true],
      ['c2', true],
    ])
    expect(notices.at(-1)).toEqual({
      status: 'success',
      text: `evaluate · capital · 1 of 1 rerun case passed · 3 of 3 cases passed · report in ${join(experimentHome(workspace), 'capital.report.json')}`,
    })
    expect(await readEvalsRunRecords(workspace.directory!)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('shouldFollowARunThatIsStillGoingAndShowItsResultsWhenItEnds', async () => {
    const spawnEvaluation = vi.fn()
    const { workspace, sessions } = await sessionsFor({ spawnEvaluation })
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2'])
    const report = join(testRunOf(workspace), 'report.json')
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', report], { stdio: 'ignore' })
    await once(live, 'spawn')
    const record = await recordFor(workspace, experiment, live.pid)

    void sessions.evaluate.resume()
    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('running'))
    await finishRun(record)
    live.kill()

    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('done'), { timeout: 10_000 })
    expect(spawnEvaluation).not.toHaveBeenCalled()
    await vi.waitFor(async () => expect(await readEvalsRunRecords(workspace.directory!)).toEqual([]))
  })

  it('shouldRecordTheProcessOfARunWhileItGoesAndForgetItWhenTheRunEnds', { timeout: 3 * RECORD_WAIT_MS }, async () => {
    const testing = testingProcess()
    let directory = ''
    const spawnEvaluation = vi.fn(async (request: EvalsProcess) => {
      request.onSpawn?.(4242)
      await vi.waitFor(async () => expect((await readEvalsRunRecords(directory))[0]?.pid).toBe(4242), {
        timeout: RECORD_WAIT_MS,
      })
      return testing(request)
    })
    const { workspace, sessions } = await sessionsFor({ spawnEvaluation })
    directory = workspace.directory!
    const experiment = await savedExperiment(workspace, ['c0', 'c1', 'c2'])

    sessions.evaluate.run([experiment])

    await vi.waitFor(() => expect(runStatus(sessions, experiment.path)).toBe('done'), { timeout: RECORD_WAIT_MS })
    await vi.waitFor(async () => expect(await readEvalsRunRecords(directory)).toEqual([]))
  })
})
